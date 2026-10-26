//! Le mode voyage (`docs/ARCHITECTURE.md`, « Mode voyage ») : avant de
//! passer une frontière, le compte ne garde sur ses appareils que les vaults
//! marqués « sûrs en voyage » — le filtre est dans `db::VAULT_SELECT`, par
//! lequel passe toute route d'un vault. Les autres reviennent quand on le
//! désactive, ce qui redemande le mot de passe maître.
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use guivault_protocol::{Role, TravelRequest, TravelStatus, Vault, VaultTravelRequest};
use uuid::Uuid;

pub async fn is_enabled<'e>(db: impl sqlx::PgExecutor<'e>, user_id: Uuid) -> sqlx::Result<bool> {
    let (on,): (bool,) = sqlx::query_as("SELECT travel_mode FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(db)
        .await?;
    Ok(on)
}

pub async fn status(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<TravelStatus>> {
    Ok(Json(TravelStatus {
        enabled: is_enabled(&state.db, user.id).await?,
    }))
}

pub async fn set(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Json(req): Json<TravelRequest>,
) -> ApiResult<Json<TravelStatus>> {
    if !req.enabled {
        // Le couper ramène tous les vaults : le mot de passe maître, comme
        // pour tout ce qui rouvre une porte.
        let auth_key = req
            .auth_key
            .ok_or_else(|| AppError::bad_request("invalid_request", "le mot de passe maître est requis"))?;
        validate::auth_key(&auth_key)?;
        let (hash,): (String,) = sqlx::query_as("SELECT auth_hash FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_one(&state.db)
            .await?;
        let ok = tokio::task::spawn_blocking(move || guivault_crypto::verify_auth_key(&auth_key, &hash))
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        if !ok {
            return Err(AppError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "mot de passe incorrect",
            ));
        }
    }
    let mut tx = state.db.begin().await?;
    let changed = sqlx::query("UPDATE users SET travel_mode = $2 WHERE id = $1 AND travel_mode <> $2")
        .bind(user.id)
        .bind(req.enabled)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0;
    if changed {
        Audit::new(if req.enabled {
            "user.travel_on"
        } else {
            "user.travel_off"
        })
        .actor(user.id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    if changed && !req.enabled {
        crate::mail::security(
            &state,
            &user.email,
            "Mode voyage désactivé sur votre compte GuiVault",
            "Le mode voyage vient d'être désactivé sur votre compte GuiVault : tous vos vaults reviennent sur vos \
             appareils à leur prochaine synchronisation.",
        );
    }
    Ok(Json(TravelStatus { enabled: req.enabled }))
}

/// Marquer un de ses vaults « sûr en voyage » (pour soi : chaque membre
/// choisit). En voyage, un vault non marqué est introuvable — on ne peut
/// donc pas le ré-exposer avant d'être rentré.
pub async fn set_vault(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
    Json(req): Json<VaultTravelRequest>,
) -> ApiResult<Json<Vault>> {
    db::vault_with_role(&state.db, user.id, vault_id, Role::Reader).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE vault_members SET travel_safe = $3 WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(user.id)
        .bind(req.safe)
        .execute(&mut *tx)
        .await?;
    Audit::new("vault.travel_safe")
        .actor(user.id)
        .vault(vault_id)
        .ip(ip)
        .meta(serde_json::json!({ "safe": req.safe }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    // Marqué non sûr en plein voyage : il disparaît, la réponse le dit.
    Ok(Json(
        db::vault_for_user(&state.db, user.id, vault_id).await?.into_proto(),
    ))
}
