//! Sessions à jetons opaques et extracteur `AuthUser`.
//!
//! Pas de JWT : un jeton d'accès est 32 octets aléatoires dont seul le SHA-256
//! est en base. Chaque requête coûte une lecture indexée, en échange de quoi
//! une révocation est immédiate (déconnexion à distance, changement de mot de
//! passe) et il n'y a ni clé de signature à gérer ni algorithme à confondre.
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::HeaderMap;
use axum::http::request::Parts;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::net::{IpAddr, SocketAddr};
use tower_governor::GovernorError;
use tower_governor::key_extractor::KeyExtractor;
use uuid::Uuid;

/// Jeton opaque : 32 octets aléatoires, base64url.
pub fn new_token() -> String {
    URL_SAFE_NO_PAD.encode(guivault_crypto::random_bytes(32))
}

pub fn hash_token(token: &str) -> Vec<u8> {
    guivault_crypto::token_hash(token.as_bytes()).to_vec()
}

/// L'utilisateur authentifié d'une requête. Extracteur axum : un handler qui
/// le prend en paramètre est protégé.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: Uuid,
    pub email: String,
    pub session_id: Uuid,
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    session_id: Uuid,
    user_id: Uuid,
    email: String,
    last_used_at: DateTime<Utc>,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer(&parts.headers).ok_or_else(AppError::unauthorized)?;
        let user = authenticate(&state.db, token).await?;
        Ok(user)
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then_some(token)
}

pub async fn authenticate(db: &PgPool, token: &str) -> Result<AuthUser, AppError> {
    let hash = hash_token(token);
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT s.id AS session_id, u.id AS user_id, u.email::text AS email, s.last_used_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.access_token_hash = $1
           AND s.revoked_at IS NULL
           AND s.access_expires_at > now()
           AND u.disabled_at IS NULL",
    )
    .bind(&hash)
    .fetch_optional(db)
    .await?
    .ok_or_else(AppError::unauthorized)?;

    // `last_used_at` sert à l'affichage des sessions : une précision à la
    // minute suffit, et ça évite une écriture par requête.
    if Utc::now() - row.last_used_at > chrono::Duration::seconds(60) {
        sqlx::query("UPDATE sessions SET last_used_at = now() WHERE id = $1")
            .bind(row.session_id)
            .execute(db)
            .await?;
    }

    Ok(AuthUser {
        id: row.user_id,
        email: row.email,
        session_id: row.session_id,
    })
}

// ─── IP cliente ─────────────────────────────────────────────────────────────

/// IP du client selon la politique `trust_proxy` : l'en-tête `X-Forwarded-For`
/// n'est lu que si le serveur est déclaré derrière un proxy de confiance.
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, trust_proxy: bool) -> Option<IpAddr> {
    if trust_proxy {
        let forwarded = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse::<IpAddr>().ok());
        if forwarded.is_some() {
            return forwarded;
        }
    }
    peer.map(|p| p.ip())
}

/// Extracteur axum de l'IP cliente (pour le journal d'audit).
#[derive(Debug, Clone, Copy)]
pub struct ClientIp(pub Option<IpAddr>);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        Ok(ClientIp(client_ip(&parts.headers, peer, state.config.trust_proxy)))
    }
}

/// Clé de rate-limit : la même IP que ci-dessus. Si aucune IP n'est trouvable
/// (ne devrait pas arriver avec `into_make_service_with_connect_info`), on
/// refuse plutôt que de partager un seau global.
#[derive(Debug, Clone, Copy)]
pub struct ClientIpKey {
    pub trust_proxy: bool,
}

impl KeyExtractor for ClientIpKey {
    type Key = IpAddr;

    fn extract<T>(&self, req: &axum::http::Request<T>) -> Result<Self::Key, GovernorError> {
        let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        client_ip(req.headers(), peer, self.trust_proxy).ok_or(GovernorError::UnableToExtractKey)
    }
}
