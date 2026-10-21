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
use guivault_protocol::{
    DeleteItemRequest, IMPORT_BATCH, ImportItemsRequest, ImportItemsResponse, Item, ItemsPage, PutItemRequest,
    PutManifestRequest, Role, ServerEvent, VaultManifest,
};
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
    db::vault_for_user(&state.db, user.id, vault_id).await?;
    Ok(Json(db::items_page(&state.db, vault_id, q.since).await?))
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

    let manifest = db::next_manifest(
        &db::locked_manifest(&mut tx, vault_id).await?,
        req.manifest.as_ref(),
        state.config.max_item_bytes,
    )?;

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

    let old_len = current
        .as_ref()
        .filter(|c| c.deleted_at.is_none())
        .map_or(0, |c| c.ciphertext.len());
    db::check_quota(
        &mut tx,
        state.config.quota_bytes,
        vault_id,
        item_id,
        old_len,
        req.ciphertext.len(),
    )
    .await?;

    // La version remplacée va dans l'historique.
    if let Some(c) = current.as_ref().filter(|c| c.deleted_at.is_none()) {
        db::keep_version(&mut tx, c, user.id, state.config.item_history).await?;
    }
    let rev = db::bump_revision(&mut *tx, vault_id).await?;
    let created = current.as_ref().is_none_or(|c| c.deleted_at.is_some());
    let row = sqlx::query_as::<_, ItemRow>(
        "INSERT INTO items (id, vault_id, item_type, revision, ciphertext)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vault_id, id) DO UPDATE
            SET item_type = EXCLUDED.item_type, revision = EXCLUDED.revision,
                ciphertext = EXCLUDED.ciphertext, updated_at = now(), deleted_at = NULL
         RETURNING *",
    )
    .bind(item_id)
    .bind(vault_id)
    .bind(&req.item_type)
    .bind(rev)
    .bind(&req.ciphertext)
    .fetch_one(&mut *tx)
    .await?;
    if let Some((blob, revision)) = &manifest {
        db::store_manifest(&mut tx, vault_id, blob, *revision).await?;
    }

    Audit::new(if created { "item.create" } else { "item.update" })
        .actor(user.id)
        .vault(vault_id)
        .target(item_id)
        .ip(ip)
        .meta(serde_json::json!({ "item_type": req.item_type, "revision": rev }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .events
        .vault(
            &state.db,
            vault_id,
            ServerEvent::VaultChanged {
                vault_id,
                revision: rev,
            },
        )
        .await?;

    Ok((
        if created { StatusCode::CREATED } else { StatusCode::OK },
        Json(row.into()),
    ))
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    /// L'item part vers un autre vault (même id) : ce n'est pas une
    /// suppression, il ne va pas dans la corbeille de celui-ci.
    #[serde(default)]
    pub moved: bool,
}

/// Suppression = pierre tombale (le chiffré est effacé, la ligne reste avec
/// une révision, pour que les autres clients la voient partir). La dernière
/// version va dans la corbeille (`routes::history`), sauf pour un
/// déplacement vers un autre vault.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path((vault_id, item_id)): Path<(Uuid, Uuid)>,
    Query(q): Query<DeleteQuery>,
    body: Option<Json<DeleteItemRequest>>,
) -> ApiResult<StatusCode> {
    let req = body.map(|Json(b)| b).unwrap_or_default();
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT 1 FROM vaults WHERE id = $1 FOR UPDATE")
        .bind(vault_id)
        .execute(&mut *tx)
        .await?;
    let Some(current) =
        sqlx::query_as::<_, ItemRow>("SELECT * FROM items WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL")
            .bind(vault_id)
            .bind(item_id)
            .fetch_optional(&mut *tx)
            .await?
    else {
        return Err(AppError::not_found("item"));
    };
    let manifest = db::next_manifest(
        &db::locked_manifest(&mut tx, vault_id).await?,
        req.manifest.as_ref(),
        state.config.max_item_bytes,
    )?;
    if let Some((blob, revision)) = &manifest {
        db::store_manifest(&mut tx, vault_id, blob, *revision).await?;
    }
    if !q.moved {
        db::keep_version(&mut tx, &current, user.id, state.config.item_history).await?;
    }
    let rev = db::bump_revision(&mut *tx, vault_id).await?;
    sqlx::query(
        "UPDATE items SET deleted_at = now(), updated_at = now(), revision = $3, ciphertext = ''::bytea
         WHERE vault_id = $1 AND id = $2",
    )
    .bind(vault_id)
    .bind(item_id)
    .bind(rev)
    .execute(&mut *tx)
    .await?;
    Audit::new(if q.moved { "item.move_out" } else { "item.delete" })
        .actor(user.id)
        .vault(vault_id)
        .target(item_id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .events
        .vault(
            &state.db,
            vault_id,
            ServerEvent::VaultChanged {
                vault_id,
                revision: rev,
            },
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── Import ─────────────────────────────────────────────────────────────────

/// Copie d'un vault venu d'ailleurs (coffre local, autre compte) : des items
/// avec leur historique et leur corbeille, **dates comprises** — ce que des
/// `PUT` rejoués perdraient. Réservé au propriétaire, et seulement pour des
/// ids que le vault n'a jamais eus : rien d'existant ne peut être réécrit, ni
/// son histoire changée. Chaque lot est une transaction ; un transfert coupé
/// reprend en n'envoyant que ce qui manque. Plus d'import une fois que le
/// vault a un manifeste (celui de la source arrive avec le dernier lot).
pub async fn import(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
    Json(req): Json<ImportItemsRequest>,
) -> ApiResult<Json<ImportItemsResponse>> {
    let max = state.config.max_item_bytes;
    if req.items.len() > IMPORT_BATCH {
        return Err(AppError::bad_request(
            "import_too_large",
            format!("au plus {IMPORT_BATCH} items par lot"),
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for it in &req.items {
        if !ids.insert(it.id) {
            return Err(AppError::bad_request(
                "invalid_import",
                "un item apparaît deux fois dans le lot",
            ));
        }
        if it.deleted_at.is_some() {
            // Un item de la corbeille n'existe que par sa dernière version.
            let Some(last) = it.versions.last() else {
                return Err(AppError::bad_request(
                    "invalid_import",
                    "un item de la corbeille sans version",
                ));
            };
            if !it.ciphertext.is_empty() || last.item_type != it.item_type {
                return Err(AppError::bad_request(
                    "invalid_import",
                    "item de la corbeille incohérent",
                ));
            }
        } else {
            validate::item(&it.item_type, &it.ciphertext, max)?;
        }
        for v in &it.versions {
            validate::item(&v.item_type, &v.ciphertext, max)?;
        }
    }
    if let Some(m) = &req.manifest {
        validate::manifest(&m.ciphertext, max)?;
        if m.revision < 1 {
            return Err(AppError::bad_request(
                "invalid_manifest",
                "révision de manifeste invalide",
            ));
        }
    }
    db::vault_with_role(&state.db, user.id, vault_id, Role::Owner).await?;

    let mut tx = state.db.begin().await?;
    let (mut rev,): (i64,) = sqlx::query_as("SELECT revision FROM vaults WHERE id = $1 FOR UPDATE")
        .bind(vault_id)
        .fetch_one(&mut *tx)
        .await?;
    if db::locked_manifest(&mut tx, vault_id).await?.0.is_some() {
        return Err(AppError::conflict(
            "import_closed",
            "ce vault a un manifeste : on n'y importe plus",
        ));
    }
    let wanted: Vec<Uuid> = req.items.iter().map(|it| it.id).collect();
    let existing: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM items WHERE vault_id = $1 AND id = ANY($2)")
        .bind(vault_id)
        .bind(&wanted)
        .fetch_all(&mut *tx)
        .await?;
    if !existing.is_empty() {
        let ids: Vec<Uuid> = existing.into_iter().map(|(id,)| id).collect();
        return Err(
            AppError::conflict("item_exists", "des items du lot existent déjà dans ce vault")
                .with_extra(serde_json::json!({ "items": ids })),
        );
    }
    let live: usize = req
        .items
        .iter()
        .filter(|it| it.deleted_at.is_none())
        .map(|it| it.ciphertext.len())
        .sum();
    db::check_quota(&mut tx, state.config.quota_bytes, vault_id, Uuid::nil(), 0, live).await?;

    // Comme `keep_version` : au plus `GUIVAULT_ITEM_HISTORY` versions par
    // item. Sans historique, pas de corbeille non plus.
    let keep = state.config.item_history;
    let (mut imported, mut versions) = (0usize, 0usize);
    for it in &req.items {
        if it.deleted_at.is_some() && keep == 0 {
            continue;
        }
        for v in &it.versions[it.versions.len().saturating_sub(keep)..] {
            rev += 1;
            sqlx::query(
                "INSERT INTO item_versions
                    (vault_id, item_id, revision, item_type, ciphertext, written_at, replaced_at, replaced_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(vault_id)
            .bind(it.id)
            .bind(rev)
            .bind(&v.item_type)
            .bind(&v.ciphertext)
            .bind(v.written_at)
            .bind(v.replaced_at)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
            versions += 1;
        }
        rev += 1;
        sqlx::query(
            "INSERT INTO items (id, vault_id, item_type, revision, ciphertext, created_at, updated_at, deleted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(it.id)
        .bind(vault_id)
        .bind(&it.item_type)
        .bind(rev)
        .bind(&it.ciphertext)
        .bind(it.created_at)
        .bind(it.updated_at)
        .bind(it.deleted_at)
        .execute(&mut *tx)
        .await?;
        imported += 1;
    }
    sqlx::query("UPDATE vaults SET revision = $2, updated_at = now() WHERE id = $1")
        .bind(vault_id)
        .bind(rev)
        .execute(&mut *tx)
        .await?;
    if let Some(m) = &req.manifest {
        db::store_manifest(&mut tx, vault_id, &m.ciphertext, m.revision).await?;
    }
    Audit::new("vault.import")
        .actor(user.id)
        .vault(vault_id)
        .ip(ip)
        .meta(serde_json::json!({ "items": imported, "versions": versions, "manifest": req.manifest.is_some() }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .events
        .vault(
            &state.db,
            vault_id,
            ServerEvent::VaultChanged {
                vault_id,
                revision: rev,
            },
        )
        .await?;
    Ok(Json(ImportItemsResponse {
        revision: rev,
        imported,
    }))
}

// ─── Manifeste ──────────────────────────────────────────────────────────────

/// Le manifeste courant, sans les items : de quoi écrire sans tout relire
/// (l'extension, une écriture après un conflit). `null` : pas de manifeste.
pub async fn get_manifest(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vault_id): Path<Uuid>,
) -> ApiResult<Json<Option<VaultManifest>>> {
    db::vault_for_user(&state.db, user.id, vault_id).await?;
    let (blob, revision): (Option<Vec<u8>>, i64) =
        sqlx::query_as("SELECT manifest, manifest_revision FROM vaults WHERE id = $1")
            .bind(vault_id)
            .fetch_one(&state.db)
            .await?;
    Ok(Json(blob.map(|ciphertext| VaultManifest { ciphertext, revision })))
}

/// Crée le manifeste d'un vault qui n'en a pas, ou le réécrit d'après ce que
/// sert le serveur (un membre qui prend acte d'un écart). Rien d'autre ne
/// change dans le vault ; sa révision monte pour que les autres clients
/// relisent et vérifient.
pub async fn put_manifest(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
    Json(req): Json<PutManifestRequest>,
) -> ApiResult<Json<VaultManifest>> {
    validate::manifest(&req.ciphertext, state.config.max_item_bytes)?;
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    let mut tx = state.db.begin().await?;
    let (revision,): (i64,) = sqlx::query_as("SELECT revision FROM vaults WHERE id = $1 FOR UPDATE")
        .bind(vault_id)
        .fetch_one(&mut *tx)
        .await?;
    if revision != req.vault_revision {
        return Err(AppError::conflict(
            "revision_mismatch",
            "le vault a changé depuis votre lecture : relire, puis recommencer",
        )
        .with_extra(serde_json::json!({ "current": revision })));
    }
    let current = db::locked_manifest(&mut tx, vault_id).await?;
    if req.base_revision != current.1 {
        return Err(db::manifest_conflict(&current));
    }
    let created = current.0.is_none();
    let next = current.1 + 1;
    db::store_manifest(&mut tx, vault_id, &req.ciphertext, next).await?;
    let rev = db::bump_revision(&mut *tx, vault_id).await?;
    Audit::new(if created {
        "vault.manifest_create"
    } else {
        "vault.manifest_rewrite"
    })
    .actor(user.id)
    .vault(vault_id)
    .ip(ip)
    .meta(serde_json::json!({ "manifest_revision": next }))
    .write(&mut *tx)
    .await?;
    tx.commit().await?;
    state
        .events
        .vault(
            &state.db,
            vault_id,
            ServerEvent::VaultChanged {
                vault_id,
                revision: rev,
            },
        )
        .await?;
    Ok(Json(VaultManifest {
        ciphertext: req.ciphertext,
        revision: next,
    }))
}
