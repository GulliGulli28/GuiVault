//! Lecture du journal d'audit.
use crate::auth::AuthUser;
use crate::db;
use crate::error::ApiResult;
use crate::state::AppState;
use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use guivault_protocol::Role;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct AuditQuery {
    pub limit: Option<i64>,
    /// Curseur : renvoyer les entrées d'id strictement inférieur.
    pub before: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AuditEntry {
    pub id: i64,
    pub at: DateTime<Utc>,
    pub actor_id: Option<Uuid>,
    pub actor_email: Option<String>,
    pub vault_id: Option<Uuid>,
    pub action: String,
    pub target: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

const SELECT: &str =
    "SELECT a.id, a.at, a.actor_id, u.email::text AS actor_email, a.vault_id, a.action, a.target, a.metadata
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id";

fn limit(q: &AuditQuery) -> i64 {
    q.limit.unwrap_or(100).clamp(1, 500)
}

pub async fn for_vault(
    State(state): State<AppState>,
    user: AuthUser,
    Path(vault_id): Path<Uuid>,
    Query(q): Query<AuditQuery>,
) -> ApiResult<Json<Vec<AuditEntry>>> {
    db::vault_with_role(&state.db, user.id, vault_id, Role::Admin).await?;
    let rows = sqlx::query_as::<_, AuditEntry>(&format!(
        "{SELECT} WHERE a.vault_id = $1 AND a.id < $2 ORDER BY a.id DESC LIMIT $3"
    ))
    .bind(vault_id)
    .bind(q.before.unwrap_or(i64::MAX))
    .bind(limit(&q))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// Ses propres actions (connexions comprises) — utile pour repérer une
/// session qu'on ne reconnaît pas.
pub async fn for_me(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<AuditQuery>,
) -> ApiResult<Json<Vec<AuditEntry>>> {
    let rows = sqlx::query_as::<_, AuditEntry>(&format!(
        "{SELECT} WHERE a.actor_id = $1 AND a.id < $2 ORDER BY a.id DESC LIMIT $3"
    ))
    .bind(user.id)
    .bind(q.before.unwrap_or(i64::MAX))
    .bind(limit(&q))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}
