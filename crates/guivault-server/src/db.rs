//! Lignes SQL et requêtes partagées entre plusieurs routes. Les routes qui
//! n'ont qu'un seul consommateur gardent leurs requêtes chez elles.
use crate::error::AppError;
use chrono::{DateTime, Utc};
use guivault_protocol::{
    Invitation, InvitationStatus, Item, ItemVersion, ItemsPage, Role, UserProfile, Vault, VaultKind, VaultManifest,
};
use sqlx::{PgConnection, PgExecutor};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub email: String,
    pub public_key: Vec<u8>,
    pub created_at: DateTime<Utc>,
    pub is_admin: bool,
}

impl From<UserRow> for UserProfile {
    fn from(r: UserRow) -> Self {
        UserProfile {
            id: r.id,
            email: r.email,
            public_key: r.public_key,
            created_at: r.created_at,
            is_admin: r.is_admin,
        }
    }
}

pub async fn user_by_id<'e>(db: impl PgExecutor<'e>, id: Uuid) -> sqlx::Result<Option<UserRow>> {
    sqlx::query_as(
        "SELECT id, email::text AS email, public_key, created_at, is_admin FROM users WHERE id = $1 AND disabled_at IS NULL",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn user_by_email<'e>(db: impl PgExecutor<'e>, email: &str) -> sqlx::Result<Option<UserRow>> {
    sqlx::query_as(
        "SELECT id, email::text AS email, public_key, created_at, is_admin FROM users WHERE email = $1 AND disabled_at IS NULL",
    )
    .bind(email)
    .fetch_optional(db)
    .await
}

/// Items, révision et manifeste d'un vault, lus dans **un seul instantané** :
/// un client vérifie les uns contre l'autre, une écriture entre deux lectures
/// y ferait voir un écart qui n'existe pas. `since` : seulement ce qui a
/// changé après (tombales comprises) ; sinon tout le vivant.
pub async fn items_page(db: &sqlx::PgPool, vault_id: Uuid, since: Option<i64>) -> sqlx::Result<ItemsPage> {
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let (revision, manifest, manifest_revision): (i64, Option<Vec<u8>>, i64) =
        sqlx::query_as("SELECT revision, manifest, manifest_revision FROM vaults WHERE id = $1")
            .bind(vault_id)
            .fetch_one(&mut *tx)
            .await?;
    let rows = match since {
        Some(since) => {
            sqlx::query_as::<_, ItemRow>("SELECT * FROM items WHERE vault_id = $1 AND revision > $2 ORDER BY revision")
                .bind(vault_id)
                .bind(since)
                .fetch_all(&mut *tx)
                .await?
        }
        None => {
            sqlx::query_as::<_, ItemRow>(
                "SELECT * FROM items WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY revision",
            )
            .bind(vault_id)
            .fetch_all(&mut *tx)
            .await?
        }
    };
    tx.commit().await?;
    Ok(ItemsPage {
        items: rows.into_iter().map(Into::into).collect(),
        revision,
        manifest: manifest.map(|ciphertext| VaultManifest {
            ciphertext,
            revision: manifest_revision,
        }),
    })
}

/// Le manifeste d'un vault **verrouillé** (`FOR UPDATE` déjà pris) : ce que
/// l'écriture en cours doit respecter.
pub async fn locked_manifest(tx: &mut PgConnection, vault_id: Uuid) -> sqlx::Result<(Option<Vec<u8>>, i64)> {
    sqlx::query_as("SELECT manifest, manifest_revision FROM vaults WHERE id = $1")
        .bind(vault_id)
        .fetch_one(tx)
        .await
}

/// Ce qu'une écriture fait du manifeste : refusée si le vault en a un et
/// qu'elle n'en apporte pas (un client d'avant les manifestes ne doit pas y
/// écrire sans le tenir à jour), en conflit si elle s'appuie sur une révision
/// dépassée (le courant est joint, le client refait le sien). `Some` : le
/// blob et la révision à enregistrer.
pub fn next_manifest(
    current: &(Option<Vec<u8>>, i64),
    write: Option<&guivault_protocol::ManifestWrite>,
    max_item: usize,
) -> Result<Option<(Vec<u8>, i64)>, AppError> {
    let (blob, revision) = current;
    let Some(write) = write else {
        if blob.is_some() {
            return Err(manifest_required());
        }
        return Ok(None);
    };
    crate::validate::manifest(&write.ciphertext, max_item)?;
    if write.base_revision != *revision {
        return Err(manifest_conflict(current));
    }
    Ok(Some((write.ciphertext.clone(), revision + 1)))
}

pub fn manifest_required() -> AppError {
    AppError::conflict(
        "manifest_required",
        "ce vault est protégé par un manifeste : mettez à jour ce client pour y écrire",
    )
}

pub fn manifest_conflict(current: &(Option<Vec<u8>>, i64)) -> AppError {
    let body = current.0.as_ref().map(|ciphertext| VaultManifest {
        ciphertext: ciphertext.clone(),
        revision: current.1,
    });
    AppError::conflict(
        "manifest_conflict",
        "le manifeste du vault a changé depuis votre lecture",
    )
    .with_extra(serde_json::json!({ "current": body }))
}

pub async fn store_manifest(tx: &mut PgConnection, vault_id: Uuid, blob: &[u8], revision: i64) -> sqlx::Result<()> {
    sqlx::query("UPDATE vaults SET manifest = $2, manifest_revision = $3 WHERE id = $1")
        .bind(vault_id)
        .bind(blob)
        .bind(revision)
        .execute(tx)
        .await?;
    Ok(())
}

/// Le propriétaire du vault a-t-il la place d'écrire ce chiffré ? Son usage :
/// les chiffrés vivants de tous les vaults qu'il possède, leurs pièces
/// jointes et les fichiers de ses liens ([`USAGE`] ; ni l'historique, borné par `GUIVAULT_ITEM_HISTORY`, ni les
/// tombales). Une écriture qui ne
/// grossit pas passe toujours — un quota abaissé sous l'usage n'empêche pas
/// de corriger ou d'alléger. À appeler sous le verrou du vault.
pub async fn check_quota(
    tx: &mut PgConnection,
    default_quota: u64,
    vault_id: Uuid,
    item_id: Uuid,
    old_len: usize,
    new_len: usize,
) -> Result<(), AppError> {
    if new_len <= old_len {
        return Ok(());
    }
    let row: Option<(Option<i64>, i64)> = sqlx::query_as(&format!(
        "SELECT u.quota_bytes, {USAGE}
         FROM vault_members m JOIN users u ON u.id = m.user_id
         WHERE m.vault_id = $1 AND m.role = 'owner'"
    ))
    .bind(vault_id)
    .bind(item_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((own, used)) = row else { return Ok(()) };
    enforce_quota(
        own,
        used,
        default_quota,
        new_len,
        "quota de stockage atteint pour le propriétaire de ce vault",
    )
}

/// Le compte a-t-il la place de garder `new_len` octets de plus à son nom
/// (le fichier d'un lien de partage) ? À appeler sous le verrou du compte.
pub async fn check_user_quota(
    tx: &mut PgConnection,
    default_quota: u64,
    user_id: Uuid,
    new_len: usize,
) -> Result<(), AppError> {
    let (own, used): (Option<i64>, i64) =
        sqlx::query_as(&format!("SELECT u.quota_bytes, {USAGE} FROM users u WHERE u.id = $3"))
            .bind(Uuid::nil())
            .bind(Uuid::nil())
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
    enforce_quota(own, used, default_quota, new_len, "quota de stockage atteint")
}

/// L'usage du compte `u` : les chiffrés vivants des vaults qu'il possède
/// (sauf l'item `($1, $2)`, en passe d'être remplacé), leurs pièces jointes,
/// et les fichiers de ses liens de partage encore gardés (en cours d'envoi,
/// ou dont les morceaux n'ont pas été effacés).
const USAGE: &str = "(coalesce((SELECT sum(octet_length(i.ciphertext))
          FROM items i JOIN vault_members o ON o.vault_id = i.vault_id AND o.role = 'owner'
          WHERE o.user_id = u.id AND i.deleted_at IS NULL AND NOT (i.vault_id = $1 AND i.id = $2)), 0)
     + coalesce((SELECT sum(a.size_bytes)
          FROM attachments a JOIN vault_members o ON o.vault_id = a.vault_id AND o.role = 'owner'
          WHERE o.user_id = u.id), 0)
     + coalesce((SELECT sum(s.file_size) FROM sends s
          WHERE s.owner_id = u.id AND (NOT s.file_complete OR EXISTS (SELECT 1 FROM send_chunks c WHERE c.send_id = s.id))), 0))::bigint";

fn enforce_quota(
    own: Option<i64>,
    used: i64,
    default_quota: u64,
    new_len: usize,
    message: &str,
) -> Result<(), AppError> {
    let quota = crate::routes::admin::effective_quota(own, default_quota);
    let after = used.max(0) as u64 + new_len as u64;
    if quota > 0 && after > quota {
        return Err(AppError::new(
            axum::http::StatusCode::INSUFFICIENT_STORAGE,
            "quota_exceeded",
            message.to_string(),
        )
        .with_extra(serde_json::json!({ "used": used, "quota": quota })));
    }
    Ok(())
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
