//! Second facteur TOTP (RFC 6238) et codes de récupération.
//!
//! Ce que ça protège : la *session* (un mot de passe maître volé ne suffit
//! plus à se connecter). Ce que ça ne protège pas : les données — quelqu'un
//! qui a le mot de passe maître **et** un dump de la base a tout, 2FA ou
//! pas. Voir `docs/SECURITY.md`.
//!
//! Le secret TOTP est chiffré au repos sous une clé dérivée de
//! `GUIVAULT_SECRET` (AAD = id utilisateur) : un dump de base ne permet pas
//! de fabriquer des codes.
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp, hash_token, new_token};
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::sessions::{self, NewSession};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use guivault_crypto::SymmetricKey;
use guivault_protocol::{
    LoginResponse, TotpChallenge, TotpCodeRequest, TotpEnableResponse, TotpSetupResponse, TotpStatus,
    TotpVerifyRequest, UserProfile,
};
use sqlx::PgExecutor;
use std::net::IpAddr;
use totp_rs::{Algorithm, TOTP};
use uuid::Uuid;

const ISSUER: &str = "GuiVault";
const CHALLENGE_TTL_SECS: i64 = 300;
const MAX_CHALLENGE_ATTEMPTS: i32 = 5;
const RECOVERY_CODES: usize = 8;

fn totp_for(secret: Vec<u8>, email: &str) -> anyhow::Result<TOTP> {
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret,
        Some(ISSUER.into()),
        email.to_string(),
    )
    .map_err(|e| anyhow::anyhow!("paramètres TOTP invalides : {e}"))
}

fn seal_secret(key: &SymmetricKey, user_id: Uuid, secret: &[u8]) -> ApiResult<Vec<u8>> {
    Ok(guivault_crypto::seal(key, secret, user_id.as_bytes())?)
}

fn open_secret(key: &SymmetricKey, user_id: Uuid, blob: &[u8]) -> ApiResult<Vec<u8>> {
    guivault_crypto::open(key, blob, user_id.as_bytes())
        .map_err(|e| anyhow::anyhow!("secret TOTP de {user_id} illisible : {e}").into())
}

/// Un code de récupération : 10 caractères lisibles, en deux groupes.
fn new_recovery_code() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let bytes = guivault_crypto::random_bytes(10);
    let s: String = bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect();
    format!("{}-{}", &s[..5], &s[5..])
}

fn normalize_code(code: &str) -> String {
    code.trim().to_lowercase().replace([' ', '-'], "")
}

fn recovery_hash(state: &AppState, code: &str) -> Vec<u8> {
    // Salé par le secret serveur : un dump ne permet pas de tester des codes
    // hors ligne (l'espace de recherche est petit, 31^10).
    let mut input = state.config.secret.clone();
    input.extend_from_slice(b"\0recovery\0");
    input.extend_from_slice(normalize_code(code).as_bytes());
    guivault_crypto::token_hash(&input).to_vec()
}

#[derive(sqlx::FromRow)]
struct TotpRow {
    secret_enc: Vec<u8>,
    enabled: bool,
}

async fn totp_row<'e>(db: impl PgExecutor<'e>, user_id: Uuid) -> sqlx::Result<Option<TotpRow>> {
    sqlx::query_as("SELECT secret_enc, (enabled_at IS NOT NULL) AS enabled FROM user_totp WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
}

pub async fn is_enabled<'e>(db: impl PgExecutor<'e>, user_id: Uuid) -> sqlx::Result<bool> {
    Ok(totp_row(db, user_id).await?.is_some_and(|r| r.enabled))
}

/// Vérifie un code TOTP, ou consomme un code de récupération. Un code de
/// récupération fait 10 caractères, un TOTP 6 chiffres : pas d'ambiguïté.
async fn check_code(state: &AppState, user_id: Uuid, email: &str, code: &str) -> ApiResult<bool> {
    let normalized = normalize_code(code);
    if normalized.len() == 6 && normalized.chars().all(|c| c.is_ascii_digit()) {
        let Some(row) = totp_row(&state.db, user_id).await? else {
            return Ok(false);
        };
        let secret = open_secret(&state.config.totp_key, user_id, &row.secret_enc)?;
        let totp = totp_for(secret, email)?;
        return Ok(totp.check_current(&normalized).unwrap_or(false));
    }
    if normalized.len() == 10 {
        let res = sqlx::query(
            "UPDATE user_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
        )
        .bind(user_id)
        .bind(recovery_hash(state, &normalized))
        .execute(&state.db)
        .await?;
        return Ok(res.rows_affected() == 1);
    }
    Ok(false)
}

// ─── Gestion (authentifié) ──────────────────────────────────────────────────

pub async fn status(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<TotpStatus>> {
    Ok(Json(TotpStatus {
        enabled: is_enabled(&state.db, user.id).await?,
    }))
}

/// Génère un secret en attente. Tant que `enable` n'a pas confirmé un code,
/// il ne compte pas ; un nouveau `setup` le remplace.
pub async fn setup(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<TotpSetupResponse>> {
    if is_enabled(&state.db, user.id).await? {
        return Err(AppError::conflict(
            "totp_already_enabled",
            "le second facteur est déjà actif : le désactiver d'abord",
        ));
    }
    let secret = guivault_crypto::random_bytes(20);
    let totp = totp_for(secret.clone(), &user.email)?;
    sqlx::query(
        "INSERT INTO user_totp (user_id, secret_enc) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, created_at = now(), enabled_at = NULL",
    )
    .bind(user.id)
    .bind(seal_secret(&state.config.totp_key, user.id, &secret)?)
    .execute(&state.db)
    .await?;
    Ok(Json(TotpSetupResponse {
        secret: totp.get_secret_base32(),
        otpauth_url: totp.get_url(),
    }))
}

pub async fn enable(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Json(req): Json<TotpCodeRequest>,
) -> ApiResult<Json<TotpEnableResponse>> {
    let Some(row) = totp_row(&state.db, user.id).await? else {
        return Err(AppError::bad_request(
            "totp_not_setup",
            "appeler /auth/totp/setup d'abord",
        ));
    };
    if row.enabled {
        return Err(AppError::conflict(
            "totp_already_enabled",
            "le second facteur est déjà actif",
        ));
    }
    let secret = open_secret(&state.config.totp_key, user.id, &row.secret_enc)?;
    let totp = totp_for(secret, &user.email)?;
    if !totp.check_current(&normalize_code(&req.code)).unwrap_or(false) {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_code",
            "code incorrect — vérifier l'heure de l'appareil",
        ));
    }

    let codes: Vec<String> = (0..RECOVERY_CODES).map(|_| new_recovery_code()).collect();
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE user_totp SET enabled_at = now() WHERE user_id = $1")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = $1")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    for c in &codes {
        sqlx::query("INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)")
            .bind(user.id)
            .bind(recovery_hash(&state, c))
            .execute(&mut *tx)
            .await?;
    }
    // Les autres sessions ont été ouvertes sans second facteur.
    sqlx::query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL")
        .bind(user.id)
        .bind(user.session_id)
        .execute(&mut *tx)
        .await?;
    Audit::new("user.totp_enable")
        .actor(user.id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(TotpEnableResponse { recovery_codes: codes }))
}

pub async fn disable(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Json(req): Json<TotpCodeRequest>,
) -> ApiResult<StatusCode> {
    if !is_enabled(&state.db, user.id).await? {
        return Err(AppError::conflict(
            "totp_not_enabled",
            "le second facteur n'est pas actif",
        ));
    }
    if !check_code(&state, user.id, &user.email, &req.code).await? {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_code",
            "code incorrect",
        ));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM user_totp WHERE user_id = $1")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = $1")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    Audit::new("user.totp_disable")
        .actor(user.id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── Connexion en deux temps ────────────────────────────────────────────────

/// Après un mot de passe valide : un défi à échanger contre un code.
pub async fn issue_challenge<'e>(
    db: impl PgExecutor<'e>,
    user_id: Uuid,
    device_name: Option<String>,
    ip: Option<IpAddr>,
) -> ApiResult<TotpChallenge> {
    let token = new_token();
    sqlx::query(
        "INSERT INTO totp_challenges (token_hash, user_id, device_name, ip, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(device_name)
    .bind(ip)
    .bind(CHALLENGE_TTL_SECS as f64)
    .execute(db)
    .await?;
    Ok(TotpChallenge { totp_token: token })
}

#[derive(sqlx::FromRow)]
struct ChallengeRow {
    user_id: Uuid,
    device_name: Option<String>,
    attempts: i32,
}

pub async fn verify(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Json(req): Json<TotpVerifyRequest>,
) -> ApiResult<Json<LoginResponse>> {
    let token_hash = hash_token(&req.totp_token);
    let Some(ch) = sqlx::query_as::<_, ChallengeRow>(
        "SELECT user_id, device_name, attempts FROM totp_challenges WHERE token_hash = $1 AND expires_at > now()",
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await?
    else {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "challenge_expired",
            "recommencer la connexion",
        ));
    };
    if ch.attempts >= MAX_CHALLENGE_ATTEMPTS {
        sqlx::query("DELETE FROM totp_challenges WHERE token_hash = $1")
            .bind(&token_hash)
            .execute(&state.db)
            .await?;
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "challenge_expired",
            "trop d'essais, recommencer la connexion",
        ));
    }
    let user = db::user_by_id(&state.db, ch.user_id)
        .await?
        .ok_or_else(AppError::unauthorized)?;
    if !check_code(&state, user.id, &user.email, &req.code).await? {
        sqlx::query("UPDATE totp_challenges SET attempts = attempts + 1 WHERE token_hash = $1")
            .bind(&token_hash)
            .execute(&state.db)
            .await?;
        Audit::new("user.totp_failed")
            .actor(user.id)
            .ip(ip)
            .write(&state.db)
            .await?;
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_code",
            "code incorrect",
        ));
    }

    #[derive(sqlx::FromRow)]
    struct Blobs {
        protected_user_key: Vec<u8>,
        protected_private_key: Vec<u8>,
    }
    let blobs = sqlx::query_as::<_, Blobs>("SELECT protected_user_key, protected_private_key FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;

    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM totp_challenges WHERE token_hash = $1 OR expires_at < now()")
        .bind(&token_hash)
        .execute(&mut *tx)
        .await?;
    let (_, tokens) = sessions::create(
        &mut *tx,
        &state.config,
        NewSession {
            user_id: user.id,
            device_name: validate::device_name(ch.device_name),
            user_agent: headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()),
            ip,
        },
    )
    .await?;
    Audit::new("user.login")
        .actor(user.id)
        .ip(ip)
        .meta(serde_json::json!({ "totp": true }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(LoginResponse {
        tokens,
        user: UserProfile::from(user),
        protected_user_key: blobs.protected_user_key,
        protected_private_key: blobs.protected_private_key,
    }))
}
