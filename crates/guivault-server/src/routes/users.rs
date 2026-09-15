use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{Query, State};
use guivault_protocol::{UserLookupResponse, UserProfile};
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
