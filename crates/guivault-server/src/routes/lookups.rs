//! Les relais du rapport de santé. Le rapport se calcule dans le client, sur
//! les items déchiffrés ; deux questions seulement ont besoin du monde
//! extérieur, et passent par ici plutôt que d'ouvrir la CSP de l'interface
//! (`connect-src 'self'`) — et pour que les services interrogés voient
//! l'adresse du serveur, pas celle de chaque utilisateur :
//!
//! - **fuites** : Have I Been Pwned par k-anonymat. Le client envoie les
//!   5 premiers caractères hexadécimaux du SHA-1 d'un mot de passe, reçoit
//!   tous les suffixes connus sous ce préfixe (avec du remplissage, pour que
//!   la taille de la réponse ne dise rien) et cherche le sien lui-même. Ni
//!   le serveur ni HIBP ne voient le mot de passe ni son empreinte ;
//! - **2FA** : la liste publique des sites qui acceptent un code TOTP
//!   (2fa.directory), gardée 24 h. Elle ne dépend de rien de l'utilisateur.
//!
//! `GUIVAULT_HEALTH_LOOKUPS=false` : aucune requête sortante, les routes
//! répondent `404 lookups_disabled`.
use crate::auth::AuthUser;
use crate::error::{ApiResult, AppError};
use crate::state::AppState;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use guivault_protocol::TwoFactorSite;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Combien de temps la liste 2fa.directory reste bonne.
const DIRECTORY_TTL: Duration = Duration::from_secs(24 * 3600);

pub struct Lookups {
    http: reqwest::Client,
    directory: Mutex<Option<(Instant, Arc<Vec<TwoFactorSite>>)>>,
}

impl Default for Lookups {
    fn default() -> Self {
        Self::new()
    }
}

impl Lookups {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("GuiVault/", env!("CARGO_PKG_VERSION"), " (rapport de santé)"))
            .build()
            .expect("client HTTP");
        Self {
            http,
            directory: Mutex::new(None),
        }
    }
}

fn disabled() -> AppError {
    AppError::new(
        StatusCode::NOT_FOUND,
        "lookups_disabled",
        "les recherches externes du rapport de santé sont désactivées sur ce serveur",
    )
}

fn upstream(what: &str, e: impl std::fmt::Display) -> AppError {
    tracing::warn!(error = %e, "{what} : service injoignable");
    AppError::new(
        StatusCode::BAD_GATEWAY,
        "lookup_failed",
        format!("{what} ne répond pas, réessayez plus tard"),
    )
}

/// `GET /lookups/pwned-passwords/{prefix}` : les suffixes HIBP sous ces
/// 5 caractères hexadécimaux, tels quels (`SUFFIXE:NOMBRE` par ligne).
pub async fn pwned_range(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(prefix): Path<String>,
) -> ApiResult<Response> {
    if !state.config.health_lookups {
        return Err(disabled());
    }
    if prefix.len() != 5 || !prefix.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::bad_request(
            "invalid_prefix",
            "préfixe : 5 caractères hexadécimaux",
        ));
    }
    let url = format!(
        "{}/range/{}",
        state.config.hibp_url.trim_end_matches('/'),
        prefix.to_ascii_uppercase()
    );
    let res = state
        .lookups
        .http
        .get(url)
        .header("Add-Padding", "true")
        .send()
        .await
        .map_err(|e| upstream("Have I Been Pwned", e))?;
    if !res.status().is_success() {
        return Err(upstream("Have I Been Pwned", res.status()));
    }
    let body = res.text().await.map_err(|e| upstream("Have I Been Pwned", e))?;
    Ok((
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        )],
        body,
    )
        .into_response())
}

/// La réponse de 2fa.directory (`[[nom, { domain, additional-domains,
/// documentation, … }], …]`) réduite à ce que le rapport utilise. Une
/// entrée mal formée est ignorée, pas fatale.
pub fn parse_directory(json: &serde_json::Value) -> Vec<TwoFactorSite> {
    let Some(entries) = json.as_array() else {
        return vec![];
    };
    entries
        .iter()
        .filter_map(|e| {
            let pair = e.as_array()?;
            let name = pair.first()?.as_str()?.to_string();
            let obj = pair.get(1)?.as_object()?;
            let mut domains = vec![obj.get("domain")?.as_str()?.to_ascii_lowercase()];
            for d in obj
                .get("additional-domains")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                if let Some(d) = d.as_str() {
                    domains.push(d.to_ascii_lowercase());
                }
            }
            let documentation = obj
                .get("documentation")
                .and_then(|v| v.as_str())
                .filter(|u| u.starts_with("https://"))
                .map(str::to_string);
            Some(TwoFactorSite {
                name,
                domains,
                documentation,
            })
        })
        .collect()
}

/// `GET /lookups/2fa-directory` : les sites qui acceptent un code TOTP.
pub async fn twofa_directory(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Vec<TwoFactorSite>>> {
    if !state.config.health_lookups {
        return Err(disabled());
    }
    let mut cache = state.lookups.directory.lock().await;
    if let Some((at, sites)) = cache.as_ref()
        && at.elapsed() < DIRECTORY_TTL
    {
        return Ok(Json(sites.as_ref().clone()));
    }
    let res = state
        .lookups
        .http
        .get(&state.config.twofa_directory_url)
        .send()
        .await
        .map_err(|e| upstream("2fa.directory", e))?;
    if !res.status().is_success() {
        return Err(upstream("2fa.directory", res.status()));
    }
    let text = res.text().await.map_err(|e| upstream("2fa.directory", e))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| upstream("2fa.directory", e))?;
    let sites = Arc::new(parse_directory(&json));
    *cache = Some((Instant::now(), sites.clone()));
    Ok(Json(sites.as_ref().clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_is_reduced_to_domains_and_documentation() {
        let json = serde_json::json!([
            ["Exemple", { "domain": "Exemple.com", "tfa": ["totp"], "documentation": "https://exemple.com/2fa", "additional-domains": ["exemple.fr"] }],
            ["Sans doc", { "domain": "sansdoc.io", "documentation": "http://pas-https" }],
            ["Cassé", { "tfa": ["totp"] }],
            "pas une entrée"
        ]);
        let sites = parse_directory(&json);
        assert_eq!(sites.len(), 2);
        assert_eq!(sites[0].domains, ["exemple.com", "exemple.fr"]);
        assert_eq!(sites[0].documentation.as_deref(), Some("https://exemple.com/2fa"));
        assert_eq!(sites[1].documentation, None);
        assert!(parse_directory(&serde_json::json!({})).is_empty());
    }
}
