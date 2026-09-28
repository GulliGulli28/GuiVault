//! Accès d'urgence.
//!
//! Un utilisateur (le « donneur ») désigne un proche déjà inscrit (le
//! « contact ») et lui enveloppe la clé de vaults dont il est propriétaire
//! (`guivault_crypto::wrap_emergency_key`). Le serveur garde ces enveloppes
//! sans pouvoir les ouvrir. Le contact accepte, puis peut **demander**
//! l'accès : le serveur lui remet les enveloppes et le contenu des vaults
//! (en lecture) une fois le délai d'attente écoulé sans refus du donneur, ou
//! dès que celui-ci accorde. Le donneur peut refuser une demande, reprendre
//! la main après coup, changer le délai ou les vaults, ou retirer le contact.
//!
//! Un serveur compromis peut remettre les enveloppes plus tôt — au contact,
//! que le donneur a choisi, et à personne d'autre : il ne sait pas les
//! ouvrir. C'est l'inverse d'une récupération de compte, où le serveur garde
//! de quoi rouvrir le coffre (voir `docs/SECURITY.md`).
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::db::{self, ItemRow};
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use guivault_protocol::{
    CreateEmergencyGrantRequest, EmergencyGrant, EmergencyOverview, EmergencyParty, EmergencyStatus, EmergencyVault,
    EmergencyVaultKey, EmergencyVaultRef, ItemsPage, ServerEvent, UpdateEmergencyGrantRequest, VaultKind,
};
use sqlx::{PgConnection, PgExecutor};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

const MAX_WAIT_DAYS: u32 = 90;

#[derive(sqlx::FromRow)]
struct GrantRow {
    id: Uuid,
    grantor_id: Uuid,
    grantor_email: String,
    grantor_public_key: Vec<u8>,
    grantee_id: Uuid,
    grantee_email: String,
    grantee_public_key: Vec<u8>,
    wait_days: i32,
    created_at: DateTime<Utc>,
    accepted_at: Option<DateTime<Utc>>,
    requested_at: Option<DateTime<Utc>>,
    approved_at: Option<DateTime<Utc>>,
}

const GRANT_SELECT: &str =
    "SELECT g.id, g.grantor_id, gr.email::text AS grantor_email, gr.public_key AS grantor_public_key,
            g.grantee_id, ge.email::text AS grantee_email, ge.public_key AS grantee_public_key,
            g.wait_days, g.created_at, g.accepted_at, g.requested_at, g.approved_at
     FROM emergency_grants g
     JOIN users gr ON gr.id = g.grantor_id
     JOIN users ge ON ge.id = g.grantee_id";

impl GrantRow {
    /// Fin du délai, ou accord anticipé s'il est plus tôt ; `None` sans
    /// demande en cours.
    fn access_at(&self) -> Option<DateTime<Utc>> {
        let due = self.requested_at? + chrono::Duration::days(i64::from(self.wait_days));
        Some(self.approved_at.map_or(due, |a| a.min(due)))
    }

    fn status(&self) -> EmergencyStatus {
        if self.accepted_at.is_none() {
            EmergencyStatus::Invited
        } else {
            match self.access_at() {
                None => EmergencyStatus::Accepted,
                Some(at) if at <= Utc::now() => EmergencyStatus::Granted,
                Some(_) => EmergencyStatus::Requested,
            }
        }
    }

    fn into_proto(self, vaults: Vec<EmergencyVaultRef>) -> EmergencyGrant {
        let party = |id, email, public_key: Vec<u8>| {
            let fingerprint = guivault_crypto::PublicKey::try_from(public_key.as_slice())
                .map(|pk| guivault_crypto::fingerprint(&pk))
                .unwrap_or_default();
            EmergencyParty {
                id,
                email,
                public_key,
                fingerprint,
            }
        };
        EmergencyGrant {
            status: self.status(),
            access_at: self.access_at(),
            id: self.id,
            grantor: party(self.grantor_id, self.grantor_email, self.grantor_public_key),
            grantee: party(self.grantee_id, self.grantee_email, self.grantee_public_key),
            wait_days: self.wait_days as u32,
            requested_at: self.requested_at,
            vaults,
            created_at: self.created_at,
        }
    }
}

/// La désignation si l'utilisateur en est l'une des parties — sinon 404,
/// qu'elle existe ou non.
async fn fetch<'e>(db: impl PgExecutor<'e>, id: Uuid, user_id: Uuid) -> ApiResult<GrantRow> {
    sqlx::query_as::<_, GrantRow>(&format!(
        "{GRANT_SELECT} WHERE g.id = $1 AND (g.grantor_id = $2 OR g.grantee_id = $2)"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("accès d'urgence"))
}

async fn fetch_as_grantor<'e>(db: impl PgExecutor<'e>, id: Uuid, user_id: Uuid) -> ApiResult<GrantRow> {
    let g = fetch(db, id, user_id).await?;
    if g.grantor_id != user_id {
        return Err(AppError::forbidden("réservé à qui a désigné ce contact"));
    }
    Ok(g)
}

async fn fetch_as_grantee<'e>(db: impl PgExecutor<'e>, id: Uuid, user_id: Uuid) -> ApiResult<GrantRow> {
    let g = fetch(db, id, user_id).await?;
    if g.grantee_id != user_id {
        return Err(AppError::forbidden("réservé au contact d'urgence"));
    }
    Ok(g)
}

async fn vault_refs<'e>(
    db: impl PgExecutor<'e>,
    grants: &[Uuid],
) -> sqlx::Result<HashMap<Uuid, Vec<EmergencyVaultRef>>> {
    let rows: Vec<(Uuid, Uuid, bool)> = sqlx::query_as(
        "SELECT grant_id, vault_id, wrapped_vault_key IS NOT NULL FROM emergency_vault_keys
         WHERE grant_id = ANY($1) ORDER BY vault_id",
    )
    .bind(grants)
    .fetch_all(db)
    .await?;
    let mut out: HashMap<Uuid, Vec<EmergencyVaultRef>> = HashMap::new();
    for (grant_id, vault_id, has_key) in rows {
        out.entry(grant_id)
            .or_default()
            .push(EmergencyVaultRef { vault_id, has_key });
    }
    Ok(out)
}

async fn with_vaults(db: &mut PgConnection, g: GrantRow) -> ApiResult<EmergencyGrant> {
    let mut refs = vault_refs(&mut *db, &[g.id]).await?;
    let vaults = refs.remove(&g.id).unwrap_or_default();
    Ok(g.into_proto(vaults))
}

fn validate_wait(days: u32) -> ApiResult<()> {
    if !(1..=MAX_WAIT_DAYS).contains(&days) {
        return Err(AppError::bad_request(
            "invalid_wait",
            format!("délai d'attente entre 1 et {MAX_WAIT_DAYS} jours"),
        ));
    }
    Ok(())
}

/// Chaque enveloppe est au bon format, et pour un vault distinct dont le
/// donneur est propriétaire : on ne confie que ce qu'on possède — un vault
/// partagé par un autre reste à ses administrateurs.
async fn check_vaults(db: &mut PgConnection, grantor: Uuid, vaults: &[EmergencyVaultKey]) -> ApiResult<()> {
    if vaults.is_empty() {
        return Err(AppError::bad_request("no_vaults", "au moins un vault à confier"));
    }
    let mut seen = HashSet::new();
    for v in vaults {
        validate::emergency_key(&v.wrapped_vault_key)?;
        if !seen.insert(v.vault_id) {
            return Err(AppError::bad_request("duplicate_vault", "un vault apparaît deux fois"));
        }
    }
    let ids: Vec<Uuid> = seen.into_iter().collect();
    let (owned,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM vault_members WHERE user_id = $1 AND role = 'owner' AND vault_id = ANY($2)",
    )
    .bind(grantor)
    .bind(&ids)
    .fetch_one(&mut *db)
    .await?;
    if owned != ids.len() as i64 {
        return Err(AppError::forbidden(
            "seuls les vaults dont vous êtes propriétaire se confient",
        ));
    }
    Ok(())
}

async fn replace_vaults(db: &mut PgConnection, grant_id: Uuid, vaults: &[EmergencyVaultKey]) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM emergency_vault_keys WHERE grant_id = $1")
        .bind(grant_id)
        .execute(&mut *db)
        .await?;
    for v in vaults {
        sqlx::query("INSERT INTO emergency_vault_keys (grant_id, vault_id, wrapped_vault_key) VALUES ($1, $2, $3)")
            .bind(grant_id)
            .bind(v.vault_id)
            .bind(&v.wrapped_vault_key)
            .execute(&mut *db)
            .await?;
    }
    Ok(())
}

/// Après le commit : les deux parties relisent.
fn notify(state: &AppState, g: &EmergencyGrant) {
    state.events.publish(
        vec![g.grantor.id, g.grantee.id],
        ServerEvent::EmergencyChanged { grant_id: g.id },
    );
}

/// Ceux que j'ai désignés, et ceux qui m'ont désigné.
pub async fn overview(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<EmergencyOverview>> {
    let rows = sqlx::query_as::<_, GrantRow>(&format!(
        "{GRANT_SELECT} WHERE g.grantor_id = $1 OR g.grantee_id = $1 ORDER BY g.created_at"
    ))
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    let ids: Vec<Uuid> = rows.iter().map(|g| g.id).collect();
    let mut refs = vault_refs(&state.db, &ids).await?;
    let mut out = EmergencyOverview {
        granted_by_me: vec![],
        granted_to_me: vec![],
    };
    for g in rows {
        let mine = g.grantor_id == user.id;
        let vaults = refs.remove(&g.id).unwrap_or_default();
        if mine {
            out.granted_by_me.push(g.into_proto(vaults));
        } else {
            out.granted_to_me.push(g.into_proto(vaults));
        }
    }
    Ok(Json(out))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Json(req): Json<CreateEmergencyGrantRequest>,
) -> ApiResult<(StatusCode, Json<EmergencyGrant>)> {
    validate_wait(req.wait_days)?;
    if req.grantee_id == user.id {
        return Err(AppError::bad_request("self_grant", "on ne se désigne pas soi-même"));
    }
    db::user_by_id(&state.db, req.grantee_id)
        .await?
        .ok_or_else(|| AppError::not_found("utilisateur"))?;
    let mut tx = state.db.begin().await?;
    check_vaults(&mut tx, user.id, &req.vaults).await?;
    let id = Uuid::new_v4();
    let inserted = sqlx::query(
        "INSERT INTO emergency_grants (id, grantor_id, grantee_id, wait_days) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(user.id)
    .bind(req.grantee_id)
    .bind(req.wait_days as i32)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(AppError::conflict(
            "already_designated",
            "ce contact d'urgence est déjà désigné : modifier la désignation existante",
        ));
    }
    replace_vaults(&mut tx, id, &req.vaults).await?;
    Audit::new("emergency.create")
        .actor(user.id)
        .target(req.grantee_id)
        .ip(ip)
        .meta(serde_json::json!({ "grant": id, "wait_days": req.wait_days, "vaults": req.vaults.len() }))
        .write(&mut *tx)
        .await?;
    let g = fetch(&mut *tx, id, user.id).await?;
    let out = with_vaults(&mut tx, g).await?;
    tx.commit().await?;
    notify(&state, &out);
    Ok((StatusCode::CREATED, Json(out)))
}

/// Le délai, ou les vaults couverts (remplacés en entier — c'est aussi ainsi
/// qu'on renouvelle une enveloppe après une rotation).
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateEmergencyGrantRequest>,
) -> ApiResult<Json<EmergencyGrant>> {
    if let Some(days) = req.wait_days {
        validate_wait(days)?;
    }
    let mut tx = state.db.begin().await?;
    fetch_as_grantor(&mut *tx, id, user.id).await?;
    if let Some(days) = req.wait_days {
        sqlx::query("UPDATE emergency_grants SET wait_days = $2 WHERE id = $1")
            .bind(id)
            .bind(days as i32)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(vaults) = &req.vaults {
        check_vaults(&mut tx, user.id, vaults).await?;
        replace_vaults(&mut tx, id, vaults).await?;
    }
    Audit::new("emergency.update")
        .actor(user.id)
        .target(id)
        .ip(ip)
        .meta(serde_json::json!({ "wait_days": req.wait_days, "vaults": req.vaults.as_ref().map(Vec::len) }))
        .write(&mut *tx)
        .await?;
    let g = fetch(&mut *tx, id, user.id).await?;
    let out = with_vaults(&mut tx, g).await?;
    tx.commit().await?;
    notify(&state, &out);
    Ok(Json(out))
}

/// Retirer un contact (le donneur) ou renoncer (le contact). Ce qu'un contact
/// a déjà lu, il a pu le garder : renouveler la clé des vaults concernés.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let mut tx = state.db.begin().await?;
    let g = fetch(&mut *tx, id, user.id).await?;
    sqlx::query("DELETE FROM emergency_grants WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    Audit::new("emergency.delete")
        .actor(user.id)
        .target(id)
        .ip(ip)
        .meta(serde_json::json!({ "by": if g.grantor_id == user.id { "grantor" } else { "grantee" } }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    state.events.publish(
        vec![g.grantor_id, g.grantee_id],
        ServerEvent::EmergencyChanged { grant_id: id },
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Une transition d'état, dans une transaction, avec sa ligne d'audit.
async fn transition(
    state: &AppState,
    user: &AuthUser,
    ip: Option<std::net::IpAddr>,
    id: Uuid,
    action: &'static str,
    check: impl FnOnce(&GrantRow) -> ApiResult<()>,
    sql: &str,
) -> ApiResult<Json<EmergencyGrant>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT 1 FROM emergency_grants WHERE id = $1 FOR UPDATE")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let g = fetch(&mut *tx, id, user.id).await?;
    check(&g)?;
    sqlx::query(sql).bind(id).execute(&mut *tx).await?;
    Audit::new(action)
        .actor(user.id)
        .target(id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    let g = fetch(&mut *tx, id, user.id).await?;
    let out = with_vaults(&mut tx, g).await?;
    tx.commit().await?;
    notify(state, &out);
    Ok(Json(out))
}

fn only_grantee(g: &GrantRow, user: &AuthUser) -> ApiResult<()> {
    if g.grantee_id != user.id {
        return Err(AppError::forbidden("réservé au contact d'urgence"));
    }
    Ok(())
}

fn only_grantor(g: &GrantRow, user: &AuthUser) -> ApiResult<()> {
    if g.grantor_id != user.id {
        return Err(AppError::forbidden("réservé à qui a désigné ce contact"));
    }
    Ok(())
}

/// Le contact accepte d'être désigné.
pub async fn accept(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<EmergencyGrant>> {
    transition(
        &state,
        &user,
        ip,
        id,
        "emergency.accept",
        |g| {
            only_grantee(g, &user)?;
            if g.accepted_at.is_some() {
                return Err(AppError::conflict("already_accepted", "déjà acceptée"));
            }
            Ok(())
        },
        "UPDATE emergency_grants SET accepted_at = now() WHERE id = $1",
    )
    .await
}

/// Le contact demande l'accès : il l'aura au bout du délai, sauf refus.
pub async fn request(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<EmergencyGrant>> {
    transition(
        &state,
        &user,
        ip,
        id,
        "emergency.request",
        |g| {
            only_grantee(g, &user)?;
            match g.status() {
                EmergencyStatus::Invited => Err(AppError::conflict("not_accepted", "acceptez d'abord la désignation")),
                EmergencyStatus::Accepted => Ok(()),
                _ => Err(AppError::conflict("already_requested", "une demande est déjà en cours")),
            }
        },
        "UPDATE emergency_grants SET requested_at = now(), approved_at = NULL WHERE id = $1",
    )
    .await
}

/// Le donneur accorde sans attendre la fin du délai.
pub async fn approve(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<EmergencyGrant>> {
    transition(
        &state,
        &user,
        ip,
        id,
        "emergency.approve",
        |g| {
            only_grantor(g, &user)?;
            match g.status() {
                EmergencyStatus::Requested => Ok(()),
                EmergencyStatus::Granted => Err(AppError::conflict("already_granted", "l'accès est déjà accordé")),
                _ => Err(AppError::conflict("not_requested", "aucune demande en cours")),
            }
        },
        "UPDATE emergency_grants SET approved_at = now() WHERE id = $1",
    )
    .await
}

/// Le donneur refuse une demande, ou reprend la main sur un accès accordé ;
/// le contact, lui, retire sa demande. Retour à l'état accepté, sans
/// demande — ce que le contact a lu entre-temps, il a pu le garder.
pub async fn reject(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<EmergencyGrant>> {
    let by_grantor = fetch(&state.db, id, user.id).await?.grantor_id == user.id;
    transition(
        &state,
        &user,
        ip,
        id,
        if by_grantor {
            "emergency.reject"
        } else {
            "emergency.cancel"
        },
        |g| {
            if g.requested_at.is_none() {
                return Err(AppError::conflict("not_requested", "aucune demande en cours"));
            }
            Ok(())
        },
        "UPDATE emergency_grants SET requested_at = NULL, approved_at = NULL WHERE id = $1",
    )
    .await
}

/// L'accès est-il ouvert pour ce contact ? Sinon 403 `emergency_not_granted`.
async fn granted<'e>(db: impl PgExecutor<'e>, id: Uuid, user: &AuthUser) -> ApiResult<GrantRow> {
    let g = fetch_as_grantee(db, id, user.id).await?;
    if g.status() != EmergencyStatus::Granted {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "emergency_not_granted",
            "l'accès d'urgence n'est pas (ou plus) accordé",
        ));
    }
    Ok(g)
}

#[derive(sqlx::FromRow)]
struct EmergencyVaultRow {
    id: Uuid,
    kind: String,
    name_enc: Vec<u8>,
    wrapped_vault_key: Vec<u8>,
    revision: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// Les vaults confiés dont le donneur est toujours propriétaire et dont
/// l'enveloppe est à jour.
const EMERGENCY_VAULT_SELECT: &str =
    "SELECT v.id, v.kind, v.name_enc, k.wrapped_vault_key, v.revision, v.created_at, v.updated_at
     FROM emergency_vault_keys k
     JOIN emergency_grants g ON g.id = k.grant_id
     JOIN vaults v ON v.id = k.vault_id
     JOIN vault_members m ON m.vault_id = v.id AND m.user_id = g.grantor_id AND m.role = 'owner'
     WHERE k.grant_id = $1 AND k.wrapped_vault_key IS NOT NULL";

/// Le contact, accès accordé : les vaults confiés, avec leur enveloppe
/// d'urgence. La première lecture de chaque vault après la demande laisse une
/// ligne d'audit sur le vault — son propriétaire la voit dans le journal.
pub async fn vaults(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Vec<EmergencyVault>>> {
    let g = granted(&state.db, id, &user).await?;
    let rows = sqlx::query_as::<_, EmergencyVaultRow>(&format!("{EMERGENCY_VAULT_SELECT} ORDER BY v.created_at"))
        .bind(id)
        .fetch_all(&state.db)
        .await?;
    let mut tx = state.db.begin().await?;
    for r in &rows {
        let (seen,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM audit_log WHERE action = 'emergency.access'
                            AND actor_id = $1 AND vault_id = $2 AND at >= $3)",
        )
        .bind(user.id)
        .bind(r.id)
        .bind(g.requested_at)
        .fetch_one(&mut *tx)
        .await?;
        if !seen {
            Audit::new("emergency.access")
                .actor(user.id)
                .vault(r.id)
                .target(id)
                .ip(ip)
                .write(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| EmergencyVault {
                id: r.id,
                kind: if r.kind == "personal" {
                    VaultKind::Personal
                } else {
                    VaultKind::Shared
                },
                name_enc: r.name_enc,
                wrapped_vault_key: r.wrapped_vault_key,
                revision: r.revision,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })
            .collect(),
    ))
}

/// Le contact, accès accordé : les items vivants d'un vault confié.
pub async fn items(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, vault_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<ItemsPage>> {
    granted(&state.db, id, &user).await?;
    let vault = sqlx::query_as::<_, EmergencyVaultRow>(&format!("{EMERGENCY_VAULT_SELECT} AND v.id = $2"))
        .bind(id)
        .bind(vault_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("vault"))?;
    let rows = sqlx::query_as::<_, ItemRow>(
        "SELECT * FROM items WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY revision",
    )
    .bind(vault_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(ItemsPage {
        items: rows.into_iter().map(Into::into).collect(),
        revision: vault.revision,
    }))
}

// ─── Rotation et transfert (appelés par `vaults`) ───────────────────────────

/// La clé du vault a tourné. Le propriétaire fournit les nouvelles
/// enveloppes (toutes) ; sinon — un autre rôle, ou un client qui ne connaît
/// pas l'urgence — elles sont marquées à renouveler. Rend les donneurs à
/// prévenir.
pub async fn on_rotation(
    db: &mut PgConnection,
    vault_id: Uuid,
    rotated_by_owner: bool,
    sent: Option<&[guivault_protocol::RotatedEmergencyKey]>,
) -> ApiResult<Vec<(Uuid, Uuid)>> {
    let stored: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT k.grant_id, g.grantor_id FROM emergency_vault_keys k
         JOIN emergency_grants g ON g.id = k.grant_id WHERE k.vault_id = $1",
    )
    .bind(vault_id)
    .fetch_all(&mut *db)
    .await?;
    match sent {
        Some(sent) => {
            if !rotated_by_owner {
                return Err(AppError::bad_request(
                    "not_owner",
                    "seul le propriétaire du vault ré-enveloppe pour ses contacts d'urgence",
                ));
            }
            let mut expected: HashSet<Uuid> = stored.iter().map(|(g, _)| *g).collect();
            for k in sent {
                validate::emergency_key(&k.wrapped_vault_key)?;
                if !expected.remove(&k.grant_id) {
                    return Err(AppError::bad_request(
                        "unknown_grant",
                        format!("{} ne couvre pas ce vault", k.grant_id),
                    ));
                }
            }
            if !expected.is_empty() {
                return Err(AppError::bad_request(
                    "incomplete_rotation",
                    "il manque une enveloppe pour un contact d'urgence",
                ));
            }
            for k in sent {
                sqlx::query(
                    "UPDATE emergency_vault_keys SET wrapped_vault_key = $3 WHERE grant_id = $1 AND vault_id = $2",
                )
                .bind(k.grant_id)
                .bind(vault_id)
                .bind(&k.wrapped_vault_key)
                .execute(&mut *db)
                .await?;
            }
        }
        None => {
            sqlx::query("UPDATE emergency_vault_keys SET wrapped_vault_key = NULL WHERE vault_id = $1")
                .bind(vault_id)
                .execute(&mut *db)
                .await?;
        }
    }
    Ok(stored)
}

/// La propriété du vault change de mains : l'ancien propriétaire ne le
/// confie plus. Le nouveau le confiera à ses propres contacts s'il le veut.
pub async fn on_transfer(db: &mut PgConnection, vault_id: Uuid, old_owner: Uuid) -> sqlx::Result<()> {
    sqlx::query(
        "DELETE FROM emergency_vault_keys WHERE vault_id = $1
         AND grant_id IN (SELECT id FROM emergency_grants WHERE grantor_id = $2)",
    )
    .bind(vault_id)
    .bind(old_owner)
    .execute(&mut *db)
    .await?;
    Ok(())
}
