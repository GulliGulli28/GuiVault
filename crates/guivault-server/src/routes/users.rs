use crate::audit::Audit;
use crate::auth::AuthUser;
use crate::db;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use guivault_protocol::{
    DeleteAccountRequest, PutUserSettingsRequest, ServerEvent, UserLookupResponse, UserProfile, UserSettings,
};
use serde::Deserialize;
use uuid::Uuid;

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

/// Supprime le compte et tout ce qui n'appartient qu'à lui : ses vaults (le
/// personnel, et les partagés dont il est le seul membre), ses sessions,
/// réglages, second facteur, liens de partage et accès d'urgence (dans les
/// deux sens). Le journal d'audit garde ses lignes — l'historique des vaults
/// des autres —, sans adresse IP ; l'e-mail disparaît avec le compte.
///
/// Refusé tant qu'il possède un vault partagé avec d'autres membres : ils
/// perdraient leur propriétaire. Transférer la propriété (ou supprimer le
/// vault) d'abord.
pub async fn delete_me(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<DeleteAccountRequest>,
) -> ApiResult<StatusCode> {
    validate::auth_key(&req.auth_key)?;
    let (hash,): (String,) = sqlx::query_as("SELECT auth_hash FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    let key = req.auth_key.clone();
    let ok = tokio::task::spawn_blocking(move || guivault_crypto::verify_auth_key(&key, &hash))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    if !ok {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "mot de passe incorrect",
        ));
    }
    if crate::routes::totp::is_enabled(&state.db, user.id).await? {
        let code = req
            .totp_code
            .as_deref()
            .ok_or_else(|| AppError::bad_request("totp_required", "code du second facteur requis"))?;
        if !crate::routes::totp::check_code(&state, user.id, &user.email, code).await? {
            return Err(AppError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_code",
                "code incorrect",
            ));
        }
    }

    delete_account(&state, user.id, &user.email, None, SharedVaults::Refuse).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Que faire des vaults partagés que le compte possède avec d'autres membres.
pub(crate) enum SharedVaults {
    /// Refuser (`409 owns_shared_vaults`) : le titulaire transfère lui-même.
    Refuse,
    /// Les donner à un autre membre — le mieux placé : compte actif, rôle le
    /// plus haut, le plus ancien. C'est ce que fait l'administrateur, qui ne
    /// peut pas demander au titulaire. Aucune clé à changer : l'héritier a
    /// déjà celle du vault.
    Transfer,
}

/// Supprime un compte (voir `delete_me`). `by_admin` : l'administrateur qui
/// le fait, et son IP, pour l'audit. Rend le nombre de vaults effacés.
pub(crate) async fn delete_account(
    state: &AppState,
    user_id: Uuid,
    email: &str,
    by_admin: Option<(Uuid, Option<std::net::IpAddr>)>,
    shared_vaults: SharedVaults,
) -> ApiResult<u64> {
    let mut tx = state.db.begin().await?;
    let blocking: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT m.vault_id FROM vault_members m JOIN vaults v ON v.id = m.vault_id
         WHERE m.user_id = $1 AND m.role = 'owner' AND v.kind = 'shared'
           AND EXISTS (SELECT 1 FROM vault_members o WHERE o.vault_id = m.vault_id AND o.user_id <> $1)",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    let blocking: Vec<Uuid> = blocking.into_iter().map(|(v,)| v).collect();
    let mut transferred = Vec::new();
    match shared_vaults {
        SharedVaults::Refuse if !blocking.is_empty() => {
            return Err(AppError::conflict(
                "owns_shared_vaults",
                "vous possédez des vaults partagés avec d'autres membres : transférez-en la propriété ou supprimez-les d'abord",
            )
            .with_extra(serde_json::json!({ "vaults": blocking })));
        }
        SharedVaults::Refuse => {}
        SharedVaults::Transfer => {
            for vault_id in blocking {
                let heir: Uuid = sqlx::query_scalar(
                    "SELECT m.user_id FROM vault_members m JOIN users u ON u.id = m.user_id
                     WHERE m.vault_id = $1 AND m.user_id <> $2
                     ORDER BY u.disabled_at IS NOT NULL,
                              CASE m.role WHEN 'admin' THEN 0 WHEN 'writer' THEN 1 ELSE 2 END,
                              m.added_at
                     LIMIT 1",
                )
                .bind(vault_id)
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await?;
                // L'ancien propriétaire d'abord (index « un seul owner »).
                sqlx::query("UPDATE vault_members SET role = 'admin' WHERE vault_id = $1 AND user_id = $2")
                    .bind(vault_id)
                    .bind(user_id)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("UPDATE vault_members SET role = 'owner' WHERE vault_id = $1 AND user_id = $2")
                    .bind(vault_id)
                    .bind(heir)
                    .execute(&mut *tx)
                    .await?;
                crate::routes::emergency::on_transfer(&mut tx, vault_id, user_id).await?;
                let (admin, ip) = by_admin.unwrap_or((user_id, None));
                Audit::new("vault.transfer")
                    .actor(admin)
                    .vault(vault_id)
                    .target(heir)
                    .ip(ip)
                    .meta(serde_json::json!({ "from": user_id, "account_deleted": true }))
                    .write(&mut *tx)
                    .await?;
                transferred.push(vault_id);
            }
        }
    }
    // Les membres des vaults partagés qu'il quitte : prévenus après coup.
    let shared: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT m.vault_id FROM vault_members m JOIN vaults v ON v.id = m.vault_id
         WHERE m.user_id = $1 AND m.role <> 'owner' AND v.kind = 'shared'",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await?;
    let owned = sqlx::query(
        "DELETE FROM vaults WHERE id IN (SELECT vault_id FROM vault_members WHERE user_id = $1 AND role = 'owner')",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    // Adressées à cette adresse : elles portent une clé pour ce compte-ci, et
    // ne vaudraient rien pour un compte recréé sous le même e-mail.
    sqlx::query(
        "UPDATE invitations SET status = 'revoked', resolved_at = now()
         WHERE invitee_email = $1 AND status IN ('pending', 'awaiting_key')",
    )
    .bind(email)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE audit_log SET ip = NULL WHERE actor_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    // Sans IP (ni e-mail) : c'est la dernière trace du compte.
    let meta = serde_json::json!({ "vaults_deleted": owned, "vaults_transferred": transferred });
    match by_admin {
        None => Audit::new("user.delete").actor(user_id).meta(meta),
        Some((admin, ip)) => Audit::new("admin.user_delete")
            .actor(admin)
            .target(user_id)
            .ip(ip)
            .meta(meta),
    }
    .write(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    for (vault_id,) in shared {
        state
            .events
            .vault(&state.db, vault_id, ServerEvent::MembershipChanged { vault_id })
            .await?;
    }
    tracing::info!(user = %user_id, vaults = owned, transferred = transferred.len(), "compte supprimé");
    Ok(owned)
}
