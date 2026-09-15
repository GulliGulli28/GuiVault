//! Invitations à un vault partagé.
//!
//! Deux chemins selon que l'invité a déjà un compte :
//! - **déjà inscrit** : l'inviteur récupère sa clé publique (`/users/lookup`),
//!   vérifie l'empreinte, enveloppe la clé du vault → l'invitation porte la
//!   clé, l'invité accepte et devient membre aussitôt.
//! - **pas encore inscrit** : invitation sans clé. L'invité s'inscrit (ce qui
//!   passe en mode `invite_only`), accepte → `awaiting_key`. L'inviteur voit
//!   alors sa clé publique et complète (`/complete`) → membre.
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::db::{self, InvitationRow};
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use guivault_protocol::{CompleteInvitationRequest, CreateInvitationRequest, Invitation, Role};
use uuid::Uuid;

async fn fetch<'e>(db: impl sqlx::PgExecutor<'e>, id: Uuid) -> ApiResult<InvitationRow> {
    sqlx::query_as::<_, InvitationRow>(&format!("{} WHERE i.id = $1", db::INVITATION_SELECT))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("invitation"))
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(vault_id): Path<Uuid>,
    Json(req): Json<CreateInvitationRequest>,
) -> ApiResult<(StatusCode, Json<Invitation>)> {
    let email = validate::normalize_email(&req.email)?;
    if let Some(k) = &req.wrapped_vault_key {
        validate::wrapped_vault_key(k)?;
    }
    if req.role == Role::Owner {
        return Err(AppError::bad_request("invalid_role", "on n'invite pas un propriétaire"));
    }
    let v = db::vault_with_role(&state.db, user.id, vault_id, Role::Admin).await?;
    if v.kind == "personal" {
        return Err(AppError::forbidden("le vault personnel ne se partage pas"));
    }
    if req.role > v.role() {
        return Err(AppError::forbidden("impossible d'attribuer un rôle supérieur au sien"));
    }
    if email == user.email {
        return Err(AppError::bad_request("self_invite", "vous êtes déjà membre"));
    }

    let invitee = db::user_by_email(&state.db, &email).await?;
    if req.wrapped_vault_key.is_some() && invitee.is_none() {
        return Err(AppError::bad_request(
            "invitee_has_no_key",
            "cet utilisateur n'a pas de compte : inviter sans clé, puis compléter après son inscription",
        ));
    }
    if let Some(inv) = &invitee {
        let (already,): (bool,) =
            sqlx::query_as("SELECT EXISTS (SELECT 1 FROM vault_members WHERE vault_id = $1 AND user_id = $2)")
                .bind(vault_id)
                .bind(inv.id)
                .fetch_one(&state.db)
                .await?;
        if already {
            return Err(AppError::conflict("already_member", "déjà membre de ce vault"));
        }
    }

    let id = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    // Une invitation active par (vault, e-mail) — l'ancienne expirée est
    // nettoyée d'abord pour que l'index unique partiel ne bloque pas.
    sqlx::query(
        "UPDATE invitations SET status = 'expired', resolved_at = now()
         WHERE vault_id = $1 AND invitee_email = $2 AND status IN ('pending','awaiting_key') AND expires_at < now()",
    )
    .bind(vault_id)
    .bind(&email)
    .execute(&mut *tx)
    .await?;
    let res = sqlx::query(
        "INSERT INTO invitations (id, vault_id, inviter_user_id, invitee_email, role, wrapped_vault_key, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() + $7)
         ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(vault_id)
    .bind(user.id)
    .bind(&email)
    .bind(req.role.as_str())
    .bind(&req.wrapped_vault_key)
    .bind(state.config.invitation_ttl)
    .execute(&mut *tx)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::conflict(
            "already_invited",
            "une invitation est déjà en attente pour cette adresse",
        ));
    }
    Audit::new("invitation.create")
        .actor(user.id)
        .vault(vault_id)
        .target(&email)
        .ip(ip)
        .meta(serde_json::json!({ "role": req.role, "with_key": req.wrapped_vault_key.is_some() }))
        .write(&mut *tx)
        .await?;
    let row = fetch(&mut *tx, id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row.into())))
}

/// Toutes les invitations d'un vault (pour ses admins).
pub async fn list_for_vault(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vault_id): Path<Uuid>,
) -> ApiResult<Json<Vec<Invitation>>> {
    db::vault_with_role(&state.db, user.id, vault_id, Role::Admin).await?;
    let rows = sqlx::query_as::<_, InvitationRow>(&format!(
        "{} WHERE i.vault_id = $1 ORDER BY i.created_at DESC",
        db::INVITATION_SELECT
    ))
    .bind(vault_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

/// Mes invitations en attente (en tant qu'invité).
pub async fn list_mine(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<Invitation>>> {
    let rows = db::pending_invitations_for_email(&state.db, &user.email).await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

pub async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let inv = fetch(&state.db, id).await?;
    db::vault_with_role(&state.db, user.id, inv.vault_id, Role::Admin).await?;
    let res = sqlx::query(
        "UPDATE invitations SET status = 'revoked', resolved_at = now() WHERE id = $1 AND status IN ('pending','awaiting_key')",
    )
    .bind(id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::conflict(
            "not_pending",
            "cette invitation n'est plus en attente",
        ));
    }
    Audit::new("invitation.revoke")
        .actor(user.id)
        .vault(inv.vault_id)
        .target(id)
        .ip(ip)
        .write(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// L'invité accepte. Devient membre tout de suite si la clé est là, sinon
/// l'invitation passe en `awaiting_key` jusqu'à ce que l'inviteur complète.
pub async fn accept(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Invitation>> {
    let mut tx = state.db.begin().await?;
    let inv = fetch(&mut *tx, id).await?;
    if inv.invitee_email != user.email {
        return Err(AppError::not_found("invitation"));
    }
    if inv.status != "pending" {
        return Err(AppError::conflict(
            "not_pending",
            "cette invitation n'est plus en attente",
        ));
    }

    #[derive(sqlx::FromRow)]
    struct KeyRow {
        wrapped_vault_key: Option<Vec<u8>>,
        inviter_user_id: Uuid,
    }
    let key = sqlx::query_as::<_, KeyRow>(
        "SELECT wrapped_vault_key, inviter_user_id FROM invitations WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;

    match key.wrapped_vault_key {
        Some(wrapped) => {
            sqlx::query(
                "INSERT INTO vault_members (vault_id, user_id, role, wrapped_vault_key, added_by)
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
            )
            .bind(inv.vault_id)
            .bind(user.id)
            .bind(&inv.role)
            .bind(&wrapped)
            .bind(key.inviter_user_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("UPDATE invitations SET status = 'accepted', resolved_at = now() WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            Audit::new("invitation.accept")
                .actor(user.id)
                .vault(inv.vault_id)
                .target(id)
                .ip(ip)
                .write(&mut *tx)
                .await?;
        }
        None => {
            sqlx::query("UPDATE invitations SET status = 'awaiting_key' WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            Audit::new("invitation.accept_awaiting_key")
                .actor(user.id)
                .vault(inv.vault_id)
                .target(id)
                .ip(ip)
                .write(&mut *tx)
                .await?;
        }
    }
    let row = fetch(&mut *tx, id).await?;
    tx.commit().await?;
    Ok(Json(row.into()))
}

pub async fn decline(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let inv = fetch(&state.db, id).await?;
    if inv.invitee_email != user.email {
        return Err(AppError::not_found("invitation"));
    }
    let res = sqlx::query(
        "UPDATE invitations SET status = 'declined', resolved_at = now() WHERE id = $1 AND status IN ('pending','awaiting_key')",
    )
    .bind(id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::conflict(
            "not_pending",
            "cette invitation n'est plus en attente",
        ));
    }
    Audit::new("invitation.decline")
        .actor(user.id)
        .vault(inv.vault_id)
        .target(id)
        .ip(ip)
        .write(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// L'inviteur (ou un autre admin) fournit la clé enveloppée une fois que
/// l'invité a une clé publique. Si l'invité avait déjà accepté, il devient
/// membre immédiatement.
pub async fn complete(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
    Json(req): Json<CompleteInvitationRequest>,
) -> ApiResult<Json<Invitation>> {
    validate::wrapped_vault_key(&req.wrapped_vault_key)?;
    let mut tx = state.db.begin().await?;
    let inv = fetch(&mut *tx, id).await?;
    db::vault_with_role(&mut *tx, user.id, inv.vault_id, Role::Admin).await?;
    if inv.status != "pending" && inv.status != "awaiting_key" {
        return Err(AppError::conflict(
            "not_pending",
            "cette invitation n'est plus en attente",
        ));
    }
    let invitee = db::user_by_email(&mut *tx, &inv.invitee_email)
        .await?
        .ok_or_else(|| AppError::conflict("invitee_not_registered", "l'invité n'a pas encore de compte"))?;

    sqlx::query("UPDATE invitations SET wrapped_vault_key = $2 WHERE id = $1")
        .bind(id)
        .bind(&req.wrapped_vault_key)
        .execute(&mut *tx)
        .await?;
    if inv.status == "awaiting_key" {
        sqlx::query(
            "INSERT INTO vault_members (vault_id, user_id, role, wrapped_vault_key, added_by)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        )
        .bind(inv.vault_id)
        .bind(invitee.id)
        .bind(&inv.role)
        .bind(&req.wrapped_vault_key)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE invitations SET status = 'accepted', resolved_at = now() WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    Audit::new("invitation.complete")
        .actor(user.id)
        .vault(inv.vault_id)
        .target(id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    let row = fetch(&mut *tx, id).await?;
    tx.commit().await?;
    Ok(Json(row.into()))
}
