//! Connexion par passkey (`docs/PASSKEYS.md`). Une passkey enregistrée depuis
//! une session — mot de passe maître redemandé — garde, à côté de sa clé
//! publique, la user key enveloppée sous une clé que seule la PRF de
//! l'authentificateur donne. Se connecter avec elle : le serveur vérifie la
//! signature WebAuthn (`crate::webauthn`, utilisateur vérifié exigé), ouvre une
//! session comme `/auth/login` et rend l'enveloppe. Pas de second facteur en
//! plus : la passkey (possession + code ou biométrie) en tient lieu.
//!
//! Proposée seulement si `GUIVAULT_PUBLIC_URL` est réglé : il fixe le site
//! (identifiant WebAuthn) et l'origine acceptée.
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::error::{ApiResult, AppError};
use crate::sessions::{self, NewSession};
use crate::state::AppState;
use crate::validate;
use crate::webauthn::{self, RelyingParty};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use base64::Engine;
use chrono::{DateTime, Utc};
use guivault_protocol::{
    LoginResponse, PasskeyInfo, PasskeyLoginOptions, PasskeyLoginRequest, PasskeyLoginResponse,
    PasskeyRegistrationOptions, PasskeyRegistrationRequest, UserProfile,
};
use uuid::Uuid;

/// Un défi vit cinq minutes : le temps de toucher une clé ou de poser un doigt.
const CHALLENGE_SECS: f64 = 300.0;
/// De quoi ne pas remplir la table d'un compte.
const MAX_PER_USER: i64 = 20;

fn relying_party(state: &AppState) -> ApiResult<&RelyingParty> {
    state.config.passkeys.as_ref().ok_or_else(|| {
        AppError::new(
            StatusCode::FORBIDDEN,
            "passkeys_disabled",
            "la connexion par passkey n'est pas configurée sur ce serveur (GUIVAULT_PUBLIC_URL)",
        )
    })
}

async fn new_challenge(state: &AppState, user_id: Option<Uuid>, purpose: &str) -> ApiResult<(Uuid, Vec<u8>)> {
    let id = Uuid::new_v4();
    let challenge = guivault_crypto::SymmetricKey::random().as_bytes().to_vec();
    sqlx::query("DELETE FROM webauthn_challenges WHERE expires_at < now()")
        .execute(&state.db)
        .await?;
    sqlx::query(
        "INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    )
    .bind(id)
    .bind(user_id)
    .bind(purpose)
    .bind(&challenge)
    .bind(CHALLENGE_SECS)
    .execute(&state.db)
    .await?;
    Ok((id, challenge))
}

/// Le défi, consommé (à usage unique), s'il est encore valable.
async fn take_challenge(state: &AppState, id: Uuid, user_id: Option<Uuid>, purpose: &str) -> ApiResult<Vec<u8>> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        "DELETE FROM webauthn_challenges
         WHERE id = $1 AND purpose = $2 AND user_id IS NOT DISTINCT FROM $3 AND expires_at > now()
         RETURNING challenge",
    )
    .bind(id)
    .bind(purpose)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    row.map(|(c,)| c)
        .ok_or_else(|| AppError::bad_request("invalid_challenge", "défi inconnu ou expiré : recommencez"))
}

fn rejected(e: webauthn::WebauthnError) -> AppError {
    AppError::bad_request("invalid_passkey", e.to_string())
}

pub async fn register_start(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<PasskeyRegistrationOptions>> {
    let rp = relying_party(&state)?.clone();
    let (email,): (String,) = sqlx::query_as("SELECT email::text FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    let existing: Vec<(Vec<u8>,)> = sqlx::query_as("SELECT credential_id FROM passkeys WHERE user_id = $1")
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;
    let (challenge_id, challenge) = new_challenge(&state, Some(user.id), "register").await?;
    Ok(Json(PasskeyRegistrationOptions {
        challenge_id,
        challenge,
        rp_id: rp.id,
        rp_name: rp.name,
        user_handle: user.id.as_bytes().to_vec(),
        user_name: email,
        exclude: existing
            .into_iter()
            .map(|(id,)| base64::engine::general_purpose::STANDARD.encode(id))
            .collect(),
        prf_salt: guivault_crypto::passkey_prf_salt().to_vec(),
    }))
}

pub async fn register(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Json(req): Json<PasskeyRegistrationRequest>,
) -> ApiResult<(StatusCode, Json<PasskeyInfo>)> {
    let rp = relying_party(&state)?.clone();
    validate::auth_key(&req.auth_key)?;
    validate::key_blob("protected_user_key", &req.protected_user_key)?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::bad_request("invalid_name", "un nom de 1 à 100 caractères"));
    }
    // Le mot de passe maître, comme pour tout ce qui ouvre une porte.
    let (hash,): (String,) = sqlx::query_as("SELECT auth_hash FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    let key = req.auth_key.clone();
    let ok = tokio::task::spawn_blocking(move || guivault_crypto::verify_auth_key(&key, &hash))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    if !ok {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "mot de passe incorrect",
        ));
    }
    let challenge = take_challenge(&state, req.challenge_id, Some(user.id), "register").await?;
    let cred = webauthn::verify_registration(&rp, &challenge, &req.client_data_json, &req.attestation_object)
        .map_err(rejected)?;
    if cred.id != req.credential_id {
        return Err(rejected(webauthn::WebauthnError::Format(
            "identifiant de passkey incohérent",
        )));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM passkeys WHERE user_id = $1")
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= MAX_PER_USER {
        return Err(AppError::conflict(
            "too_many_passkeys",
            format!("{MAX_PER_USER} passkeys au plus par compte"),
        ));
    }
    let id = Uuid::new_v4();
    let row: Option<(DateTime<Utc>,)> = sqlx::query_as(
        "INSERT INTO passkeys (id, user_id, credential_id, public_key, sign_count, name, protected_user_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING created_at",
    )
    .bind(id)
    .bind(user.id)
    .bind(&cred.id)
    .bind(&cred.public_key)
    .bind(i64::from(cred.sign_count))
    .bind(name)
    .bind(&req.protected_user_key)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((created_at,)) = row else {
        return Err(AppError::conflict(
            "passkey_exists",
            "cette passkey est déjà enregistrée",
        ));
    };
    Audit::new("passkey.add")
        .actor(user.id)
        .target(id)
        .ip(ip)
        .meta(serde_json::json!({ "name": name }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(PasskeyInfo {
            id,
            name: name.to_string(),
            created_at,
            last_used_at: None,
        }),
    ))
}

#[derive(sqlx::FromRow)]
struct PasskeyRow {
    id: Uuid,
    name: String,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
}

pub async fn list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<PasskeyInfo>>> {
    let rows = sqlx::query_as::<_, PasskeyRow>(
        "SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| PasskeyInfo {
                id: r.id,
                name: r.name,
                created_at: r.created_at,
                last_used_at: r.last_used_at,
            })
            .collect(),
    ))
}

pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let mut tx = state.db.begin().await?;
    let res = sqlx::query("DELETE FROM passkeys WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found("passkey"));
    }
    Audit::new("passkey.delete")
        .actor(user.id)
        .target(id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Public (freiné par IP) : un défi de connexion.
pub async fn login_start(State(state): State<AppState>) -> ApiResult<Json<PasskeyLoginOptions>> {
    let rp = relying_party(&state)?.clone();
    let (challenge_id, challenge) = new_challenge(&state, None, "login").await?;
    Ok(Json(PasskeyLoginOptions {
        challenge_id,
        challenge,
        rp_id: rp.id,
        prf_salt: guivault_crypto::passkey_prf_salt().to_vec(),
    }))
}

#[derive(sqlx::FromRow)]
struct PasskeyUserRow {
    passkey_id: Uuid,
    public_key: Vec<u8>,
    sign_count: i64,
    passkey_user_key: Vec<u8>,
    id: Uuid,
    email: String,
    public_key_user: Vec<u8>,
    protected_user_key: Vec<u8>,
    protected_private_key: Vec<u8>,
    created_at: DateTime<Utc>,
    is_admin: bool,
    disabled: bool,
}

/// Public (freiné par IP) : la signature de la passkey contre une session.
pub async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Json(req): Json<PasskeyLoginRequest>,
) -> ApiResult<Json<PasskeyLoginResponse>> {
    let rp = relying_party(&state)?.clone();
    let challenge = take_challenge(&state, req.challenge_id, None, "login").await?;
    let row = sqlx::query_as::<_, PasskeyUserRow>(
        "SELECT p.id AS passkey_id, p.public_key, p.sign_count, p.protected_user_key AS passkey_user_key,
                u.id, u.email::text AS email, u.public_key AS public_key_user, u.protected_user_key,
                u.protected_private_key, u.created_at, u.is_admin, u.disabled_at IS NOT NULL AS disabled
         FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = $1",
    )
    .bind(&req.credential_id)
    .fetch_optional(&state.db)
    .await?;
    let refused = || {
        AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "passkey inconnue ou refusée",
        )
    };
    let Some(row) = row else {
        Audit::new("user.login_failed")
            .ip(ip)
            .meta(serde_json::json!({ "passkey": "inconnue" }))
            .write(&state.db)
            .await?;
        return Err(refused());
    };
    let count = match webauthn::verify_assertion(
        &rp,
        &challenge,
        &row.public_key,
        row.sign_count.clamp(0, u32::MAX as i64) as u32,
        &req.client_data_json,
        &req.authenticator_data,
        &req.signature,
    ) {
        Ok(c) => c,
        Err(e) => {
            Audit::new("user.login_failed")
                .actor(row.id)
                .target(row.passkey_id)
                .ip(ip)
                .meta(serde_json::json!({ "passkey": e.to_string() }))
                .write(&state.db)
                .await?;
            return Err(refused());
        }
    };
    if row.disabled {
        Audit::new("user.login_disabled")
            .actor(row.id)
            .ip(ip)
            .write(&state.db)
            .await?;
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "account_disabled",
            "ce compte a été désactivé par un administrateur du serveur",
        ));
    }
    let device = validate::device_name(req.device_name);
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE passkeys SET sign_count = $2, last_used_at = now() WHERE id = $1")
        .bind(row.passkey_id)
        .bind(i64::from(count))
        .execute(&mut *tx)
        .await?;
    let (_, tokens) = sessions::create(
        &mut *tx,
        &state.config,
        NewSession {
            user_id: row.id,
            device_name: device.clone(),
            user_agent: super::auth::user_agent(&headers),
            ip,
        },
    )
    .await?;
    Audit::new("user.login")
        .actor(row.id)
        .target(row.passkey_id)
        .ip(ip)
        .meta(serde_json::json!({ "method": "passkey" }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::mail::login_alert(
        &state,
        row.id,
        &row.email,
        ip,
        device.as_deref(),
        super::auth::user_agent(&headers),
    )
    .await;
    Ok(Json(PasskeyLoginResponse {
        login: LoginResponse {
            tokens,
            user: UserProfile {
                id: row.id,
                email: row.email,
                public_key: row.public_key_user,
                created_at: row.created_at,
                is_admin: row.is_admin,
            },
            protected_user_key: row.protected_user_key,
            protected_private_key: row.protected_private_key,
        },
        passkey_user_key: row.passkey_user_key,
    }))
}
