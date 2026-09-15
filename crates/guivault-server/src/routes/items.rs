//! Items chiffrés d'un vault. Le serveur ne voit que des blobs et un type.
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::db::{self, ItemRow};
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use guivault_protocol::{Item, ItemsPage, PutItemRequest, Role};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct SinceQuery {
    /// Ne renvoyer que les items modifiés après cette révision du vault
    /// (pierres tombales comprises). Absent : tout, sans les tombales.
    pub since: Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vault_id): Path<Uuid>,
    Query(q): Query<SinceQuery>,
) -> ApiResult<Json<ItemsPage>> {
    let vault = db::vault_for_user(&state.db, user.id, vault_id).await?;
    let rows = match q.since {
        Some(since) => {
            sqlx::query_as::<_, ItemRow>("SELECT * FROM items WHERE vault_id = $1 AND revision > $2 ORDER BY revision")
                .bind(vault_id)
                .bind(since)
                .fetch_all(&state.db)
                .await?
        }
        None => {
            sqlx::query_as::<_, ItemRow>(
                "SELECT * FROM items WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY revision",
            )
            .bind(vault_id)
            .fetch_all(&state.db)
            .await?
        }
    };
    Ok(Json(ItemsPage {
        items: rows.into_iter().map(Into::into).collect(),
        revision: vault.revision,
    }))
}

pub async fn get(
    State(state): State<AppState>,
    user: AuthUser,
    Path((vault_id, item_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Item>> {
    db::vault_for_user(&state.db, user.id, vault_id).await?;
    let row =
        sqlx::query_as::<_, ItemRow>("SELECT * FROM items WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL")
            .bind(vault_id)
            .bind(item_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::not_found("item"))?;
    Ok(Json(row.into()))
}

/// Création ou mise à jour (l'id est choisi par le client : il fait partie de
/// l'AAD du chiffré, donc il doit être connu avant de chiffrer).
///
/// Verrou optimiste : `base_revision` doit être la révision courante de
/// l'item (`None` = l'item ne doit pas exister). Sinon 409 avec l'item
/// courant dans `current`, pour que le client fusionne et réessaie.
pub async fn put(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path((vault_id, item_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<PutItemRequest>,
) -> ApiResult<(StatusCode, Json<Item>)> {
    validate::item(&req.item_type, &req.ciphertext, state.config.max_item_bytes)?;
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;

    let mut tx = state.db.begin().await?;
    // Verrou sur la ligne du vault : sérialise les écrivains concurrents.
    sqlx::query("SELECT 1 FROM vaults WHERE id = $1 FOR UPDATE")
        .bind(vault_id)
        .execute(&mut *tx)
        .await?;

    let current = sqlx::query_as::<_, ItemRow>("SELECT * FROM items WHERE vault_id = $1 AND id = $2")
        .bind(vault_id)
        .bind(item_id)
        .fetch_optional(&mut *tx)
        .await?;

    let current_rev = current.as_ref().filter(|c| c.deleted_at.is_none()).map(|c| c.revision);
    if current_rev != req.base_revision {
        let body = current.map(Item::from);
        return Err(AppError::conflict(
            "revision_mismatch",
            "l'item a été modifié depuis votre dernière lecture",
        )
        .with_extra(serde_json::json!({ "current": body })));
    }
    if let Some(c) = &current
        && c.deleted_at.is_none()
        && c.item_type != req.item_type
    {
        // Le type est dans l'AAD : en changer sans re-chiffrer casserait le
        // déchiffrement chez tous les autres clients.
        return Err(AppError::bad_request(
            "item_type_changed",
            "le type d'un item ne peut pas changer",
        ));
    }

    let rev = db::bump_revision(&mut *tx, vault_id).await?;
    let created = current.as_ref().is_none_or(|c| c.deleted_at.is_some());
    let row = sqlx::query_as::<_, ItemRow>(
        "INSERT INTO items (id, vault_id, item_type, revision, ciphertext)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE
            SET item_type = EXCLUDED.item_type, revision = EXCLUDED.revision,
                ciphertext = EXCLUDED.ciphertext, updated_at = now(), deleted_at = NULL
         WHERE items.vault_id = EXCLUDED.vault_id
         RETURNING *",
    )
    .bind(item_id)
    .bind(vault_id)
    .bind(&req.item_type)
    .bind(rev)
    .bind(&req.ciphertext)
    .fetch_optional(&mut *tx)
    .await?
    // `WHERE items.vault_id = EXCLUDED.vault_id` : un id d'item déjà pris
    // par un autre vault ne doit pas pouvoir être « volé ».
    .ok_or_else(|| AppError::conflict("item_id_taken", "cet identifiant d'item existe dans un autre vault"))?;

    Audit::new(if created { "item.create" } else { "item.update" })
        .actor(user.id)
        .vault(vault_id)
        .target(item_id)
        .ip(ip)
        .meta(serde_json::json!({ "item_type": req.item_type, "revision": rev }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok((
        if created { StatusCode::CREATED } else { StatusCode::OK },
        Json(row.into()),
    ))
}

/// Suppression = pierre tombale (le chiffré est effacé, la ligne reste avec
/// une révision, pour que les autres clients la voient partir).
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path((vault_id, item_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT 1 FROM vaults WHERE id = $1 FOR UPDATE")
        .bind(vault_id)
        .execute(&mut *tx)
        .await?;
    let rev = db::bump_revision(&mut *tx, vault_id).await?;
    let res = sqlx::query(
        "UPDATE items SET deleted_at = now(), updated_at = now(), revision = $3, ciphertext = ''::bytea
         WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL",
    )
    .bind(vault_id)
    .bind(item_id)
    .bind(rev)
    .execute(&mut *tx)
    .await?;
    if res.rows_affected() == 0 {
        // Rien à supprimer : on annule aussi le bump de révision.
        tx.rollback().await?;
        return Err(AppError::not_found("item"));
    }
    Audit::new("item.delete")
        .actor(user.id)
        .vault(vault_id)
        .target(item_id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
