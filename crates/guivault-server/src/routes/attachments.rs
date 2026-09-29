//! Pièces jointes (`docs/PIECES-JOINTES.md`) : des fichiers chiffrés en
//! morceaux par le client, sous une clé que seul l'item qui les porte connaît.
//! Le serveur garde les morceaux sans pouvoir les lire.
//!
//! Envoi en trois temps : annoncer (`POST`, taille et nombre de morceaux,
//! quota vérifié), envoyer chaque morceau (`PUT …/chunks/{index}`, corps
//! brut), terminer (`POST …/complete`, tout est arrivé). Une pièce jointe
//! incomplète n'est pas servie, et s'efface au bout d'un jour ([`prune`]).
//! Elle suit son item : effacée avec lui quand il quitte la corbeille,
//! déplacée avec lui vers un autre vault (`…/move`, sans rien re-chiffrer).
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use guivault_crypto::{ATTACHMENT_CHUNK, ATTACHMENT_CHUNK_OVERHEAD, attachment_chunk_count};
use guivault_protocol::{Attachment, CreateAttachmentRequest, MoveAttachmentRequest, Role};
use serde::Deserialize;
use sqlx::PgExecutor;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct AttachmentRow {
    vault_id: Uuid,
    id: Uuid,
    item_id: Uuid,
    size_bytes: i64,
    chunk_count: i32,
    complete: bool,
    created_at: DateTime<Utc>,
}

impl From<AttachmentRow> for Attachment {
    fn from(r: AttachmentRow) -> Self {
        Attachment {
            id: r.id,
            vault_id: r.vault_id,
            item_id: r.item_id,
            size: r.size_bytes,
            chunks: r.chunk_count,
            complete: r.complete,
            created_at: r.created_at,
        }
    }
}

const SELECT: &str = "SELECT vault_id, id, item_id, size_bytes, chunk_count, complete, created_at FROM attachments";

async fn fetch<'e>(db: impl PgExecutor<'e>, vault_id: Uuid, id: Uuid) -> ApiResult<AttachmentRow> {
    sqlx::query_as(&format!("{SELECT} WHERE vault_id = $1 AND id = $2"))
        .bind(vault_id)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("attachment"))
}

fn enabled(state: &AppState) -> ApiResult<u64> {
    match state.config.max_attachment_bytes {
        0 => Err(AppError::new(
            StatusCode::FORBIDDEN,
            "attachments_disabled",
            "les pièces jointes sont désactivées sur ce serveur",
        )),
        max => Ok(max),
    }
}

async fn item_is_live<'e>(db: impl PgExecutor<'e>, vault_id: Uuid, item_id: Uuid) -> ApiResult<()> {
    let found: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM items WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL")
            .bind(vault_id)
            .bind(item_id)
            .fetch_optional(db)
            .await?;
    found.map(|_| ()).ok_or_else(|| AppError::not_found("item"))
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub item_id: Option<Uuid>,
}

/// Les pièces jointes d'un vault (ou d'un item).
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vault_id): Path<Uuid>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<Attachment>>> {
    db::vault_for_user(&state.db, user.id, vault_id).await?;
    let rows: Vec<AttachmentRow> = sqlx::query_as(&format!(
        "{SELECT} WHERE vault_id = $1 AND ($2::uuid IS NULL OR item_id = $2) ORDER BY created_at"
    ))
    .bind(vault_id)
    .bind(q.item_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

/// Annonce une pièce jointe : sa taille chiffrée et son nombre de morceaux,
/// cohérents entre eux, sous la limite du serveur et le quota du
/// propriétaire du vault. L'item doit exister.
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
    Json(req): Json<CreateAttachmentRequest>,
) -> ApiResult<(StatusCode, Json<Attachment>)> {
    let max = enabled(&state)?;
    if req.size < 0 || req.size as u64 > max {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "attachment_too_large",
            format!("une pièce jointe ne peut dépasser {} Mio", max / (1024 * 1024)),
        ));
    }
    let overhead = i64::from(req.chunks) * ATTACHMENT_CHUNK_OVERHEAD as i64;
    let plain = req.size - overhead;
    if req.chunks < 1 || plain < 0 || attachment_chunk_count(plain as u64) as i64 != i64::from(req.chunks) {
        return Err(AppError::bad_request(
            "invalid_attachment",
            "taille et nombre de morceaux incohérents",
        ));
    }
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT 1 FROM vaults WHERE id = $1 FOR UPDATE")
        .bind(vault_id)
        .execute(&mut *tx)
        .await?;
    item_is_live(&mut *tx, vault_id, req.item_id).await?;
    db::check_quota(
        &mut tx,
        state.config.quota_bytes,
        vault_id,
        Uuid::nil(),
        0,
        req.size as usize,
    )
    .await?;
    let row: Option<AttachmentRow> = sqlx::query_as(
        "INSERT INTO attachments (vault_id, id, item_id, size_bytes, chunk_count, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING
         RETURNING vault_id, id, item_id, size_bytes, chunk_count, complete, created_at",
    )
    .bind(vault_id)
    .bind(req.id)
    .bind(req.item_id)
    .bind(req.size)
    .bind(req.chunks)
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Err(AppError::conflict(
            "attachment_exists",
            "cette pièce jointe existe déjà",
        ));
    };
    Audit::new("attachment.create")
        .actor(user.id)
        .vault(vault_id)
        .target(req.id)
        .ip(ip)
        .meta(serde_json::json!({ "item_id": req.item_id, "size": req.size }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row.into())))
}

/// Un morceau, corps brut. Réécrire un morceau déjà reçu le remplace (reprise
/// d'un envoi interrompu), tant que la pièce jointe n'est pas terminée.
pub async fn put_chunk(
    State(state): State<AppState>,
    user: AuthUser,
    Path((vault_id, id, index)): Path<(Uuid, Uuid, i32)>,
    body: Bytes,
) -> ApiResult<StatusCode> {
    enabled(&state)?;
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    let a = fetch(&state.db, vault_id, id).await?;
    if a.complete {
        return Err(AppError::conflict(
            "attachment_complete",
            "cette pièce jointe est déjà complète",
        ));
    }
    if index < 0 || index >= a.chunk_count {
        return Err(AppError::bad_request(
            "invalid_attachment",
            "morceau hors de la pièce jointe",
        ));
    }
    if body.len() < ATTACHMENT_CHUNK_OVERHEAD || body.len() > ATTACHMENT_CHUNK + ATTACHMENT_CHUNK_OVERHEAD {
        return Err(AppError::bad_request(
            "invalid_attachment",
            "taille de morceau invalide",
        ));
    }
    sqlx::query(
        "INSERT INTO attachment_chunks (vault_id, attachment_id, idx, ciphertext) VALUES ($1, $2, $3, $4)
         ON CONFLICT (vault_id, attachment_id, idx) DO UPDATE SET ciphertext = EXCLUDED.ciphertext",
    )
    .bind(vault_id)
    .bind(id)
    .bind(index)
    .bind(body.as_ref())
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Tous les morceaux sont là, et leur taille totale est celle annoncée.
pub async fn complete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((vault_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<Attachment>> {
    enabled(&state)?;
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    let mut tx = state.db.begin().await?;
    let a = fetch(&mut *tx, vault_id, id).await?;
    let (count, bytes): (i64, i64) = sqlx::query_as(
        "SELECT count(*), coalesce(sum(octet_length(ciphertext)), 0)::bigint
         FROM attachment_chunks WHERE vault_id = $1 AND attachment_id = $2",
    )
    .bind(vault_id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if count != i64::from(a.chunk_count) || bytes != a.size_bytes {
        return Err(AppError::conflict(
            "attachment_incomplete",
            format!("{count} morceau(x) sur {} reçus", a.chunk_count),
        ));
    }
    let row: AttachmentRow = sqlx::query_as(
        "UPDATE attachments SET complete = true WHERE vault_id = $1 AND id = $2
         RETURNING vault_id, id, item_id, size_bytes, chunk_count, complete, created_at",
    )
    .bind(vault_id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(row.into()))
}

/// Les octets d'un morceau d'une pièce jointe complète.
pub async fn chunk_bytes(db: &sqlx::PgPool, vault_id: Uuid, id: Uuid, index: i32) -> ApiResult<Response> {
    let a = fetch(db, vault_id, id).await?;
    if !a.complete {
        return Err(AppError::not_found("attachment"));
    }
    let (bytes,): (Vec<u8>,) = sqlx::query_as(
        "SELECT ciphertext FROM attachment_chunks WHERE vault_id = $1 AND attachment_id = $2 AND idx = $3",
    )
    .bind(vault_id)
    .bind(id)
    .bind(index)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("chunk"))?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

pub async fn get_chunk(
    State(state): State<AppState>,
    user: AuthUser,
    Path((vault_id, id, index)): Path<(Uuid, Uuid, i32)>,
) -> ApiResult<Response> {
    db::vault_for_user(&state.db, user.id, vault_id).await?;
    chunk_bytes(&state.db, vault_id, id, index).await
}

pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path((vault_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    let mut tx = state.db.begin().await?;
    let res = sqlx::query("DELETE FROM attachments WHERE vault_id = $1 AND id = $2")
        .bind(vault_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found("attachment"));
    }
    Audit::new("attachment.delete")
        .actor(user.id)
        .vault(vault_id)
        .target(id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Suivre un item déplacé : écrivain des deux côtés, l'item déjà arrivé
/// dans le vault de destination, le quota de son propriétaire vérifié.
pub async fn move_to(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path((vault_id, id)): Path<(Uuid, Uuid)>,
    Json(req): Json<MoveAttachmentRequest>,
) -> ApiResult<Json<Attachment>> {
    db::vault_with_role(&state.db, user.id, vault_id, Role::Writer).await?;
    db::vault_with_role(&state.db, user.id, req.vault_id, Role::Writer).await?;
    let mut tx = state.db.begin().await?;
    let a = fetch(&mut *tx, vault_id, id).await?;
    item_is_live(&mut *tx, req.vault_id, req.item_id).await?;
    if req.vault_id != vault_id {
        db::check_quota(
            &mut tx,
            state.config.quota_bytes,
            req.vault_id,
            Uuid::nil(),
            0,
            a.size_bytes as usize,
        )
        .await?;
    }
    let row: Option<AttachmentRow> = sqlx::query_as(
        "UPDATE attachments SET vault_id = $3, item_id = $4 WHERE vault_id = $1 AND id = $2
           AND NOT EXISTS (SELECT 1 FROM attachments WHERE vault_id = $3 AND id = $2 AND $3 <> $1)
         RETURNING vault_id, id, item_id, size_bytes, chunk_count, complete, created_at",
    )
    .bind(vault_id)
    .bind(id)
    .bind(req.vault_id)
    .bind(req.item_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Err(AppError::conflict(
            "attachment_exists",
            "cette pièce jointe existe déjà dans le vault de destination",
        ));
    };
    Audit::new("attachment.move")
        .actor(user.id)
        .vault(vault_id)
        .target(id)
        .ip(ip)
        .meta(serde_json::json!({ "to_vault": req.vault_id, "item_id": req.item_id }))
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(row.into()))
}

/// Effacement horaire (`lib::serve`) : les envois restés incomplets un jour,
/// et les pièces jointes dont l'item n'existe pas, ou a quitté la corbeille
/// (`trash_days`). Une pièce jointe d'un item supprimé reste le temps qu'il
/// peut être restauré.
pub async fn prune(db: &sqlx::PgPool, trash_days: u32) -> sqlx::Result<u64> {
    let res = sqlx::query(
        "DELETE FROM attachments a
         WHERE a.created_at < now() - interval '1 day'
           AND (NOT a.complete OR NOT EXISTS (
                SELECT 1 FROM items i
                WHERE i.vault_id = a.vault_id AND i.id = a.item_id
                  AND (i.deleted_at IS NULL OR i.deleted_at > now() - make_interval(days => $1))))",
    )
    .bind(trash_days as i32)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}
