//! Versions précédentes des items : l'historique d'un item et la corbeille
//! d'un vault. Des blobs chiffrés comme les items (même clé, même AAD) : le
//! serveur les garde sans les lire. Ils sont écrits par `routes::items`
//! (`db::keep_version`) ; restaurer une version, c'est la renvoyer telle
//! quelle par `PUT` — le client n'a rien à re-chiffrer.
//!
//! Rétention : `GUIVAULT_ITEM_HISTORY` versions par item,
//! `GUIVAULT_TRASH_DAYS` jours dans la corbeille (effacement horaire,
//! `lib::serve`, et filtre à la lecture).
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::db::{self, VersionRow};
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use guivault_protocol::{ItemVersion, Role, TrashedItem};
use uuid::Uuid;

/// L'historique d'un item, du plus récent au plus ancien.
pub async fn item_versions(
    State(state): State<AppState>,
    user: AuthUser,
    Path((vault_id, item_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Vec<ItemVersion>>> {
    db::vault_for_user(&state.db, user.id, vault_id).await?;
    let rows = sqlx::query_as::<_, VersionRow>(&format!(
        "{} WHERE v.vault_id = $1 AND v.item_id = $2 ORDER BY v.revision DESC",
        db::VERSION_SELECT
    ))
    .bind(vault_id)
    .bind(item_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

/// Toutes les versions d'un vault — ce qu'une rotation de clé doit
/// re-chiffrer (`RotateVaultKeyRequest::versions`).
pub async fn vault_versions(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vault_id): Path<Uuid>,
) -> ApiResult<Json<Vec<ItemVersion>>> {
    db::vault_for_user(&state.db, user.id, vault_id).await?;
    let rows = sqlx::query_as::<_, VersionRow>(&format!(
        "{} WHERE v.vault_id = $1 ORDER BY v.item_id, v.revision",
        db::VERSION_SELECT
    ))
    .bind(vault_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

#[derive(sqlx::FromRow)]
struct TrashRow {
    item_id: Uuid,
    item_type: String,
    revision: i64,
    ciphertext: Vec<u8>,
    deleted_at: DateTime<Utc>,
    deleted_by: Option<String>,
    expires_at: DateTime<Utc>,
}

/// La corbeille : les items supprimés depuis moins de `trash_days` jours (et
/// pas recréés depuis), chacun avec sa dernière version.
pub async fn trash(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vault_id): Path<Uuid>,
) -> ApiResult<Json<Vec<TrashedItem>>> {
    db::vault_for_user(&state.db, user.id, vault_id).await?;
    let rows = sqlx::query_as::<_, TrashRow>(
        "SELECT DISTINCT ON (v.item_id) v.item_id, v.item_type, v.revision, v.ciphertext,
                i.deleted_at AS deleted_at, u.email::text AS deleted_by,
                i.deleted_at + make_interval(days => $2) AS expires_at
         FROM item_versions v
         JOIN items i ON i.vault_id = v.vault_id AND i.id = v.item_id
         LEFT JOIN users u ON u.id = v.replaced_by
         WHERE v.vault_id = $1 AND i.deleted_at IS NOT NULL
           AND i.deleted_at > now() - make_interval(days => $2)
         ORDER BY v.item_id, v.revision DESC",
    )
    .bind(vault_id)
    .bind(state.config.trash_days as i32)
    .fetch_all(&state.db)
    .await?;
    let mut items: Vec<TrashedItem> = rows
        .into_iter()
        .map(|r| TrashedItem {
            item_id: r.item_id,
            item_type: r.item_type,
            revision: r.revision,
            ciphertext: r.ciphertext,
            deleted_at: r.deleted_at,
            deleted_by: r.deleted_by,
            expires_at: r.expires_at,
        })
        .collect();
    items.sort_by_key(|t| std::cmp::Reverse(t.deleted_at));
    Ok(Json(items))
}

/// Supprime définitivement un item de la corbeille (ses versions). Un item
/// vivant n'est pas dans la corbeille : 404.
pub async fn purge(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path((vault_id, item_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    let mut tx = state.db.begin().await?;
    let res = sqlx::query(
        "DELETE FROM item_versions v USING items i
         WHERE v.vault_id = $1 AND v.item_id = $2
           AND i.vault_id = v.vault_id AND i.id = v.item_id AND i.deleted_at IS NOT NULL",
    )
    .bind(vault_id)
    .bind(item_id)
    .execute(&mut *tx)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found("item"));
    }
    Audit::new("item.purge")
        .actor(user.id)
        .vault(vault_id)
        .target(item_id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Vide la corbeille du vault.
pub async fn empty_trash(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    let mut tx = state.db.begin().await?;
    let res = sqlx::query(
        "DELETE FROM item_versions v USING items i
         WHERE v.vault_id = $1 AND i.vault_id = v.vault_id AND i.id = v.item_id AND i.deleted_at IS NOT NULL",
    )
    .bind(vault_id)
    .execute(&mut *tx)
    .await?;
    Audit::new("trash.empty")
        .actor(user.id)
        .vault(vault_id)
        .ip(ip)
        .meta(serde_json::json!({ "versions": res.rows_affected() }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
