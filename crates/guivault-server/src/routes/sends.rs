//! Liens de partage éphémères (« Send »).
//!
//! Le contenu est chiffré côté client sous une clé tirée d'un secret qui ne
//! voyage que dans le fragment de l'URL (`#/send/<id>/<secret>`), et du mot
//! de passe facultatif du lien (`guivault_crypto::send_keys`). Le serveur
//! garde le chiffré, l'expiration et le compte des vues ; il ne remet le
//! chiffré qu'à qui présente la clé d'accès tirée du même secret, dont il ne
//! garde que le SHA-256 — qui n'a que l'identifiant (le serveur compris) ne
//! peut ni le lire, ni consommer une vue.
//!
//! Les deux routes d'ouverture sont publiques (le destinataire n'a pas de
//! compte) et passent par le frein par IP des routes d'authentification.
//!
//! Un lien peut porter un **fichier** (`docs/PIECES-JOINTES.md`) : annoncé à
//! la création, envoyé morceau par morceau par son auteur, ouvrable une fois
//! complet. L'ouvrir consomme une vue et donne un jeton de téléchargement
//! d'une heure (seul son SHA-256 est gardé) : les morceaux se téléchargent
//! sans consommer d'autre vue, publiquement mais seulement avec ce jeton, et
//! restent le temps qu'il vit — même après la dernière vue.
use crate::audit::Audit;
use crate::auth::{AuthUser, ClientIp};
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use crate::validate;
use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use guivault_crypto::{ATTACHMENT_CHUNK, ATTACHMENT_CHUNK_OVERHEAD, attachment_chunk_count};
use guivault_protocol::{
    CreateSendRequest, KdfParams, SendAccessRequest, SendContent, SendDownload, SendFileChunkRequest, SendInfo,
    SendPassword, SendSummary,
};
use sqlx::PgExecutor;
use subtle::ConstantTimeEq;
use uuid::Uuid;

/// Une heure au moins : un lien qui expire avant d'avoir été transmis ne
/// sert à rien.
const MIN_LIFETIME_SECS: u64 = 3600;
const MAX_VIEWS: u32 = 1000;
/// Liens encore ouvrables par compte : de quoi partager beaucoup, pas de
/// quoi remplir le disque du serveur par une route qui répond à tout le monde.
const MAX_AVAILABLE_PER_USER: i64 = 100;
/// Ce que vit un jeton de téléchargement : de quoi récupérer un gros fichier
/// sur une connexion lente, pas de quoi rouvrir un lien épuisé plus tard.
const DOWNLOAD_SECS: f64 = 3600.0;

#[derive(sqlx::FromRow)]
struct SendRow {
    id: Uuid,
    owner_id: Uuid,
    ciphertext: Option<Vec<u8>>,
    access_hash: Vec<u8>,
    owner_blob: Vec<u8>,
    password_m_cost: Option<i32>,
    password_t_cost: Option<i32>,
    password_p_cost: Option<i32>,
    password_salt: Option<Vec<u8>>,
    max_views: Option<i32>,
    views: i32,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    last_viewed_at: Option<DateTime<Utc>>,
    file_size: Option<i64>,
    file_chunks: Option<i32>,
    file_complete: bool,
}

impl SendRow {
    fn available(&self) -> bool {
        self.ciphertext.is_some()
            && self.expires_at > Utc::now()
            && self.max_views.is_none_or(|m| self.views < m)
            && (self.file_size.is_none() || self.file_complete)
    }

    fn views_left(&self) -> Option<u32> {
        self.max_views.map(|m| (m - self.views).max(0) as u32)
    }

    fn password(&self) -> Option<SendPassword> {
        Some(SendPassword {
            kdf: KdfParams {
                m_cost: self.password_m_cost? as u32,
                t_cost: self.password_t_cost? as u32,
                p_cost: self.password_p_cost? as u32,
            },
            salt: self.password_salt.clone()?,
        })
    }

    fn summary(self) -> SendSummary {
        SendSummary {
            available: self.available(),
            has_password: self.password_salt.is_some(),
            id: self.id,
            owner_blob: self.owner_blob,
            max_views: self.max_views.map(|m| m as u32),
            views: self.views as u32,
            created_at: self.created_at,
            expires_at: self.expires_at,
            last_viewed_at: self.last_viewed_at,
            file_size: self.file_size,
        }
    }
}

async fn fetch<'e>(db: impl PgExecutor<'e>, id: Uuid, lock: bool) -> sqlx::Result<Option<SendRow>> {
    sqlx::query_as(if lock {
        "SELECT * FROM sends WHERE id = $1 FOR UPDATE"
    } else {
        "SELECT * FROM sends WHERE id = $1"
    })
    .bind(id)
    .fetch_optional(db)
    .await
}

/// Un lien qu'on ne peut plus ouvrir est introuvable, quelle qu'en soit la
/// raison : expiré, épuisé, supprimé, ou jamais créé.
fn gone() -> AppError {
    AppError::new(
        StatusCode::NOT_FOUND,
        "send_unavailable",
        "lien introuvable, expiré ou déjà consulté",
    )
}

pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Json(req): Json<CreateSendRequest>,
) -> ApiResult<(StatusCode, Json<SendSummary>)> {
    let max_days = state.config.send_max_days;
    if max_days == 0 {
        return Err(AppError::forbidden(
            "les liens de partage sont désactivés sur ce serveur",
        ));
    }
    validate::send_content(&req.ciphertext, state.config.max_item_bytes)?;
    validate::send_key("empreinte de la clé d'accès", &req.access_hash)?;
    validate::send_owner_blob(&req.owner_blob)?;
    if let Some(p) = &req.password {
        validate::kdf(&p.kdf, &p.salt)?;
    }
    if req.max_views.is_some_and(|m| !(1..=MAX_VIEWS).contains(&m)) {
        return Err(AppError::bad_request(
            "invalid_max_views",
            format!("nombre de vues entre 1 et {MAX_VIEWS}"),
        ));
    }
    if let Some(f) = req.file {
        let max = state.config.max_attachment_bytes;
        if max == 0 {
            return Err(AppError::forbidden("les fichiers sont désactivés sur ce serveur"));
        }
        if f.size < 0 || f.size as u64 > max {
            return Err(AppError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "send_too_large",
                format!("un fichier ne peut dépasser {} Mio", max / (1024 * 1024)),
            ));
        }
        let plain = f.size - i64::from(f.chunks) * ATTACHMENT_CHUNK_OVERHEAD as i64;
        if f.chunks < 1 || plain < 0 || attachment_chunk_count(plain as u64) as i64 != i64::from(f.chunks) {
            return Err(AppError::bad_request(
                "invalid_send_file",
                "taille et nombre de morceaux incohérents",
            ));
        }
    }
    let max_secs = u64::from(max_days) * 86_400;
    if !(MIN_LIFETIME_SECS..=max_secs).contains(&req.expires_in_secs) {
        return Err(AppError::bad_request(
            "invalid_expiry",
            format!("durée de vie entre une heure et {max_days} jours"),
        ));
    }

    let mut tx = state.db.begin().await?;
    // Sérialise les créations d'un même compte, pour que le plafond tienne.
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    let (available,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM sends WHERE owner_id = $1 AND ciphertext IS NOT NULL AND expires_at > now()",
    )
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;
    if available >= MAX_AVAILABLE_PER_USER {
        return Err(AppError::conflict(
            "too_many_sends",
            format!("{MAX_AVAILABLE_PER_USER} liens ouvrables au plus : supprimez-en avant d'en créer"),
        ));
    }
    if let Some(f) = req.file {
        crate::db::check_user_quota(&mut tx, state.config.quota_bytes, user.id, f.size as usize).await?;
    }
    let password = req.password.as_ref();
    let inserted = sqlx::query(
        "INSERT INTO sends (id, owner_id, ciphertext, access_hash, owner_blob,
                            password_m_cost, password_t_cost, password_p_cost, password_salt,
                            max_views, expires_at, file_size, file_chunks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11), $12, $13)
         ON CONFLICT DO NOTHING",
    )
    .bind(req.id)
    .bind(user.id)
    .bind(&req.ciphertext)
    .bind(&req.access_hash)
    .bind(&req.owner_blob)
    .bind(password.map(|p| p.kdf.m_cost as i32))
    .bind(password.map(|p| p.kdf.t_cost as i32))
    .bind(password.map(|p| p.kdf.p_cost as i32))
    .bind(password.map(|p| p.salt.clone()))
    .bind(req.max_views.map(|m| m as i32))
    .bind(req.expires_in_secs as f64)
    .bind(req.file.map(|f| f.size))
    .bind(req.file.map(|f| f.chunks))
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(AppError::conflict(
            "send_id_taken",
            "cet identifiant de lien existe déjà",
        ));
    }
    Audit::new("send.create")
        .actor(user.id)
        .target(req.id)
        .ip(ip)
        .meta(serde_json::json!({
            "password": req.password.is_some(),
            "max_views": req.max_views,
            "expires_in_secs": req.expires_in_secs,
            "file_size": req.file.map(|f| f.size),
        }))
        .write(&mut *tx)
        .await?;
    let row = fetch(&mut *tx, req.id, false).await?.ok_or_else(gone)?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row.summary())))
}

/// Mes liens, du plus récent au plus ancien — expirés compris jusqu'à leur
/// effacement.
pub async fn list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<SendSummary>>> {
    let rows = sqlx::query_as::<_, SendRow>("SELECT * FROM sends WHERE owner_id = $1 ORDER BY created_at DESC")
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows.into_iter().map(SendRow::summary).collect()))
}

pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let mut tx = state.db.begin().await?;
    let res = sqlx::query("DELETE FROM sends WHERE id = $1 AND owner_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found("lien"));
    }
    Audit::new("send.delete")
        .actor(user.id)
        .target(id)
        .ip(ip)
        .write(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Public : ce qu'il faut pour ouvrir le lien (mot de passe ?), sans rien
/// consommer.
pub async fn info(State(state): State<AppState>, Path(id): Path<Uuid>) -> ApiResult<Json<SendInfo>> {
    if state.config.send_max_days == 0 {
        return Err(gone());
    }
    let row = fetch(&state.db, id, false)
        .await?
        .filter(SendRow::available)
        .ok_or_else(gone)?;
    Ok(Json(SendInfo {
        password: row.password(),
        expires_at: row.expires_at,
        views_left: row.views_left(),
    }))
}

/// Public : la clé d'accès contre le chiffré. Consomme une vue ; la dernière
/// efface le chiffré.
pub async fn access(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
    Json(req): Json<SendAccessRequest>,
) -> ApiResult<Json<SendContent>> {
    if state.config.send_max_days == 0 {
        return Err(gone());
    }
    validate::send_key("clé d'accès", &req.access_key)?;
    let mut tx = state.db.begin().await?;
    let row = fetch(&mut *tx, id, true)
        .await?
        .filter(SendRow::available)
        .ok_or_else(gone)?;
    let presented = guivault_crypto::token_hash(&req.access_key);
    if !bool::from(presented.as_slice().ct_eq(&row.access_hash)) {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "invalid_send_key",
            if row.password_salt.is_some() {
                "mot de passe incorrect (ou lien incomplet)"
            } else {
                "lien incomplet ou altéré"
            },
        ));
    }
    let views = row.views + 1;
    let exhausted = row.max_views.is_some_and(|m| views >= m);
    sqlx::query(
        "UPDATE sends SET views = $2, last_viewed_at = now(),
                ciphertext = CASE WHEN $3 THEN NULL ELSE ciphertext END
         WHERE id = $1",
    )
    .bind(id)
    .bind(views)
    .bind(exhausted)
    .execute(&mut *tx)
    .await?;
    Audit::new("send.open")
        .target(id)
        .ip(ip)
        .meta(serde_json::json!({ "views": views, "exhausted": exhausted }))
        .write(&mut *tx)
        .await?;
    // Un fichier : un jeton pour en télécharger les morceaux, sans consommer
    // d'autre vue.
    let download = match row.file_chunks {
        Some(chunks) => {
            let token = guivault_crypto::SymmetricKey::random().as_bytes().to_vec();
            let (expires_at,): (DateTime<Utc>,) = sqlx::query_as(
                "INSERT INTO send_downloads (token_hash, send_id, expires_at)
                 VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING expires_at",
            )
            .bind(guivault_crypto::token_hash(&token).as_slice())
            .bind(id)
            .bind(DOWNLOAD_SECS)
            .fetch_one(&mut *tx)
            .await?;
            Some(SendDownload {
                token,
                chunks,
                expires_at,
            })
        }
        None => None,
    };
    tx.commit().await?;
    Ok(Json(SendContent {
        ciphertext: row.ciphertext.unwrap_or_default(),
        expires_at: row.expires_at,
        views_left: row.max_views.map(|m| (m - views).max(0) as u32),
        download,
    }))
}

/// Un morceau du fichier d'un lien, envoyé par son auteur (corps brut) tant
/// que le fichier n'est pas complet.
pub async fn put_file_chunk(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, index)): Path<(Uuid, i32)>,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let row = fetch(&state.db, id, false)
        .await?
        .filter(|r| r.owner_id == user.id)
        .ok_or_else(|| AppError::not_found("lien"))?;
    let Some(chunks) = row.file_chunks else {
        return Err(AppError::bad_request("invalid_send_file", "ce lien n'a pas de fichier"));
    };
    if row.file_complete {
        return Err(AppError::conflict(
            "send_complete",
            "le fichier de ce lien est déjà complet",
        ));
    }
    if index < 0 || index >= chunks {
        return Err(AppError::bad_request("invalid_send_file", "morceau hors du fichier"));
    }
    if body.len() < ATTACHMENT_CHUNK_OVERHEAD || body.len() > ATTACHMENT_CHUNK + ATTACHMENT_CHUNK_OVERHEAD {
        return Err(AppError::bad_request("invalid_send_file", "taille de morceau invalide"));
    }
    sqlx::query(
        "INSERT INTO send_chunks (send_id, idx, ciphertext) VALUES ($1, $2, $3)
         ON CONFLICT (send_id, idx) DO UPDATE SET ciphertext = EXCLUDED.ciphertext",
    )
    .bind(id)
    .bind(index)
    .bind(body.as_ref())
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Tous les morceaux sont là, et font la taille annoncée : le lien s'ouvre.
pub async fn complete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<SendSummary>> {
    let mut tx = state.db.begin().await?;
    let row = fetch(&mut *tx, id, true)
        .await?
        .filter(|r| r.owner_id == user.id)
        .ok_or_else(|| AppError::not_found("lien"))?;
    let (Some(size), Some(chunks)) = (row.file_size, row.file_chunks) else {
        return Err(AppError::bad_request("invalid_send_file", "ce lien n'a pas de fichier"));
    };
    let (count, bytes): (i64, i64) = sqlx::query_as(
        "SELECT count(*), coalesce(sum(octet_length(ciphertext)), 0)::bigint FROM send_chunks WHERE send_id = $1",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if count != i64::from(chunks) || bytes != size {
        return Err(AppError::conflict(
            "send_incomplete",
            format!("{count} morceau(x) sur {chunks} reçus"),
        ));
    }
    sqlx::query("UPDATE sends SET file_complete = true WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let row = fetch(&mut *tx, id, false).await?.ok_or_else(gone)?;
    tx.commit().await?;
    Ok(Json(row.summary()))
}

/// Public : un morceau du fichier d'un lien, contre le jeton que son
/// ouverture a donné. Hors du frein par IP des routes d'authentification (un
/// fichier, c'est beaucoup de morceaux ; le jeton, 256 bits aléatoires).
pub async fn file_chunk(
    State(state): State<AppState>,
    Path((id, index)): Path<(Uuid, i32)>,
    Json(req): Json<SendFileChunkRequest>,
) -> ApiResult<Response> {
    if state.config.send_max_days == 0 {
        return Err(gone());
    }
    validate::send_key("jeton de téléchargement", &req.token)?;
    let live: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM send_downloads WHERE token_hash = $1 AND send_id = $2 AND expires_at > now()")
            .bind(guivault_crypto::token_hash(&req.token).as_slice())
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    live.ok_or_else(gone)?;
    let (bytes,): (Vec<u8>,) = sqlx::query_as("SELECT ciphertext FROM send_chunks WHERE send_id = $1 AND idx = $2")
        .bind(id)
        .bind(index)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(gone)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
}

/// Efface les liens expirés (tâche horaire) ; rend le nombre effacé.
pub async fn prune(db: &sqlx::PgPool) -> sqlx::Result<u64> {
    // Un lien expiré part, sauf le temps qu'un téléchargement commencé finisse ;
    // un fichier jamais terminé part au bout d'un jour.
    let links = sqlx::query(
        "DELETE FROM sends s
         WHERE (s.expires_at < now()
                AND NOT EXISTS (SELECT 1 FROM send_downloads d WHERE d.send_id = s.id AND d.expires_at > now()))
            OR (s.file_size IS NOT NULL AND NOT s.file_complete AND s.created_at < now() - interval '1 day')",
    )
    .execute(db)
    .await?
    .rows_affected();
    sqlx::query("DELETE FROM send_downloads WHERE expires_at < now()")
        .execute(db)
        .await?;
    // Épuisé (plus de contenu) et plus aucun téléchargement en cours : le
    // fichier part.
    sqlx::query(
        "DELETE FROM send_chunks c USING sends s
         WHERE c.send_id = s.id AND s.ciphertext IS NULL
           AND NOT EXISTS (SELECT 1 FROM send_downloads d WHERE d.send_id = s.id)",
    )
    .execute(db)
    .await?;
    Ok(links)
}
