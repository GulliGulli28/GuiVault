use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{Query, State};
use chrono::{DateTime, Utc};
use guivault_protocol::{PutUserSettingsRequest, ServerEvent, UserLookupResponse, UserProfile, UserSettings};
use serde::Deserialize;

pub async fn me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<UserProfile>> {
    let row = db::user_by_id(&state.db, user.id)
        .await?
        .ok_or_else(AppError::unauthorized)?;
    Ok(Json(row.into()))
}

#[derive(Deserialize)]
pub struct LookupQuery {
    pub email: String,
}

/// Clé publique d'un utilisateur par e-mail, pour lui partager un vault.
/// Réservé aux utilisateurs authentifiés ; c'est un oracle d'existence des
/// comptes, assumé (comme chez Bitwarden) — un serveur d'équipe, pas un
/// service public. Le client affiche l'empreinte pour vérification hors
/// bande.
pub async fn lookup(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(q): Query<LookupQuery>,
) -> ApiResult<Json<UserLookupResponse>> {
    let email = validate::normalize_email(&q.email)?;
    let row = db::user_by_email(&state.db, &email)
        .await?
        .ok_or_else(|| AppError::not_found("utilisateur"))?;
    let pk = guivault_crypto::PublicKey::try_from(row.public_key.as_slice())
        .map_err(|_| anyhow::anyhow!("clé publique corrompue en base pour {}", row.id))?;
    Ok(Json(UserLookupResponse {
        id: row.id,
        email: row.email,
        fingerprint: guivault_crypto::fingerprint(&pk),
        public_key: row.public_key,
    }))
}

#[derive(sqlx::FromRow)]
struct SettingsRow {
    blob: Vec<u8>,
    revision: i64,
    updated_at: DateTime<Utc>,
}

impl From<SettingsRow> for UserSettings {
    fn from(r: SettingsRow) -> Self {
        UserSettings {
            blob: r.blob,
            revision: r.revision,
            updated_at: r.updated_at,
        }
    }
}

/// Les réglages synchronisés, ou `null` si aucun appareil n'en a encore
/// envoyé.
pub async fn get_settings(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Option<UserSettings>>> {
    let row =
        sqlx::query_as::<_, SettingsRow>("SELECT blob, revision, updated_at FROM user_settings WHERE user_id = $1")
            .bind(user.id)
            .fetch_optional(&state.db)
            .await?;
    Ok(Json(row.map(Into::into)))
}

/// Remplace les réglages. Pas de ligne d'audit : ce n'est pas une action
/// sensible (un blob opaque que seul l'utilisateur relit), et chaque
/// réglage d'apparence en écrirait une. Les autres appareils sont prévenus.
pub async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<PutUserSettingsRequest>,
) -> ApiResult<Json<UserSettings>> {
    validate::settings_blob(&req.blob)?;
    let mut tx = state.db.begin().await?;
    let current = sqlx::query_as::<_, SettingsRow>(
        "SELECT blob, revision, updated_at FROM user_settings WHERE user_id = $1 FOR UPDATE",
    )
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    if current.as_ref().map(|c| c.revision) != req.base_revision {
        return Err(AppError::conflict(
            "revision_mismatch",
            "les réglages ont été modifiés depuis votre dernière lecture",
        )
        .with_extra(serde_json::json!({ "current": current.map(UserSettings::from) })));
    }
    let row = sqlx::query_as::<_, SettingsRow>(
        "INSERT INTO user_settings (user_id, blob, revision) VALUES ($1, $2, 1)
         ON CONFLICT (user_id) DO UPDATE
            SET blob = EXCLUDED.blob, revision = user_settings.revision + 1, updated_at = now()
         RETURNING blob, revision, updated_at",
    )
    .bind(user.id)
    .bind(&req.blob)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    state
        .events
        .publish(vec![user.id], ServerEvent::SettingsChanged { revision: row.revision });
    Ok(Json(row.into()))
}
