//! Configuration lue depuis l'environnement (`GUIVAULT_*`). Pas de fichier de
//! config : en Docker, l'environnement est la seule source qui ne demande pas
//! de monter un volume, et la liste tient en une dizaine de variables.
use guivault_protocol::RegistrationMode;
use ipnet::IpNet;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

/// À qui l'on fait confiance pour poser `X-Forwarded-For`.
///
/// Cet en-tête est écrit par le client comme n'importe quel autre : le croire
/// sans condition, c'est laisser choisir son IP de rate-limit à qui peut
/// joindre le port directement. D'où les trois états — et la préférence pour
/// le troisième, le seul qui **vérifie** quelque chose : l'adresse de la
/// connexion TCP, elle, ne se falsifie pas.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum TrustProxy {
    /// `false` : l'en-tête est ignoré, l'IP vue est celle de la connexion.
    #[default]
    No,
    /// `true` : l'en-tête est cru quel que soit l'émetteur. À ne garder que
    /// si le port est injoignable autrement (loopback, réseau Docker privé).
    Any,
    /// Une liste d'adresses ou de réseaux : l'en-tête n'est lu que si la
    /// connexion vient de l'un d'eux.
    From(Vec<IpNet>),
}

impl TrustProxy {
    /// `GUIVAULT_TRUST_PROXY` : `true` / `false`, ou des adresses et réseaux
    /// séparés par des virgules (`192.168.1.10, 172.18.0.0/16`). Une adresse
    /// seule vaut pour elle-même (`/32`, `/128`).
    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        let raw = raw.trim();
        match raw.to_ascii_lowercase().as_str() {
            "" | "false" | "0" | "no" => return Ok(Self::No),
            "true" | "1" | "yes" => return Ok(Self::Any),
            _ => {}
        }
        let nets = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| {
                s.parse::<IpNet>()
                    .or_else(|_| s.parse::<IpAddr>().map(IpNet::from))
                    .map_err(|_| {
                        anyhow::anyhow!(
                            "GUIVAULT_TRUST_PROXY : « {s} » n'est ni une adresse IP, ni un réseau CIDR, ni true/false"
                        )
                    })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        if nets.is_empty() {
            return Ok(Self::No);
        }
        Ok(Self::From(nets))
    }

    /// Cette connexion a-t-elle le droit de nous dire qui est le client ?
    pub fn trusts(&self, peer: IpAddr) -> bool {
        match self {
            Self::No => false,
            Self::Any => true,
            // Une adresse IPv4 arrivée sur une écoute IPv6 se présente en
            // `::ffff:a.b.c.d` : on la compare aussi sous sa forme v4, sinon
            // un réseau v4 de confiance ne reconnaîtrait jamais son proxy.
            Self::From(nets) => {
                let v4 = match peer {
                    IpAddr::V6(a) => a.to_ipv4_mapped().map(IpAddr::V4),
                    IpAddr::V4(_) => None,
                };
                nets.iter()
                    .any(|n| n.contains(&peer) || v4.is_some_and(|a| n.contains(&a)))
            }
        }
    }

    pub fn enabled(&self) -> bool {
        !matches!(self, Self::No)
    }
}

impl std::fmt::Display for TrustProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::No => write!(f, "non"),
            Self::Any => write!(f, "tous (X-Forwarded-For cru sans vérification)"),
            Self::From(nets) => {
                let list: Vec<String> = nets.iter().map(|n| n.to_string()).collect();
                write!(f, "{}", list.join(", "))
            }
        }
    }
}

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
    /// Clé de chiffrement au repos des secrets TOTP, dérivée de `secret`.
    pub totp_key: guivault_crypto::SymmetricKey,
    pub access_ttl: Duration,
    pub refresh_ttl: Duration,
    pub invitation_ttl: Duration,
    /// Qui a le droit de poser `X-Forwarded-For` — voir `TrustProxy`.
    pub trust_proxy: TrustProxy,
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
            totp_key: Self::derive_totp_key(&secret),
            secret,
            access_ttl: Duration::from_secs(env_parse("GUIVAULT_ACCESS_TTL_SECS", 15 * 60)?),
            refresh_ttl: Duration::from_secs(env_parse("GUIVAULT_REFRESH_TTL_SECS", 30 * 24 * 3600)?),
            invitation_ttl: Duration::from_secs(env_parse("GUIVAULT_INVITATION_TTL_SECS", 14 * 24 * 3600)?),
            trust_proxy: TrustProxy::parse(&env("GUIVAULT_TRUST_PROXY").unwrap_or_default())?,
            max_item_bytes: env_parse("GUIVAULT_MAX_ITEM_BYTES", 1024 * 1024)?,
            auth_rate_burst: env_parse("GUIVAULT_AUTH_RATE_BURST", 10)?,
            auth_rate_per_second: env_parse("GUIVAULT_AUTH_RATE_PER_SECOND", 2)?,
            log_json: env_parse("GUIVAULT_LOG_JSON", false)?,
        })
    }
}

impl Config {
    /// HKDF-SHA256 du secret serveur, étiquette dédiée : changer le secret
    /// rend les secrets TOTP illisibles (les utilisateurs réenrôlent).
    pub fn derive_totp_key(secret: &[u8]) -> guivault_crypto::SymmetricKey {
        use hkdf::Hkdf;
        use sha2::Sha256;
        let hk = Hkdf::<Sha256>::new(None, secret);
        let mut out = [0u8; 32];
        hk.expand(b"guivault/v1/totp-at-rest", &mut out)
            .expect("32 octets est une longueur HKDF valide");
        guivault_crypto::SymmetricKey::from_bytes(out)
    }

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
            totp_key: Config::derive_totp_key(b"x"),
            access_ttl: Duration::ZERO,
            refresh_ttl: Duration::ZERO,
            invitation_ttl: Duration::ZERO,
            trust_proxy: TrustProxy::No,
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
