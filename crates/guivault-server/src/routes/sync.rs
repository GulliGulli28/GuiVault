use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use axum::Json;
use axum::extract::State;
use chrono::Utc;
use guivault_protocol::SyncResponse;

/// Un seul appel pour tout ce qui change entre deux lancements : le profil,
/// les vaults avec leur révision, les invitations en attente. Le client
/// compare les révisions à celles qu'il a en cache et ne télécharge que les
/// items des vaults qui ont bougé (`GET /vaults/{id}/items?since=`).
pub async fn sync(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<SyncResponse>> {
    let profile = db::user_by_id(&state.db, user.id)
        .await?
        .ok_or_else(AppError::unauthorized)?;
    let vaults = db::vaults_for_user(&state.db, user.id).await?;
    let invitations = db::pending_invitations_for_email(&state.db, &user.email).await?;
    Ok(Json(SyncResponse {
        user: profile.into(),
        vaults: vaults.into_iter().map(db::VaultRow::into_proto).collect(),
        invitations: invitations.into_iter().map(Into::into).collect(),
        server_time: Utc::now(),
    }))
}
