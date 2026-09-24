//! Vaults partagés et leurs membres.
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use guivault_protocol::{
    AddMemberRequest, CreateVaultRequest, RenameVaultRequest, Role, RotateVaultKeyRequest, ServerEvent,
    UpdateMemberRequest, Vault, VaultMember,
};
use uuid::Uuid;

pub async fn list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<Vault>>> {
    let rows = db::vaults_for_user(&state.db, user.id).await?;
    Ok(Json(rows.into_iter().map(db::VaultRow::into_proto).collect()))
}

pub async fn get(State(state): State<AppState>, user: AuthUser, Path(vault_id): Path<Uuid>) -> ApiResult<Json<Vault>> {
    Ok(Json(
        db::vault_for_user(&state.db, user.id, vault_id).await?.into_proto(),
    ))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Json(req): Json<CreateVaultRequest>,
) -> ApiResult<(StatusCode, Json<Vault>)> {
    validate::name_enc(&req.name_enc)?;
    validate::wrapped_vault_key(&req.wrapped_vault_key)?;
    let vault_id = req.id;
    let mut tx = state.db.begin().await?;
    let inserted =
        sqlx::query("INSERT INTO vaults (id, kind, name_enc) VALUES ($1, 'shared', $2) ON CONFLICT DO NOTHING")
            .bind(vault_id)
            .bind(&req.name_enc)
            .execute(&mut *tx)
            .await?;
    if inserted.rows_affected() == 0 {
        return Err(AppError::conflict(
            "vault_id_taken",
            "cet identifiant de vault existe déjà",
        ));
    }
    sqlx::query(
        "INSERT INTO vault_members (vault_id, user_id, role, wrapped_vault_key, added_by) VALUES ($1, $2, 'owner', $3, $2)",
    )
    .bind(vault_id)
    .bind(user.id)
    .bind(&req.wrapped_vault_key)
    .execute(&mut *tx)
    .await?;
    Audit::new("vault.create")
        .actor(user.id)
        .vault(vault_id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    let row = db::vault_for_user(&mut *tx, user.id, vault_id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row.into_proto())))
}

pub async fn rename(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
    Json(req): Json<RenameVaultRequest>,
) -> ApiResult<Json<Vault>> {
    validate::name_enc(&req.name_enc)?;
    db::vault_with_role(&state.db, user.id, vault_id, Role::Admin).await?;
    sqlx::query("UPDATE vaults SET name_enc = $2, updated_at = now() WHERE id = $1")
        .bind(vault_id)
        .bind(&req.name_enc)
        .execute(&state.db)
        .await?;
    Audit::new("vault.rename")
        .actor(user.id)
        .vault(vault_id)
        .ip(ip)
        .write(&state.db)
        .await?;
    Ok(Json(
        db::vault_for_user(&state.db, user.id, vault_id).await?.into_proto(),
    ))
}

/// Suppression définitive (items, membres, invitations en cascade). Le vault
/// personnel ne se supprime pas — il part avec le compte.
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let v = db::vault_with_role(&state.db, user.id, vault_id, Role::Owner).await?;
    if v.kind == "personal" {
        return Err(AppError::forbidden("le vault personnel ne peut pas être supprimé"));
    }
    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM vault_members WHERE vault_id = $1")
        .bind(vault_id)
        .fetch_all(&state.db)
        .await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM vaults WHERE id = $1")
        .bind(vault_id)
        .execute(&mut *tx)
        .await?;
    Audit::new("vault.delete")
        .actor(user.id)
        .vault(vault_id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    state.events.publish(
        members.into_iter().map(|(u,)| u).collect(),
        ServerEvent::MembershipChanged { vault_id },
    );
    Ok(StatusCode::NO_CONTENT)
}

// ─── Membres ────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct MemberRow {
    user_id: Uuid,
    email: String,
    public_key: Vec<u8>,
    role: String,
    added_at: DateTime<Utc>,
}

impl From<MemberRow> for VaultMember {
    fn from(r: MemberRow) -> Self {
        let fingerprint = guivault_crypto::PublicKey::try_from(r.public_key.as_slice())
            .map(|pk| guivault_crypto::fingerprint(&pk))
            .unwrap_or_default();
        VaultMember {
            user_id: r.user_id,
            email: r.email,
            public_key: r.public_key,
            fingerprint,
            role: Role::parse(&r.role).unwrap_or(Role::Reader),
            added_at: r.added_at,
        }
    }
}

pub async fn list_members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vault_id): Path<Uuid>,
) -> ApiResult<Json<Vec<VaultMember>>> {
    db::vault_for_user(&state.db, user.id, vault_id).await?;
    let rows = sqlx::query_as::<_, MemberRow>(
        "SELECT m.user_id, u.email::text AS email, u.public_key, m.role, m.added_at
         FROM vault_members m JOIN users u ON u.id = m.user_id
         WHERE m.vault_id = $1 ORDER BY m.added_at",
    )
    .bind(vault_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

fn ensure_shared(v: &db::VaultRow) -> ApiResult<()> {
    if v.kind == "personal" {
        return Err(AppError::forbidden("le vault personnel ne se partage pas"));
    }
    Ok(())
}

/// Un admin ne peut pas conférer un rôle supérieur au sien, ni toucher au
/// propriétaire.
fn ensure_can_grant(actor: Role, target: Role) -> ApiResult<()> {
    if target == Role::Owner {
        return Err(AppError::bad_request(
            "invalid_role",
            "la propriété se transfère, elle ne s'attribue pas",
        ));
    }
    if target > actor {
        return Err(AppError::forbidden("impossible d'attribuer un rôle supérieur au sien"));
    }
    Ok(())
}

pub async fn add_member(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
    Json(req): Json<AddMemberRequest>,
) -> ApiResult<(StatusCode, Json<VaultMember>)> {
    validate::wrapped_vault_key(&req.wrapped_vault_key)?;
    let v = db::vault_with_role(&state.db, user.id, vault_id, Role::Admin).await?;
    ensure_shared(&v)?;
    ensure_can_grant(v.role(), req.role)?;
    db::user_by_id(&state.db, req.user_id)
        .await?
        .ok_or_else(|| AppError::not_found("utilisateur"))?;

    let mut tx = state.db.begin().await?;
    let res = sqlx::query(
        "INSERT INTO vault_members (vault_id, user_id, role, wrapped_vault_key, added_by)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    )
    .bind(vault_id)
    .bind(req.user_id)
    .bind(req.role.as_str())
    .bind(&req.wrapped_vault_key)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::conflict("already_member", "déjà membre de ce vault"));
    }
    Audit::new("member.add")
        .actor(user.id)
        .vault(vault_id)
        .target(req.user_id)
        .ip(ip)
        .meta(serde_json::json!({ "role": req.role }))
        .write(&mut *tx)
        .await?;
    let row = sqlx::query_as::<_, MemberRow>(
        "SELECT m.user_id, u.email::text AS email, u.public_key, m.role, m.added_at
         FROM vault_members m JOIN users u ON u.id = m.user_id WHERE m.vault_id = $1 AND m.user_id = $2",
    )
    .bind(vault_id)
    .bind(req.user_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    state
        .events
        .publish(vec![req.user_id], ServerEvent::MembershipChanged { vault_id });
    Ok((StatusCode::CREATED, Json(row.into())))
}

pub async fn update_member(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path((vault_id, member_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateMemberRequest>,
) -> ApiResult<StatusCode> {
    let v = db::vault_with_role(&state.db, user.id, vault_id, Role::Admin).await?;
    ensure_shared(&v)?;
    ensure_can_grant(v.role(), req.role)?;
    if member_id == user.id {
        return Err(AppError::bad_request("self_update", "on ne change pas son propre rôle"));
    }
    let res =
        sqlx::query("UPDATE vault_members SET role = $3 WHERE vault_id = $1 AND user_id = $2 AND role <> 'owner'")
            .bind(vault_id)
            .bind(member_id)
            .bind(req.role.as_str())
            .execute(&state.db)
            .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found("membre"));
    }
    Audit::new("member.update")
        .actor(user.id)
        .vault(vault_id)
        .target(member_id)
        .ip(ip)
        .meta(serde_json::json!({ "role": req.role }))
        .write(&state.db)
        .await?;
    state
        .events
        .publish(vec![member_id], ServerEvent::MembershipChanged { vault_id });
    Ok(StatusCode::NO_CONTENT)
}

/// Retirer un membre. Sa clé enveloppée disparaît, mais il a pu copier la
/// clé du vault pendant qu'il y était : le client doit enchaîner sur une
/// rotation (`rotate_key`) pour que les futurs items lui soient illisibles.
pub async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path((vault_id, member_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    let v = db::vault_with_role(&state.db, user.id, vault_id, Role::Admin).await?;
    ensure_shared(&v)?;
    if member_id == user.id {
        return Err(AppError::bad_request(
            "self_remove",
            "utiliser /leave pour quitter un vault",
        ));
    }
    let res = sqlx::query("DELETE FROM vault_members WHERE vault_id = $1 AND user_id = $2 AND role <> 'owner'")
        .bind(vault_id)
        .bind(member_id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found("membre"));
    }
    Audit::new("member.remove")
        .actor(user.id)
        .vault(vault_id)
        .target(member_id)
        .ip(ip)
        .write(&state.db)
        .await?;
    state
        .events
        .publish(vec![member_id], ServerEvent::MembershipChanged { vault_id });
    Ok(StatusCode::NO_CONTENT)
}

pub async fn leave(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let v = db::vault_for_user(&state.db, user.id, vault_id).await?;
    ensure_shared(&v)?;
    if v.role() == Role::Owner {
        return Err(AppError::forbidden(
            "le propriétaire transfère la propriété ou supprime le vault",
        ));
    }
    sqlx::query("DELETE FROM vault_members WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Audit::new("member.leave")
        .actor(user.id)
        .vault(vault_id)
        .ip(ip)
        .write(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn transfer_ownership(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path((vault_id, member_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    let v = db::vault_with_role(&state.db, user.id, vault_id, Role::Owner).await?;
    ensure_shared(&v)?;
    let mut tx = state.db.begin().await?;
    // L'ancien propriétaire devient admin d'abord (index unique « un seul owner »).
    sqlx::query("UPDATE vault_members SET role = 'admin' WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    let res = sqlx::query("UPDATE vault_members SET role = 'owner' WHERE vault_id = $1 AND user_id = $2")
        .bind(vault_id)
        .bind(member_id)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        tx.rollback().await?;
        return Err(AppError::not_found("membre"));
    }
    Audit::new("vault.transfer")
        .actor(user.id)
        .vault(vault_id)
        .target(member_id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .events
        .publish(vec![member_id], ServerEvent::MembershipChanged { vault_id });
    Ok(StatusCode::NO_CONTENT)
}

// ─── Rotation de clé ────────────────────────────────────────────────────────

/// Remplace atomiquement la clé du vault : nouvelles enveloppes pour chaque
/// membre restant, tous les items re-chiffrés, nom re-chiffré. Le client
/// fournit tout ; le serveur vérifie que l'ensemble est complet (chaque
/// membre, chaque item vivant) et que personne n'a écrit entre-temps.
pub async fn rotate_key(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
    Json(req): Json<RotateVaultKeyRequest>,
) -> ApiResult<Json<Vault>> {
    validate::name_enc(&req.name_enc)?;
    for m in &req.members {
        validate::wrapped_vault_key(&m.wrapped_vault_key)?;
    }
    for it in &req.items {
        validate::item("x", &it.ciphertext, state.config.max_item_bytes)?;
    }
    for v in req.versions.iter().flatten() {
        validate::item("x", &v.ciphertext, state.config.max_item_bytes)?;
    }
    db::vault_with_role(&state.db, user.id, vault_id, Role::Admin).await?;

    let mut tx = state.db.begin().await?;
    let (revision,): (i64,) = sqlx::query_as("SELECT revision FROM vaults WHERE id = $1 FOR UPDATE")
        .bind(vault_id)
        .fetch_one(&mut *tx)
        .await?;
    if revision != req.base_revision {
        return Err(AppError::conflict(
            "revision_mismatch",
            "le vault a changé pendant la rotation, resynchroniser",
        ));
    }

    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM vault_members WHERE vault_id = $1")
        .bind(vault_id)
        .fetch_all(&mut *tx)
        .await?;
    let mut expected: std::collections::HashSet<Uuid> = members.into_iter().map(|(u,)| u).collect();
    for m in &req.members {
        if !expected.remove(&m.user_id) {
            return Err(AppError::bad_request(
                "unknown_member",
                format!("{} n'est pas membre", m.user_id),
            ));
        }
    }
    if !expected.is_empty() {
        return Err(AppError::bad_request(
            "incomplete_rotation",
            "il manque une enveloppe pour un membre",
        ));
    }

    let live: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM items WHERE vault_id = $1 AND deleted_at IS NULL")
        .bind(vault_id)
        .fetch_all(&mut *tx)
        .await?;
    let mut expected: std::collections::HashSet<Uuid> = live.into_iter().map(|(u,)| u).collect();
    for it in &req.items {
        if !expected.remove(&it.id) {
            return Err(AppError::bad_request(
                "unknown_item",
                format!("{} n'est pas un item vivant", it.id),
            ));
        }
    }
    if !expected.is_empty() {
        return Err(AppError::bad_request(
            "incomplete_rotation",
            "il manque un item re-chiffré",
        ));
    }

    let rev = db::bump_revision(&mut *tx, vault_id).await?;
    sqlx::query("UPDATE vaults SET name_enc = $2 WHERE id = $1")
        .bind(vault_id)
        .bind(&req.name_enc)
        .execute(&mut *tx)
        .await?;
    for m in &req.members {
        sqlx::query("UPDATE vault_members SET wrapped_vault_key = $3 WHERE vault_id = $1 AND user_id = $2")
            .bind(vault_id)
            .bind(m.user_id)
            .bind(&m.wrapped_vault_key)
            .execute(&mut *tx)
            .await?;
    }
    for it in &req.items {
        sqlx::query(
            "UPDATE items SET ciphertext = $3, revision = $4, updated_at = now() WHERE vault_id = $1 AND id = $2",
        )
        .bind(vault_id)
        .bind(it.id)
        .bind(&it.ciphertext)
        .bind(rev)
        .execute(&mut *tx)
        .await?;
    }
    // L'historique et la corbeille : re-chiffrés par le client, ou effacés
    // s'il ne sait pas le faire (client d'avant l'historique) — le serveur
    // ne garde pas de versions que plus personne ne saurait ouvrir. La
    // corbeille expirée part d'abord, pour que l'ensemble attendu ne dépende
    // pas du moment où l'effacement horaire est passé.
    db::prune_trash(&mut *tx, state.config.trash_days).await?;
    match &req.versions {
        None => {
            sqlx::query("DELETE FROM item_versions WHERE vault_id = $1")
                .bind(vault_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(sent) => {
            let stored: Vec<(Uuid, i64)> =
                sqlx::query_as("SELECT item_id, revision FROM item_versions WHERE vault_id = $1")
                    .bind(vault_id)
                    .fetch_all(&mut *tx)
                    .await?;
            let sent_keys: std::collections::HashSet<(Uuid, i64)> =
                sent.iter().map(|v| (v.item_id, v.revision)).collect();
            if stored.iter().any(|k| !sent_keys.contains(k)) {
                return Err(AppError::bad_request(
                    "incomplete_rotation",
                    "il manque une version précédente re-chiffrée",
                ));
            }
            // Celles qui ne sont plus là (expirées entre-temps) sont ignorées.
            for v in sent {
                sqlx::query(
                    "UPDATE item_versions SET ciphertext = $4 WHERE vault_id = $1 AND item_id = $2 AND revision = $3",
                )
                .bind(vault_id)
                .bind(v.item_id)
                .bind(v.revision)
                .bind(&v.ciphertext)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    // Les invitations en attente portaient l'ancienne clé : elles n'ouvrent
    // plus rien, l'inviteur les recrée.
    sqlx::query("UPDATE invitations SET status = 'revoked', resolved_at = now() WHERE vault_id = $1 AND status IN ('pending','awaiting_key')")
        .bind(vault_id)
        .execute(&mut *tx)
        .await?;

    Audit::new("vault.rotate_key")
        .actor(user.id)
        .vault(vault_id)
        .ip(ip)
        .meta(serde_json::json!({ "members": req.members.len(), "items": req.items.len(), "revision": rev }))
        .write(&mut *tx)
        .await?;
    let row = db::vault_for_user(&mut *tx, user.id, vault_id).await?;
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
    Ok(Json(row.into_proto()))
}
