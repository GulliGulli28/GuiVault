//! Lignes SQL et requêtes partagées entre plusieurs routes. Les routes qui
//! n'ont qu'un seul consommateur gardent leurs requêtes chez elles.
use crate::error::AppError;
use chrono::{DateTime, Utc};
use guivault_protocol::{Invitation, InvitationStatus, Item, ItemVersion, Role, UserProfile, Vault, VaultKind};
use sqlx::{PgConnection, PgExecutor};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub email: String,
    pub public_key: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

impl From<UserRow> for UserProfile {
    fn from(r: UserRow) -> Self {
        UserProfile {
            id: r.id,
            email: r.email,
            public_key: r.public_key,
            created_at: r.created_at,
        }
    }
}

pub async fn user_by_id<'e>(db: impl PgExecutor<'e>, id: Uuid) -> sqlx::Result<Option<UserRow>> {
    sqlx::query_as(
        "SELECT id, email::text AS email, public_key, created_at FROM users WHERE id = $1 AND disabled_at IS NULL",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn user_by_email<'e>(db: impl PgExecutor<'e>, email: &str) -> sqlx::Result<Option<UserRow>> {
    sqlx::query_as(
        "SELECT id, email::text AS email, public_key, created_at FROM users WHERE email = $1 AND disabled_at IS NULL",
    )
    .bind(email)
    .fetch_optional(db)
    .await
}

/// Une ligne de `vaults` jointe à l'appartenance de l'utilisateur courant.
#[derive(sqlx::FromRow)]
pub struct VaultRow {
    pub id: Uuid,
    pub kind: String,
    pub name_enc: Vec<u8>,
    pub role: String,
    pub wrapped_vault_key: Vec<u8>,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl VaultRow {
    pub fn role(&self) -> Role {
        Role::parse(&self.role).unwrap_or(Role::Reader)
    }

    pub fn into_proto(self) -> Vault {
        Vault {
            id: self.id,
            kind: if self.kind == "personal" {
                VaultKind::Personal
            } else {
                VaultKind::Shared
            },
            role: self.role(),
            name_enc: self.name_enc,
            wrapped_vault_key: self.wrapped_vault_key,
            revision: self.revision,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

const VAULT_SELECT: &str =
    "SELECT v.id, v.kind, v.name_enc, m.role, m.wrapped_vault_key, v.revision, v.created_at, v.updated_at
     FROM vaults v JOIN vault_members m ON m.vault_id = v.id AND m.user_id = $1";

pub async fn vaults_for_user<'e>(db: impl PgExecutor<'e>, user_id: Uuid) -> sqlx::Result<Vec<VaultRow>> {
    sqlx::query_as(&format!("{VAULT_SELECT} ORDER BY v.kind, v.created_at"))
        .bind(user_id)
        .fetch_all(db)
        .await
}

/// Le vault s'il existe ET si l'utilisateur en est membre — sinon 404, sans
/// distinguer « n'existe pas » de « pas à toi » (pas d'énumération d'ids).
pub async fn vault_for_user<'e>(db: impl PgExecutor<'e>, user_id: Uuid, vault_id: Uuid) -> Result<VaultRow, AppError> {
    sqlx::query_as(&format!("{VAULT_SELECT} WHERE v.id = $2"))
        .bind(user_id)
        .bind(vault_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("vault"))
}

/// Même chose avec une exigence de rôle minimal.
pub async fn vault_with_role<'e>(
    db: impl PgExecutor<'e>,
    user_id: Uuid,
    vault_id: Uuid,
    min: Role,
) -> Result<VaultRow, AppError> {
    let v = vault_for_user(db, user_id, vault_id).await?;
    if v.role() < min {
        return Err(AppError::forbidden(format!("rôle {} requis", min.as_str())));
    }
    Ok(v)
}

#[derive(sqlx::FromRow)]
pub struct ItemRow {
    pub id: Uuid,
    pub vault_id: Uuid,
    pub item_type: String,
    pub revision: i64,
    pub ciphertext: Vec<u8>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

impl From<ItemRow> for Item {
    fn from(r: ItemRow) -> Self {
        Item {
            id: r.id,
            vault_id: r.vault_id,
            item_type: r.item_type,
            revision: r.revision,
            deleted: r.deleted_at.is_some(),
            ciphertext: r.ciphertext,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

// ─── Versions précédentes (historique, corbeille) ───────────────────────────

/// Garde la version courante d'un item avant qu'elle soit remplacée ou
/// supprimée, puis n'en garde que les `keep` dernières. `keep = 0` : pas
/// d'historique.
pub async fn keep_version(tx: &mut PgConnection, current: &ItemRow, by: Uuid, keep: usize) -> sqlx::Result<()> {
    if keep == 0 {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO item_versions (vault_id, item_id, revision, item_type, ciphertext, written_at, replaced_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING",
    )
    .bind(current.vault_id)
    .bind(current.id)
    .bind(current.revision)
    .bind(&current.item_type)
    .bind(&current.ciphertext)
    .bind(current.updated_at)
    .bind(by)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM item_versions WHERE vault_id = $1 AND item_id = $2 AND revision NOT IN (
            SELECT revision FROM item_versions WHERE vault_id = $1 AND item_id = $2 ORDER BY revision DESC LIMIT $3)",
    )
    .bind(current.vault_id)
    .bind(current.id)
    .bind(keep as i64)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// Efface de la corbeille ce qui y est depuis plus de `days` jours (tous
/// vaults confondus) ; rend le nombre de versions effacées.
pub async fn prune_trash<'e>(db: impl PgExecutor<'e>, days: u32) -> sqlx::Result<u64> {
    let res = sqlx::query(
        "DELETE FROM item_versions v USING items i
         WHERE i.vault_id = v.vault_id AND i.id = v.item_id
           AND i.deleted_at IS NOT NULL AND i.deleted_at < now() - make_interval(days => $1)",
    )
    .bind(days as i32)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

#[derive(sqlx::FromRow)]
pub struct VersionRow {
    pub item_id: Uuid,
    pub revision: i64,
    pub item_type: String,
    pub ciphertext: Vec<u8>,
    pub written_at: DateTime<Utc>,
    pub replaced_at: DateTime<Utc>,
    pub replaced_by: Option<String>,
}

pub const VERSION_SELECT: &str = "SELECT v.item_id, v.revision, v.item_type, v.ciphertext, v.written_at, v.replaced_at,
            u.email::text AS replaced_by
     FROM item_versions v LEFT JOIN users u ON u.id = v.replaced_by";

impl From<VersionRow> for ItemVersion {
    fn from(r: VersionRow) -> Self {
        ItemVersion {
            item_id: r.item_id,
            revision: r.revision,
            item_type: r.item_type,
            ciphertext: r.ciphertext,
            written_at: r.written_at,
            replaced_at: r.replaced_at,
            replaced_by: r.replaced_by,
        }
    }
}

/// Avance la révision du vault et la renvoie. À appeler dans la transaction
/// de l'écriture d'item : `FOR UPDATE` sérialise les écrivains concurrents
/// sur un même vault, donc deux écritures ne partagent jamais une révision.
pub async fn bump_revision<'e>(db: impl PgExecutor<'e>, vault_id: Uuid) -> sqlx::Result<i64> {
    let (rev,): (i64,) = sqlx::query_as(
        "UPDATE vaults SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision",
    )
    .bind(vault_id)
    .fetch_one(db)
    .await?;
    Ok(rev)
}

#[derive(sqlx::FromRow)]
pub struct InvitationRow {
    pub id: Uuid,
    pub vault_id: Uuid,
    pub inviter_email: String,
    pub invitee_email: String,
    pub invitee_public_key: Option<Vec<u8>>,
    pub role: String,
    pub status: String,
    pub has_key: bool,
    pub wrapped_vault_key: Option<Vec<u8>>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

pub const INVITATION_SELECT: &str = "SELECT i.id, i.vault_id, inv.email::text AS inviter_email, i.invitee_email::text AS invitee_email,
            u.public_key AS invitee_public_key, i.role,
            CASE WHEN i.status IN ('pending','awaiting_key') AND i.expires_at < now() THEN 'expired' ELSE i.status END AS status,
            (i.wrapped_vault_key IS NOT NULL) AS has_key, i.wrapped_vault_key, i.created_at, i.expires_at
     FROM invitations i
     JOIN users inv ON inv.id = i.inviter_user_id
     LEFT JOIN users u ON u.email = i.invitee_email AND u.disabled_at IS NULL";

impl From<InvitationRow> for Invitation {
    fn from(r: InvitationRow) -> Self {
        let status = match r.status.as_str() {
            "pending" => InvitationStatus::Pending,
            "awaiting_key" => InvitationStatus::AwaitingKey,
            "accepted" => InvitationStatus::Accepted,
            "declined" => InvitationStatus::Declined,
            "revoked" => InvitationStatus::Revoked,
            _ => InvitationStatus::Expired,
        };
        let fingerprint = r
            .invitee_public_key
            .as_deref()
            .and_then(|pk| guivault_crypto::PublicKey::try_from(pk).ok())
            .map(|pk| guivault_crypto::fingerprint(&pk));
        Invitation {
            id: r.id,
            vault_id: r.vault_id,
            inviter_email: r.inviter_email,
            invitee_email: r.invitee_email,
            invitee_public_key: r.invitee_public_key,
            invitee_fingerprint: fingerprint,
            role: Role::parse(&r.role).unwrap_or(Role::Reader),
            status,
            has_key: r.has_key,
            wrapped_vault_key: r.wrapped_vault_key,
            created_at: r.created_at,
            expires_at: r.expires_at,
        }
    }
}

pub async fn pending_invitations_for_email<'e>(
    db: impl PgExecutor<'e>,
    email: &str,
) -> sqlx::Result<Vec<InvitationRow>> {
    sqlx::query_as(&format!(
        "{INVITATION_SELECT} WHERE i.invitee_email = $1 AND i.status IN ('pending','awaiting_key') AND i.expires_at > now() ORDER BY i.created_at"
    ))
    .bind(email)
    .fetch_all(db)
    .await
}
