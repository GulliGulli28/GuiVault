//! L'interface web, servie à la racine. C'est un build Vite statique
//! (`web/`) embarqué dans le binaire : le serveur n'y ajoute aucune logique,
//! et surtout aucune clé — la page fait sa cryptographie dans le navigateur,
//! comme Guiterm la fait dans son processus.
//!
//! Le modèle de menace change d'un cran par rapport au client de bureau : le
//! code qui manipule le mot de passe maître est livré par le serveur à
//! chaque chargement (voir `docs/SECURITY.md`, « Interface web »). D'où des
//! en-têtes stricts (CSP sans script externe ni inline, pas d'iframe) pour
//! qu'au moins rien d'autre que ce binaire ne puisse injecter du code.
use axum::Router;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use include_dir::{Dir, include_dir};

use crate::error::AppError;
use crate::state::AppState;

static DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../web/dist");

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; \
    base-uri 'none'; form-action 'self'; object-src 'none'";

pub fn router() -> Router<AppState> {
    Router::new().fallback(get(serve))
}

/// L'interface est-elle embarquée ? Faux quand le binaire a été compilé sans
/// `npm run build` (développement, tests).
pub fn is_built() -> bool {
    DIST.get_file("index.html").is_some()
}

async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // Une route d'API inconnue reste une erreur d'API, pas une page.
    if path.starts_with("api/") {
        return AppError::not_found("route").into_response();
    }
    if let Some(file) = DIST.get_file(path).filter(|_| !path.is_empty()) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        // Les fichiers de `assets/` portent un hachage dans leur nom : ils
        // peuvent être gardés indéfiniment. `index.html`, lui, change à
        // chaque version et ne doit pas l'être.
        let cache = if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(mime.as_ref())
                        .unwrap_or(HeaderValue::from_static("application/octet-stream")),
                ),
                (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
                (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
            ],
            file.contents(),
        )
            .into_response();
    }
    match DIST.get_file("index.html") {
        Some(index) => (
            [
                (header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8")),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
                (header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP)),
                (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
                (header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")),
                (header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")),
            ],
            index.contents(),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"))],
            "GuiVault : l'API répond sous /api/v1. L'interface web n'a pas été compilée dans ce binaire (`cd web && npm run build` avant `cargo build`).",
        )
            .into_response(),
    }
}
