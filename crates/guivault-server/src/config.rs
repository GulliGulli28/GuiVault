//! Configuration lue depuis l'environnement (`GUIVAULT_*`). Pas de fichier de
//! config : en Docker, l'environnement est la seule source qui ne demande pas
//! de monter un volume, et la liste tient en une dizaine de variables.
use guivault_protocol::RegistrationMode;
use std::net::SocketAddr;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind: SocketAddr,
    pub registration: RegistrationMode,
    /// E-mails (ou suffixes `@domaine`) autorisés à s'inscrire quelles que
    /// soient les règles : c'est ainsi qu'on amorce le premier compte en mode
    /// `invite_only` — le serveur ne peut pas le créer lui-même, puisqu'il
    /// n'a jamais le mot de passe maître.
    pub allowed_emails: Vec<String>,
    /// Secret serveur (≥ 32 octets) : sert de clé HMAC pour les sels de
    /// prelogin fictifs (voir `routes::auth::prelogin`). Ne chiffre rien.
    pub secret: Vec<u8>,
    pub access_ttl: Duration,
    pub refresh_ttl: Duration,
    pub invitation_ttl: Duration,
    /// Faire confiance à `X-Forwarded-For` (uniquement derrière un reverse
    /// proxy qui l'écrase — sinon n'importe qui choisit son IP de rate-limit).
    pub trust_proxy: bool,
    pub max_item_bytes: usize,
    /// Rafales autorisées sur les routes d'authentification, par IP.
    pub auth_rate_burst: u32,
    pub auth_rate_per_second: u64,
    pub log_json: bool,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn env_parse<T: std::str::FromStr>(name: &str, default: T) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    match env(name) {
        Some(v) => v
            .parse()
            .map_err(|e| anyhow::anyhow!("{name}={v:?} : valeur invalide ({e})")),
        None => Ok(default),
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = env("GUIVAULT_DATABASE_URL")
            .or_else(|| env("DATABASE_URL"))
            .ok_or_else(|| anyhow::anyhow!("GUIVAULT_DATABASE_URL manquant"))?;

        let secret_str = env("GUIVAULT_SECRET")
            .ok_or_else(|| anyhow::anyhow!("GUIVAULT_SECRET manquant — générer avec `openssl rand -base64 48`"))?;
        let secret = secret_str.into_bytes();
        if secret.len() < 32 {
            anyhow::bail!("GUIVAULT_SECRET trop court : au moins 32 caractères");
        }

        let registration = match env("GUIVAULT_REGISTRATION").as_deref().unwrap_or("invite_only") {
            "open" => RegistrationMode::Open,
            "invite_only" | "invite-only" => RegistrationMode::InviteOnly,
            "closed" => RegistrationMode::Closed,
            other => anyhow::bail!("GUIVAULT_REGISTRATION={other:?} : attendu open | invite_only | closed"),
        };

        let allowed_emails = env("GUIVAULT_ALLOWED_EMAILS")
            .map(|v| {
                v.split(',')
                    .map(|e| e.trim().to_lowercase())
                    .filter(|e| !e.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        Ok(Self {
            database_url,
            bind: env_parse("GUIVAULT_BIND", "0.0.0.0:8080".parse()?)?,
            registration,
            allowed_emails,
            secret,
            access_ttl: Duration::from_secs(env_parse("GUIVAULT_ACCESS_TTL_SECS", 15 * 60)?),
            refresh_ttl: Duration::from_secs(env_parse("GUIVAULT_REFRESH_TTL_SECS", 30 * 24 * 3600)?),
            invitation_ttl: Duration::from_secs(env_parse("GUIVAULT_INVITATION_TTL_SECS", 14 * 24 * 3600)?),
            trust_proxy: env_parse("GUIVAULT_TRUST_PROXY", false)?,
            max_item_bytes: env_parse("GUIVAULT_MAX_ITEM_BYTES", 1024 * 1024)?,
            auth_rate_burst: env_parse("GUIVAULT_AUTH_RATE_BURST", 10)?,
            auth_rate_per_second: env_parse("GUIVAULT_AUTH_RATE_PER_SECOND", 2)?,
            log_json: env_parse("GUIVAULT_LOG_JSON", false)?,
        })
    }
}

impl Config {
    /// `email` est déjà normalisé (minuscules, sans espaces).
    pub fn is_email_allowlisted(&self, email: &str) -> bool {
        self.allowed_emails.iter().any(|a| {
            if let Some(domain) = a.strip_prefix('@') {
                email.rsplit_once('@').is_some_and(|(_, d)| d == domain)
            } else {
                a == email
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_matches_exact_and_domain() {
        let mut c = Config {
            database_url: String::new(),
            bind: "127.0.0.1:0".parse().unwrap(),
            registration: RegistrationMode::Closed,
            allowed_emails: vec!["admin@corp.io".into(), "@team.example".into()],
            secret: vec![],
            access_ttl: Duration::ZERO,
            refresh_ttl: Duration::ZERO,
            invitation_ttl: Duration::ZERO,
            trust_proxy: false,
            max_item_bytes: 0,
            auth_rate_burst: 0,
            auth_rate_per_second: 0,
            log_json: false,
        };
        assert!(c.is_email_allowlisted("admin@corp.io"));
        assert!(!c.is_email_allowlisted("other@corp.io"));
        assert!(c.is_email_allowlisted("anyone@team.example"));
        assert!(!c.is_email_allowlisted("anyone@sub.team.example"));
        c.allowed_emails.clear();
        assert!(!c.is_email_allowlisted("admin@corp.io"));
    }
}
