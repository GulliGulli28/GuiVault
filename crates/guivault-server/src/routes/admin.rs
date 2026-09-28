//! Administration du serveur (`/admin/*`) : comptes, désactivation, quotas,
//! inscriptions ouvertes à une adresse. Un administrateur voit des
//! métadonnées — adresses, dates, tailles —, jamais un contenu : il n'a pas
//! plus de clé que le serveur.
//!
//! Le rôle se donne depuis le shell du serveur (`guivault admin grant`,
//! voir `crate::admin`) ; l'API ne sait ni le donner ni le retirer, et un
//! administrateur ne peut ni désactiver ni supprimer un autre
//! administrateur : une session volée ne s'installe pas, et ne met pas les
//! autres dehors.
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::error::{ApiResult, AppError};
use crate::routes::users::{SharedVaults, delete_account};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use chrono::{DateTime, Utc};
use guivault_protocol::{
    AdminOverview, AdminUserInfo, BackupRun, BackupsStatus, CreateRegistrationInvite, RegistrationInvite,
    SetQuotaRequest,
};
use std::net::IpAddr;
use uuid::Uuid;

/// L'administrateur d'une requête : authentifié, `is_admin`, et depuis une
/// adresse admise par `GUIVAULT_ADMIN_ALLOWED_IPS`.
pub struct Admin {
    pub user: AuthUser,
    pub ip: Option<IpAddr>,
}

impl FromRequestParts<AppState> for Admin {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let Ok(ClientIp(ip)) = ClientIp::from_request_parts(parts, state).await;
        if !state.config.admin_allowed_ips.allows(ip) {
            return Err(ip_not_allowed());
        }
        let user = AuthUser::from_request_parts(parts, state).await?;
        let is_admin: bool = sqlx::query_scalar("SELECT is_admin FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_one(&state.db)
            .await?;
        if !is_admin {
            return Err(AppError::forbidden("réservé aux administrateurs du serveur"));
        }
        Ok(Admin { user, ip })
    }
}

pub fn ip_not_allowed() -> AppError {
    AppError::new(
        StatusCode::FORBIDDEN,
        "ip_not_allowed",
        "ce serveur n'accepte pas de requêtes depuis votre adresse",
    )
}

pub async fn overview(State(state): State<AppState>, _admin: Admin) -> ApiResult<Json<AdminOverview>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        users: i64,
        disabled_users: i64,
        admins: i64,
        vaults: i64,
        shared_vaults: i64,
        items: i64,
        storage_bytes: i64,
        sends: i64,
        active_sessions: i64,
        pending_registrations: i64,
    }
    let r: Row = sqlx::query_as(
        "SELECT
            (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL) AS disabled_users,
            (SELECT count(*) FROM users WHERE is_admin) AS admins,
            (SELECT count(*) FROM vaults) AS vaults,
            (SELECT count(*) FROM vaults WHERE kind = 'shared') AS shared_vaults,
            (SELECT count(*) FROM items WHERE deleted_at IS NULL) AS items,
            (SELECT coalesce(sum(octet_length(ciphertext)), 0)::bigint FROM items WHERE deleted_at IS NULL) AS storage_bytes,
            (SELECT count(*) FROM sends) AS sends,
            (SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND refresh_expires_at > now()) AS active_sessions,
            (SELECT count(*) FROM registration_invites WHERE expires_at > now()) AS pending_registrations",
    )
    .fetch_one(&state.db)
    .await?;
    Ok(Json(AdminOverview {
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        registration: state.config.registration,
        users: r.users,
        disabled_users: r.disabled_users,
        admins: r.admins,
        vaults: r.vaults,
        shared_vaults: r.shared_vaults,
        items: r.items,
        storage_bytes: r.storage_bytes,
        sends: r.sends,
        active_sessions: r.active_sessions,
        pending_registrations: r.pending_registrations,
        default_quota_bytes: state.config.quota_bytes,
        allowed_ips: state.config.allowed_ips.to_strings(),
        admin_allowed_ips: state.config.admin_allowed_ips.to_strings(),
        mail_enabled: state.mail.enabled(),
        mail_error: state.mail.error().map(str::to_string),
    }))
}

#[derive(sqlx::FromRow)]
struct UserInfoRow {
    id: Uuid,
    email: String,
    created_at: DateTime<Utc>,
    disabled_at: Option<DateTime<Utc>>,
    is_admin: bool,
    totp_enabled: bool,
    last_seen_at: Option<DateTime<Utc>>,
    active_sessions: i64,
    vaults_owned: i64,
    vaults_joined: i64,
    items: i64,
    storage_bytes: i64,
    quota_bytes: Option<i64>,
}

const USER_INFO: &str = "SELECT u.id, u.email::text AS email, u.created_at, u.disabled_at, u.is_admin, u.quota_bytes,
        EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id AND t.enabled_at IS NOT NULL) AS totp_enabled,
        (SELECT max(s.last_used_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
        (SELECT count(*) FROM sessions s
          WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.refresh_expires_at > now()) AS active_sessions,
        (SELECT count(*) FROM vault_members m WHERE m.user_id = u.id AND m.role = 'owner') AS vaults_owned,
        (SELECT count(*) FROM vault_members m WHERE m.user_id = u.id AND m.role <> 'owner') AS vaults_joined,
        coalesce(st.items, 0) AS items, coalesce(st.bytes, 0) AS storage_bytes
    FROM users u
    LEFT JOIN LATERAL (
        SELECT count(*) AS items, sum(octet_length(i.ciphertext))::bigint AS bytes
        FROM items i JOIN vault_members m ON m.vault_id = i.vault_id AND m.role = 'owner'
        WHERE m.user_id = u.id AND i.deleted_at IS NULL
    ) st ON true";

impl UserInfoRow {
    fn into_info(self, default_quota: u64) -> AdminUserInfo {
        AdminUserInfo {
            effective_quota_bytes: effective_quota(self.quota_bytes, default_quota),
            id: self.id,
            email: self.email,
            created_at: self.created_at,
            disabled_at: self.disabled_at,
            is_admin: self.is_admin,
            totp_enabled: self.totp_enabled,
            last_seen_at: self.last_seen_at,
            active_sessions: self.active_sessions,
            vaults_owned: self.vaults_owned,
            vaults_joined: self.vaults_joined,
            items: self.items,
            storage_bytes: self.storage_bytes,
            quota_bytes: self.quota_bytes,
        }
    }
}

/// Le quota qui s'applique : celui du compte, sinon celui du serveur ; `0` :
/// aucun.
pub fn effective_quota(own: Option<i64>, default: u64) -> u64 {
    match own {
        Some(q) => q.max(0) as u64,
        None => default,
    }
}

pub async fn users(State(state): State<AppState>, _admin: Admin) -> ApiResult<Json<Vec<AdminUserInfo>>> {
    let rows: Vec<UserInfoRow> = sqlx::query_as(&format!("{USER_INFO} ORDER BY u.created_at"))
        .fetch_all(&state.db)
        .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| r.into_info(state.config.quota_bytes))
            .collect(),
    ))
}

async fn user_info(state: &AppState, id: Uuid) -> ApiResult<AdminUserInfo> {
    let row: UserInfoRow = sqlx::query_as(&format!("{USER_INFO} WHERE u.id = $1"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::not_found("compte"))?;
    Ok(row.into_info(state.config.quota_bytes))
}

/// Ni soi-même (on ne se ferme pas la porte), ni un autre administrateur
/// (le rôle se retire d'abord depuis le serveur).
async fn target(state: &AppState, admin: &Admin, id: Uuid) -> ApiResult<AdminUserInfo> {
    if id == admin.user.id {
        return Err(AppError::bad_request(
            "self_action",
            "impossible sur votre propre compte depuis l'administration",
        ));
    }
    let info = user_info(state, id).await?;
    if info.is_admin {
        return Err(AppError::conflict(
            "target_is_admin",
            "c'est un administrateur : retirez-lui d'abord le rôle depuis le serveur (guivault admin revoke)",
        ));
    }
    Ok(info)
}

/// Désactive un compte : plus de connexion, sessions révoquées. Ses vaults
/// restent (partagés : les autres membres continuent), rien n'est effacé.
pub async fn disable(
    State(state): State<AppState>,
    admin: Admin,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<AdminUserInfo>> {
    let info = target(&state, &admin, id).await?;
    let mut tx = state.db.begin().await?;
    let changed = sqlx::query("UPDATE users SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL")
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if changed > 0 {
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        Audit::new("admin.user_disable")
            .actor(admin.user.id)
            .target(id)
            .ip(admin.ip)
            .write(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if changed > 0 {
        crate::mail::notice(
            &state,
            &info.email,
            "Votre compte GuiVault a été désactivé",
            "Un administrateur du serveur a désactivé votre compte GuiVault : vos sessions sont fermées et vous ne pouvez \
             plus vous connecter. Rien n'est effacé ; adressez-vous à lui.",
        );
    }
    Ok(Json(user_info(&state, id).await?))
}

pub async fn enable(
    State(state): State<AppState>,
    admin: Admin,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<AdminUserInfo>> {
    target(&state, &admin, id).await?;
    let mut tx = state.db.begin().await?;
    let changed = sqlx::query("UPDATE users SET disabled_at = NULL WHERE id = $1 AND disabled_at IS NOT NULL")
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if changed > 0 {
        Audit::new("admin.user_enable")
            .actor(admin.user.id)
            .target(id)
            .ip(admin.ip)
            .write(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(user_info(&state, id).await?))
}

/// Quota d'un compte (y compris le sien : ce n'est pas se fermer la porte).
pub async fn set_quota(
    State(state): State<AppState>,
    admin: Admin,
    Path(id): Path<Uuid>,
    Json(req): Json<SetQuotaRequest>,
) -> ApiResult<Json<AdminUserInfo>> {
    let quota = req
        .quota_bytes
        .map(|q| i64::try_from(q).map_err(|_| AppError::bad_request("invalid_quota", "quota trop grand")))
        .transpose()?;
    let mut tx = state.db.begin().await?;
    let changed = sqlx::query("UPDATE users SET quota_bytes = $2 WHERE id = $1")
        .bind(id)
        .bind(quota)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if changed == 0 {
        return Err(AppError::not_found("compte"));
    }
    Audit::new("admin.user_quota")
        .actor(admin.user.id)
        .target(id)
        .ip(admin.ip)
        .meta(serde_json::json!({ "quota_bytes": quota }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(user_info(&state, id).await?))
}

/// Supprime un compte comme `DELETE /users/me`, sans son mot de passe — et
/// ses vaults partagés avec d'autres passent au membre le mieux placé au
/// lieu de bloquer (`SharedVaults::Transfer`).
pub async fn delete_user(State(state): State<AppState>, admin: Admin, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    let info = target(&state, &admin, id).await?;
    delete_account(
        &state,
        id,
        &info.email,
        Some((admin.user.id, admin.ip)),
        SharedVaults::Transfer,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── Inscriptions ouvertes par un administrateur ────────────────────────────

pub async fn registrations(State(state): State<AppState>, _admin: Admin) -> ApiResult<Json<Vec<RegistrationInvite>>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        email: String,
        invited_by: Option<String>,
        created_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT r.email::text AS email, u.email::text AS invited_by, r.created_at, r.expires_at
         FROM registration_invites r LEFT JOIN users u ON u.id = r.invited_by
         WHERE r.expires_at > now() ORDER BY r.created_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| RegistrationInvite {
                email: r.email,
                invited_by: r.invited_by,
                created_at: r.created_at,
                expires_at: r.expires_at,
            })
            .collect(),
    ))
}

/// Ouvre l'inscription à une adresse, quel que soit `GUIVAULT_REGISTRATION`
/// (utile surtout en `invite_only` sans vault à partager, et en `closed`).
/// Renouvelle si elle l'était déjà.
pub async fn create_registration(
    State(state): State<AppState>,
    admin: Admin,
    Json(req): Json<CreateRegistrationInvite>,
) -> ApiResult<(StatusCode, Json<RegistrationInvite>)> {
    let email = validate::normalize_email(&req.email)?;
    let days = req.days.unwrap_or(14);
    if !(1..=90).contains(&days) {
        return Err(AppError::bad_request("invalid_days", "durée de 1 à 90 jours"));
    }
    // Désactivés compris : l'adresse est prise.
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE email = $1)")
        .bind(&email)
        .fetch_one(&state.db)
        .await?;
    if taken {
        return Err(AppError::conflict("email_taken", "cette adresse a déjà un compte"));
    }
    let mut tx = state.db.begin().await?;
    let (created_at, expires_at): (DateTime<Utc>, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO registration_invites (email, invited_by, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))
         ON CONFLICT (email) DO UPDATE
            SET invited_by = EXCLUDED.invited_by, created_at = now(), expires_at = EXCLUDED.expires_at
         RETURNING created_at, expires_at",
    )
    .bind(&email)
    .bind(admin.user.id)
    .bind(days as i32)
    .fetch_one(&mut *tx)
    .await?;
    Audit::new("admin.registration_open")
        .actor(admin.user.id)
        .target(&email)
        .ip(admin.ip)
        .meta(serde_json::json!({ "days": days }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::mail::registration_opened(&state, (admin.user.id, &admin.user.email), &email, expires_at);
    Ok((
        StatusCode::CREATED,
        Json(RegistrationInvite {
            email,
            invited_by: Some(admin.user.email),
            created_at,
            expires_at,
        }),
    ))
}

pub async fn delete_registration(
    State(state): State<AppState>,
    admin: Admin,
    Path(email): Path<String>,
) -> ApiResult<StatusCode> {
    let email = validate::normalize_email(&email)?;
    let mut tx = state.db.begin().await?;
    let gone = sqlx::query("DELETE FROM registration_invites WHERE email = $1")
        .bind(&email)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if gone == 0 {
        return Err(AppError::not_found("inscription"));
    }
    Audit::new("admin.registration_close")
        .actor(admin.user.id)
        .target(&email)
        .ip(admin.ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── Sauvegardes ────────────────────────────────────────────────────────────

pub async fn backups(State(state): State<AppState>, _admin: Admin) -> ApiResult<Json<BackupsStatus>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: i64,
        triggered_by: String,
        started_at: DateTime<Utc>,
        finished_at: Option<DateTime<Utc>>,
        file: Option<String>,
        bytes: Option<i64>,
        row_count: Option<i64>,
        sha256: Option<String>,
        verified: Option<String>,
        error: Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as("SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT 20")
        .fetch_all(&state.db)
        .await?;
    let cfg = state.config.backup.as_ref();
    Ok(Json(BackupsStatus {
        enabled: cfg.is_some(),
        dir: cfg.map(|c| c.dir.display().to_string()),
        interval_hours: cfg.map_or(0, |c| c.interval.as_secs() / 3600),
        keep: cfg.map_or(0, |c| c.keep.min(u32::MAX as usize) as u32),
        restore_check: cfg.is_some_and(|c| c.verify_database_url.is_some()),
        running: crate::backup::running(&state.db).await?,
        runs: rows
            .into_iter()
            .map(|r| BackupRun {
                id: r.id,
                triggered_by: r.triggered_by,
                started_at: r.started_at,
                finished_at: r.finished_at,
                file: r.file,
                bytes: r.bytes,
                row_count: r.row_count,
                sha256: r.sha256,
                verified: r.verified,
                error: r.error,
            })
            .collect(),
    }))
}

/// Lance une sauvegarde tout de suite (en arrière-plan) : `202`, puis suivre
/// `GET /admin/backups`.
pub async fn backup_now(State(state): State<AppState>, admin: Admin) -> ApiResult<StatusCode> {
    let Some(cfg) = state.config.backup.clone() else {
        return Err(AppError::bad_request(
            "backups_disabled",
            "pas de sauvegardes sur ce serveur (GUIVAULT_BACKUP_DIR)",
        ));
    };
    if crate::backup::running(&state.db).await? {
        return Err(AppError::conflict("backup_running", "une sauvegarde est déjà en cours"));
    }
    Audit::new("admin.backup")
        .actor(admin.user.id)
        .ip(admin.ip)
        .write(&state.db)
        .await?;
    let (db, url) = (state.db.clone(), state.config.database_url.clone());
    tokio::spawn(async move {
        // Échec journalisé et noté dans `backup_runs` par `run`.
        let _ = crate::backup::run(&db, &cfg, &url, crate::backup::Trigger::Admin).await;
    });
    Ok(StatusCode::ACCEPTED)
}

// ─── E-mails ────────────────────────────────────────────────────────────────

/// Un e-mail d'essai à l'administrateur, attendu : le seul envoi dont
/// l'échec remonte (`502 mail_failed`, avec la réponse du serveur SMTP).
pub async fn mail_test(State(state): State<AppState>, admin: Admin) -> ApiResult<StatusCode> {
    if !state.mail.enabled() {
        return Err(AppError::bad_request(
            "mail_disabled",
            state
                .mail
                .error()
                .map(|e| format!("e-mails inutilisables : {e}"))
                .unwrap_or_else(|| "pas d'e-mails sur ce serveur (GUIVAULT_SMTP_URL)".into()),
        ));
    }
    let sent = state
        .mail
        .send_now(crate::mail::Mail {
            to: admin.user.email.clone(),
            subject: "Essai d'envoi GuiVault".into(),
            body:
                "Les e-mails de ce serveur GuiVault fonctionnent : invitations, alertes de connexion, accès d'urgence."
                    .into(),
        })
        .await;
    Audit::new("admin.mail_test")
        .actor(admin.user.id)
        .ip(admin.ip)
        .meta(serde_json::json!({ "ok": sent.is_ok() }))
        .write(&state.db)
        .await?;
    match sent {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(e) => Err(AppError::new(
            StatusCode::BAD_GATEWAY,
            "mail_failed",
            format!("envoi impossible : {e:#}"),
        )),
    }
}
