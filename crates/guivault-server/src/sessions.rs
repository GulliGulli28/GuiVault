//! Création et rotation des sessions (jetons opaques, voir `auth.rs`).
use crate::auth::{hash_token, new_token};
use crate::config::Config;
use crate::error::AppError;
use guivault_protocol::TokenPair;
use sqlx::PgExecutor;
use std::net::IpAddr;
use uuid::Uuid;

pub struct NewSession<'a> {
    pub user_id: Uuid,
    pub device_name: Option<String>,
    pub user_agent: Option<&'a str>,
    pub ip: Option<IpAddr>,
}

pub async fn create<'e>(
    db: impl PgExecutor<'e>,
    config: &Config,
    s: NewSession<'_>,
) -> Result<(Uuid, TokenPair), AppError> {
    let access = new_token();
    let refresh = new_token();
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, access_token_hash, refresh_token_hash, device_name, user_agent, ip,
                               access_expires_at, refresh_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8, now() + $9)",
    )
    .bind(id)
    .bind(s.user_id)
    .bind(hash_token(&access))
    .bind(hash_token(&refresh))
    .bind(s.device_name)
    .bind(s.user_agent.map(|ua| ua.chars().take(256).collect::<String>()))
    .bind(s.ip)
    .bind(config.access_ttl)
    .bind(config.refresh_ttl)
    .execute(db)
    .await?;
    Ok((
        id,
        TokenPair {
            access_token: access,
            refresh_token: refresh,
            access_expires_in: config.access_ttl.as_secs(),
        },
    ))
}

#[derive(sqlx::FromRow)]
struct RefreshRow {
    id: Uuid,
    user_id: Uuid,
    matched_current: bool,
}

/// Rotation : le jeton de rafraîchissement présenté est remplacé. S'il
/// correspond au *précédent* (déjà tourné), quelqu'un rejoue un jeton volé :
/// la session est révoquée entière plutôt que de laisser l'un des deux
/// porteurs continuer.
pub async fn refresh<'e>(
    db: impl PgExecutor<'e> + Copy,
    config: &Config,
    refresh_token: &str,
) -> Result<(Uuid, Uuid, TokenPair), AppError> {
    let hash = hash_token(refresh_token);
    let row = sqlx::query_as::<_, RefreshRow>(
        "SELECT s.id, s.user_id, (s.refresh_token_hash = $1) AS matched_current
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE (s.refresh_token_hash = $1 OR s.prev_refresh_token_hash = $1)
           AND s.revoked_at IS NULL AND s.refresh_expires_at > now() AND u.disabled_at IS NULL",
    )
    .bind(&hash)
    .fetch_optional(db)
    .await?
    .ok_or_else(AppError::unauthorized)?;

    if !row.matched_current {
        tracing::warn!(session = %row.id, "réutilisation d'un jeton de rafraîchissement tourné — session révoquée");
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE id = $1")
            .bind(row.id)
            .execute(db)
            .await?;
        return Err(AppError::unauthorized());
    }

    let access = new_token();
    let refresh = new_token();
    sqlx::query(
        "UPDATE sessions SET prev_refresh_token_hash = refresh_token_hash,
                             refresh_token_hash = $2, access_token_hash = $3,
                             access_expires_at = now() + $4, refresh_expires_at = now() + $5,
                             last_used_at = now()
         WHERE id = $1",
    )
    .bind(row.id)
    .bind(hash_token(&refresh))
    .bind(hash_token(&access))
    .bind(config.access_ttl)
    .bind(config.refresh_ttl)
    .execute(db)
    .await?;

    Ok((
        row.id,
        row.user_id,
        TokenPair {
            access_token: access,
            refresh_token: refresh,
            access_expires_in: config.access_ttl.as_secs(),
        },
    ))
}
