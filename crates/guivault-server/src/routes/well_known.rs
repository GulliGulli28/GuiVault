//! `/.well-known/security.txt` (RFC 9116) : à qui signaler une faille.
//!
//! Deux destinataires possibles, dans cet ordre : l'opérateur de *ce*
//! serveur (`GUIVAULT_SECURITY_CONTACT`), pour ce qui tient à son
//! déploiement, puis le projet GuiVault, pour ce qui tient au logiciel.
use axum::extract::State;
use axum::http::{HeaderValue, header};
use axum::response::IntoResponse;
use chrono::{Duration, SecondsFormat, Utc};

use crate::state::AppState;

pub const PROJECT_CONTACT: &str = "https://github.com/GulliGulli28/GuiVault/security/advisories/new";
pub const POLICY: &str = "https://github.com/GulliGulli28/GuiVault/blob/main/SECURITY.md";

/// Le fichier est produit à chaque requête : `Expires` (obligatoire, moins
/// d'un an conseillé) avance avec le serveur au lieu de périmer dans une
/// image oubliée.
pub async fn security_txt(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = &state.config;
    let mut out = String::from("# GuiVault — signaler une vulnérabilité\n");
    if let Some(contact) = &cfg.security_contact {
        out.push_str(&format!("Contact: {contact}\n"));
    }
    out.push_str(&format!("Contact: {PROJECT_CONTACT}\n"));
    let expires = (Utc::now() + Duration::days(180)).to_rfc3339_opts(SecondsFormat::Secs, true);
    out.push_str(&format!("Expires: {expires}\n"));
    out.push_str("Preferred-Languages: fr, en\n");
    out.push_str(&format!("Policy: {POLICY}\n"));
    if let Some(url) = &cfg.public_url {
        out.push_str(&format!("Canonical: {url}/.well-known/security.txt\n"));
    }
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400")),
            (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        ],
        out,
    )
}

/// `GUIVAULT_SECURITY_CONTACT` : une URI (`mailto:`, `https:`), ou une
/// adresse e-mail nue, qui devient `mailto:`.
pub fn parse_contact(raw: &str) -> anyhow::Result<String> {
    let raw = raw.trim();
    if raw.starts_with("mailto:") || raw.starts_with("https://") {
        return Ok(raw.to_string());
    }
    if raw.contains('@') && !raw.contains(char::is_whitespace) && !raw.contains(':') {
        return Ok(format!("mailto:{raw}"));
    }
    anyhow::bail!("GUIVAULT_SECURITY_CONTACT={raw:?} : attendu une adresse e-mail, mailto:… ou https://…")
}

#[cfg(test)]
mod tests {
    use super::parse_contact;

    #[test]
    fn contact_is_an_uri() {
        assert_eq!(parse_contact("secu@exemple.fr").unwrap(), "mailto:secu@exemple.fr");
        assert_eq!(parse_contact(" mailto:a@b.fr ").unwrap(), "mailto:a@b.fr");
        assert_eq!(
            parse_contact("https://exemple.fr/secu").unwrap(),
            "https://exemple.fr/secu"
        );
        assert!(parse_contact("http://exemple.fr").is_err());
        assert!(parse_contact("pas une adresse").is_err());
    }
}
