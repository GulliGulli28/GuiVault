//! Inscription, connexion, jetons, sessions, changement de mot de passe.
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::sessions::{self, NewSession};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use chrono::{DateTime, Utc};
use guivault_protocol::{
    ChangePasswordRequest, KdfParams, LoginRequest, LoginResponse, PreloginRequest, PreloginResponse, RefreshRequest,
    RegisterRequest, RegistrationMode, Session, TokenPair, UserProfile,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use uuid::Uuid;

fn user_agent(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok())
}

// ─── Prelogin ───────────────────────────────────────────────────────────────

/// Renvoie les paramètres Argon2id d'un e-mail. Pour un e-mail inconnu, un sel
/// déterministe (HMAC du secret serveur) et les paramètres par défaut : la
/// réponse est indiscernable de celle d'un compte réel, et stable d'un appel
/// à l'autre — sinon « le sel change à chaque fois » trahirait l'absence.
pub async fn prelogin(
    State(state): State<AppState>,
    Json(req): Json<PreloginRequest>,
) -> ApiResult<Json<PreloginResponse>> {
    let email = validate::normalize_email(&req.email)?;

    #[derive(sqlx::FromRow)]
    struct Row {
        kdf_m_cost: i32,
        kdf_t_cost: i32,
        kdf_p_cost: i32,
        kdf_salt: Vec<u8>,
    }
    let row = sqlx::query_as::<_, Row>(
        "SELECT kdf_m_cost, kdf_t_cost, kdf_p_cost, kdf_salt FROM users WHERE email = $1 AND disabled_at IS NULL",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(match row {
        Some(r) => PreloginResponse {
            kdf: KdfParams {
                m_cost: r.kdf_m_cost as u32,
                t_cost: r.kdf_t_cost as u32,
                p_cost: r.kdf_p_cost as u32,
            },
            kdf_salt: r.kdf_salt,
        },
        None => PreloginResponse {
            kdf: KdfParams::default(),
            kdf_salt: fake_salt(&state.config.secret, &email),
        },
    }))
}

fn fake_salt(secret: &[u8], email: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepte toute longueur de clé");
    mac.update(b"guivault/prelogin-salt\0");
    mac.update(email.as_bytes());
    mac.finalize().into_bytes()[..16].to_vec()
}

// ─── Inscription ────────────────────────────────────────────────────────────

pub async fn register(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Json(req): Json<RegisterRequest>,
) -> ApiResult<(StatusCode, Json<LoginResponse>)> {
    let email = validate::normalize_email(&req.email)?;
    validate::kdf(&req.kdf, &req.kdf_salt)?;
    validate::auth_key(&req.auth_key)?;
    validate::public_key(&req.public_key)?;
    validate::key_blob("protected_user_key", &req.protected_user_key)?;
    validate::key_blob("protected_private_key", &req.protected_private_key)?;
    validate::name_enc(&req.personal_vault.name_enc)?;
    validate::wrapped_vault_key(&req.personal_vault.wrapped_vault_key)?;

    let allowlisted = state.config.is_email_allowlisted(&email);
    match state.config.registration {
        RegistrationMode::Open => {}
        _ if allowlisted => {}
        RegistrationMode::Closed => {
            return Err(AppError::forbidden("les inscriptions sont fermées sur ce serveur"));
        }
        RegistrationMode::InviteOnly => {
            let invited = db::pending_invitations_for_email(&state.db, &email).await?;
            if invited.is_empty() {
                return Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "invitation_required",
                    "ce serveur n'accepte que les inscriptions sur invitation",
                ));
            }
        }
    }

    // Le hachage Argon2 est CPU-bound : hors du runtime async.
    let auth_key = req.auth_key.clone();
    let auth_hash = tokio::task::spawn_blocking(move || guivault_crypto::hash_auth_key(&auth_key))
        .await
        .map_err(|e| anyhow::anyhow!(e))??;

    let user_id = Uuid::new_v4();
    let vault_id = req.personal_vault.id;
    let mut tx = state.db.begin().await?;

    let inserted = sqlx::query(
        "INSERT INTO users (id, email, kdf_m_cost, kdf_t_cost, kdf_p_cost, kdf_salt, auth_hash,
                            protected_user_key, public_key, protected_private_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (email) DO NOTHING",
    )
    .bind(user_id)
    .bind(&email)
    .bind(req.kdf.m_cost as i32)
    .bind(req.kdf.t_cost as i32)
    .bind(req.kdf.p_cost as i32)
    .bind(&req.kdf_salt)
    .bind(&auth_hash)
    .bind(&req.protected_user_key)
    .bind(&req.public_key)
    .bind(&req.protected_private_key)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        // Même statut que les autres erreurs de validation : ne pas offrir
        // un oracle d'existence des comptes plus précis que nécessaire.
        return Err(AppError::conflict("email_taken", "cette adresse a déjà un compte"));
    }

    let vault_inserted =
        sqlx::query("INSERT INTO vaults (id, kind, name_enc) VALUES ($1, 'personal', $2) ON CONFLICT DO NOTHING")
            .bind(vault_id)
            .bind(&req.personal_vault.name_enc)
            .execute(&mut *tx)
            .await?;
    if vault_inserted.rows_affected() == 0 {
        return Err(AppError::conflict(
            "vault_id_taken",
            "cet identifiant de vault existe déjà",
        ));
    }
    sqlx::query(
        "INSERT INTO vault_members (vault_id, user_id, role, wrapped_vault_key, added_by)
         VALUES ($1, $2, 'owner', $3, $2)",
    )
    .bind(vault_id)
    .bind(user_id)
    .bind(&req.personal_vault.wrapped_vault_key)
    .execute(&mut *tx)
    .await?;

    let (_, tokens) = sessions::create(
        &mut *tx,
        &state.config,
        NewSession {
            user_id,
            device_name: validate::device_name(req.device_name),
            user_agent: user_agent(&headers),
            ip,
        },
    )
    .await?;

    Audit::new("user.register")
        .actor(user_id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(LoginResponse {
            tokens,
            user: UserProfile {
                id: user_id,
                email,
                public_key: req.public_key,
                created_at: Utc::now(),
            },
            protected_user_key: req.protected_user_key,
            protected_private_key: req.protected_private_key,
        }),
    ))
}

// ─── Connexion ──────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct LoginRow {
    id: Uuid,
    email: String,
    auth_hash: String,
    protected_user_key: Vec<u8>,
    public_key: Vec<u8>,
    protected_private_key: Vec<u8>,
    created_at: DateTime<Utc>,
}

/// Hash de référence vérifié quand l'e-mail est inconnu, pour que la réponse
/// prenne le même temps qu'un mauvais mot de passe sur un compte réel.
const DUMMY_HASH: &str =
    "$argon2id$v=19$m=19456,t=2,p=1$Z3VpdmF1bHQtZHVtbXktc2FsdA$0000000000000000000000000000000000000000000";

pub async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<LoginResponse>> {
    let email = validate::normalize_email(&req.email)?;
    validate::auth_key(&req.auth_key)?;

    let row = sqlx::query_as::<_, LoginRow>(
        "SELECT id, email::text AS email, auth_hash, protected_user_key, public_key, protected_private_key, created_at
         FROM users WHERE email = $1 AND disabled_at IS NULL",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;

    let phc = row
        .as_ref()
        .map(|r| r.auth_hash.clone())
        .unwrap_or_else(|| DUMMY_HASH.to_string());
    let auth_key = req.auth_key;
    let ok = tokio::task::spawn_blocking(move || guivault_crypto::verify_auth_key(&auth_key, &phc))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;

    let Some(row) = row.filter(|_| ok) else {
        Audit::new("user.login_failed")
            .target(&email)
            .ip(ip)
            .write(&state.db)
            .await?;
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "identifiants incorrects",
        ));
    };

    let mut tx = state.db.begin().await?;
    let (_, tokens) = sessions::create(
        &mut *tx,
        &state.config,
        NewSession {
            user_id: row.id,
            device_name: validate::device_name(req.device_name),
            user_agent: user_agent(&headers),
            ip,
        },
    )
    .await?;
    Audit::new("user.login").actor(row.id).ip(ip).write(&mut *tx).await?;
    tx.commit().await?;

    Ok(Json(LoginResponse {
        tokens,
        user: UserProfile {
            id: row.id,
            email: row.email,
            public_key: row.public_key,
            created_at: row.created_at,
        },
        protected_user_key: row.protected_user_key,
        protected_private_key: row.protected_private_key,
    }))
}

pub async fn refresh(State(state): State<AppState>, Json(req): Json<RefreshRequest>) -> ApiResult<Json<TokenPair>> {
    let (_, _, tokens) = sessions::refresh(&state.db, &state.config, &req.refresh_token).await?;
    Ok(Json(tokens))
}

pub async fn logout(State(state): State<AppState>, user: AuthUser, ClientIp(ip): ClientIp) -> ApiResult<StatusCode> {
    sqlx::query("UPDATE sessions SET revoked_at = now() WHERE id = $1")
        .bind(user.session_id)
        .execute(&state.db)
        .await?;
    Audit::new("user.logout").actor(user.id).ip(ip).write(&state.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── Sessions ───────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: Uuid,
    device_name: Option<String>,
    created_at: DateTime<Utc>,
    last_used_at: DateTime<Utc>,
}

pub async fn list_sessions(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<Session>>> {
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT id, device_name, created_at, last_used_at FROM sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND refresh_expires_at > now()
         ORDER BY last_used_at DESC",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| Session {
                current: r.id == user.session_id,
                id: r.id,
                device_name: r.device_name,
                created_at: r.created_at,
                last_used_at: r.last_used_at,
            })
            .collect(),
    ))
}

pub async fn revoke_session(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(session_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let res =
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL")
            .bind(session_id)
            .bind(user.id)
            .execute(&state.db)
            .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found("session"));
    }
    Audit::new("session.revoke")
        .actor(user.id)
        .target(session_id)
        .ip(ip)
        .write(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── Changement de mot de passe maître ──────────────────────────────────────

pub async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Json(req): Json<ChangePasswordRequest>,
) -> ApiResult<StatusCode> {
    validate::auth_key(&req.current_auth_key)?;
    validate::auth_key(&req.auth_key)?;
    validate::kdf(&req.kdf, &req.kdf_salt)?;
    validate::key_blob("protected_user_key", &req.protected_user_key)?;

    let (current_hash,): (String,) = sqlx::query_as("SELECT auth_hash FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    let current = req.current_auth_key;
    let new_key = req.auth_key;
    let (ok, new_hash) = tokio::task::spawn_blocking(move || {
        let ok = guivault_crypto::verify_auth_key(&current, &current_hash);
        (ok, guivault_crypto::hash_auth_key(&new_key))
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))?;
    if !ok {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "mot de passe actuel incorrect",
        ));
    }
    let new_hash = new_hash?;

    let mut tx = state.db.begin().await?;
    sqlx::query(
        "UPDATE users SET kdf_m_cost = $2, kdf_t_cost = $3, kdf_p_cost = $4, kdf_salt = $5,
                          auth_hash = $6, protected_user_key = $7, updated_at = now()
         WHERE id = $1",
    )
    .bind(user.id)
    .bind(req.kdf.m_cost as i32)
    .bind(req.kdf.t_cost as i32)
    .bind(req.kdf.p_cost as i32)
    .bind(&req.kdf_salt)
    .bind(&new_hash)
    .bind(&req.protected_user_key)
    .execute(&mut *tx)
    .await?;
    // Toutes les autres sessions tombent : un appareil volé ne survit pas au
    // changement de mot de passe.
    sqlx::query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL")
        .bind(user.id)
        .bind(user.session_id)
        .execute(&mut *tx)
        .await?;
    Audit::new("user.change_password")
        .actor(user.id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
