//! Lire une page ou une image d'un site, pour son icône
//! (`web/src/lib/siteIcon.ts`) : la WebView ne peut pas, faute de CORS.
//! Une requête `GET` sans cookies ni jeton, au site lui-même — jamais au
//! serveur GuiVault ni à un service tiers —, bornée en temps et en taille.
//! Le réglage qui l'autorise est désactivé par défaut : le site voit
//! l'adresse IP du poste.
use base64::Engine;
use serde::Serialize;
use std::sync::OnceLock;
use std::time::Duration;

/// Au-delà, la réponse n'est pas lue (le même plafond que `MAX_FETCH_BYTES`).
const MAX_BYTES: usize = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    /// L'adresse finale, après redirections.
    url: String,
    #[serde(rename = "type")]
    content_type: String,
    /// Le contenu, en base64.
    data: String,
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    // Le même fournisseur que le module de mise à jour : `ring`.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let built = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Mozilla/5.0 (compatible; GuiVault)")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| built))
}

#[tauri::command]
pub async fn site_fetch(url: String) -> Result<Fetched, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("adresse non http(s)".into());
    }
    let mut resp = client()?.get(parsed).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err("réponse trop grande".into());
    }
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BYTES {
            return Err("réponse trop grande".into());
        }
    }
    Ok(Fetched {
        url: final_url,
        content_type,
        data: base64::engine::general_purpose::STANDARD.encode(body),
    })
}
