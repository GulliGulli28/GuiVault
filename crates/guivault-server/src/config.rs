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
        let nets = parse_nets(raw).map_err(|s| {
            anyhow::anyhow!("GUIVAULT_TRUST_PROXY : « {s} » n'est ni une adresse IP, ni un réseau CIDR, ni true/false")
        })?;
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
            Self::From(nets) => nets_contain(nets, peer),
        }
    }

    pub fn enabled(&self) -> bool {
        !matches!(self, Self::No)
    }
}

/// Adresses ou réseaux séparés par des virgules ; une adresse seule vaut pour
/// elle-même (`/32`, `/128`). L'erreur est le morceau illisible.
fn parse_nets(raw: &str) -> Result<Vec<IpNet>, String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse::<IpNet>()
                .or_else(|_| s.parse::<IpAddr>().map(IpNet::from))
                .map_err(|_| s.to_string())
        })
        .collect()
}

/// Une adresse IPv4 arrivée sur une écoute IPv6 se présente en
/// `::ffff:a.b.c.d` : on la compare aussi sous sa forme v4, sinon un réseau
/// v4 ne la reconnaîtrait jamais.
fn nets_contain(nets: &[IpNet], ip: IpAddr) -> bool {
    let v4 = match ip {
        IpAddr::V6(a) => a.to_ipv4_mapped().map(IpAddr::V4),
        IpAddr::V4(_) => None,
    };
    nets.iter()
        .any(|n| n.contains(&ip) || v4.is_some_and(|a| n.contains(&a)))
}

/// Les plages d'adresses d'où l'on accepte des requêtes (`GUIVAULT_ALLOWED_IPS`,
/// `GUIVAULT_ADMIN_ALLOWED_IPS`). Vide : toutes. L'adresse comparée est
/// celle du client selon `TrustProxy` — derrière un proxy, le régler aussi.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IpAllowList(pub Vec<IpNet>);

impl IpAllowList {
    pub fn parse(var: &str, raw: &str) -> anyhow::Result<Self> {
        parse_nets(raw)
            .map(Self)
            .map_err(|s| anyhow::anyhow!("{var} : « {s} » n'est ni une adresse IP, ni un réseau CIDR"))
    }

    /// Sans adresse connue, une liste non vide refuse.
    pub fn allows(&self, ip: Option<IpAddr>) -> bool {
        self.0.is_empty() || ip.is_some_and(|ip| nets_contain(&self.0, ip))
    }

    pub fn to_strings(&self) -> Vec<String> {
        self.0.iter().map(|n| n.to_string()).collect()
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

/// Sauvegardes automatiques (`GUIVAULT_BACKUP_*`), voir `crate::backup`.
#[derive(Debug, Clone)]
pub struct BackupConfig {
    /// Où les écrire (`GUIVAULT_BACKUP_DIR`) ; absent : pas de sauvegarde
    /// automatique.
    pub dir: std::path::PathBuf,
    /// Une sauvegarde dès que la dernière réussie a plus que ça.
    pub interval: Duration,
    /// Combien en garder ; les plus anciennes sont effacées après une
    /// sauvegarde réussie.
    pub keep: usize,
    /// Une base d'essai où chaque sauvegarde est restaurée puis comparée
    /// (`GUIVAULT_BACKUP_VERIFY_DATABASE_URL`) ; elle est **effacée** à chaque
    /// fois — le serveur refuse une base qui contient autre chose.
    pub verify_database_url: Option<String>,
}

/// E-mails facultatifs (`GUIVAULT_SMTP_*`), voir `crate::mail`.
#[derive(Clone)]
pub struct MailConfig {
    /// `smtps://utilisateur:motdepasse@hote:465`, ou `smtp://…:587?tls=required`
    /// (STARTTLS) ; identifiants encodés comme dans une URL.
    pub smtp_url: String,
    /// L'expéditeur : `GuiVault <coffre@exemple.fr>`.
    pub from: String,
    /// L'adresse publique du serveur, citée dans les messages
    /// (`GUIVAULT_PUBLIC_URL`).
    pub public_url: Option<String>,
}

impl std::fmt::Debug for MailConfig {
    // Pas d'identifiants SMTP dans un journal.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailConfig")
            .field("from", &self.from)
            .field("public_url", &self.public_url)
            .finish_non_exhaustive()
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
    /// Versions précédentes gardées par item (historique) ; `0` : ni
    /// historique ni corbeille.
    pub item_history: usize,
    /// Jours qu'un item supprimé passe dans la corbeille.
    pub trash_days: u32,
    /// Durée de vie maximale d'un lien de partage, en jours ; `0` : liens
    /// désactivés (les routes publiques `/sends/{id}/access` aussi).
    pub send_max_days: u32,
    /// Taille maximale d'une pièce jointe, chiffrée, en octets ; `0` : pièces
    /// jointes désactivées (`docs/PIECES-JOINTES.md`).
    pub max_attachment_bytes: u64,
    /// Les recherches du rapport de santé relayées vers des services publics
    /// (fuites de mots de passe, sites qui proposent la 2FA) ; `false` :
    /// aucune requête sortante.
    pub health_lookups: bool,
    /// Base de l'API « range » de Have I Been Pwned.
    pub hibp_url: String,
    /// La liste des sites qui acceptent un code TOTP (2fa.directory).
    pub twofa_directory_url: String,
    /// Les seules adresses servies (API et interface) ; vide : toutes.
    /// `/api/v1/health` reste joignable de partout (sondes, HEALTHCHECK).
    pub allowed_ips: IpAllowList,
    /// Les seules adresses d'où l'administration (`/admin/*`) répond, en plus
    /// de `allowed_ips` ; vide : toutes.
    pub admin_allowed_ips: IpAllowList,
    /// Quota de stockage par défaut d'un compte, en octets de chiffrés
    /// vivants dans les vaults qu'il possède ; `0` : aucun. Un administrateur
    /// peut le changer compte par compte.
    pub quota_bytes: u64,
    /// Sauvegardes automatiques ; `None` : seulement à la main
    /// (`guivault backup create`).
    pub backup: Option<BackupConfig>,
    /// E-mails ; `None` : aucun, et rien n'en dépend.
    pub mail: Option<MailConfig>,
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
            item_history: env_parse("GUIVAULT_ITEM_HISTORY", 20)?,
            trash_days: env_parse("GUIVAULT_TRASH_DAYS", 30)?,
            send_max_days: env_parse("GUIVAULT_SEND_MAX_DAYS", 30)?,
            max_attachment_bytes: env_parse::<u64>("GUIVAULT_MAX_ATTACHMENT_MB", 100)?.saturating_mul(1024 * 1024),
            health_lookups: env_parse("GUIVAULT_HEALTH_LOOKUPS", true)?,
            hibp_url: env("GUIVAULT_HIBP_URL").unwrap_or_else(|| "https://api.pwnedpasswords.com".into()),
            twofa_directory_url: env("GUIVAULT_2FA_DIRECTORY_URL")
                .unwrap_or_else(|| "https://api.2fa.directory/v3/totp.json".into()),
            allowed_ips: IpAllowList::parse("GUIVAULT_ALLOWED_IPS", &env("GUIVAULT_ALLOWED_IPS").unwrap_or_default())?,
            admin_allowed_ips: IpAllowList::parse(
                "GUIVAULT_ADMIN_ALLOWED_IPS",
                &env("GUIVAULT_ADMIN_ALLOWED_IPS").unwrap_or_default(),
            )?,
            quota_bytes: env_parse::<u64>("GUIVAULT_QUOTA_MB", 0)?.saturating_mul(1024 * 1024),
            backup: match env("GUIVAULT_BACKUP_DIR") {
                None => None,
                Some(dir) => {
                    let hours: u64 = env_parse("GUIVAULT_BACKUP_INTERVAL_HOURS", 24)?;
                    let keep: usize = env_parse("GUIVAULT_BACKUP_KEEP", 7)?;
                    anyhow::ensure!(hours >= 1, "GUIVAULT_BACKUP_INTERVAL_HOURS : au moins 1");
                    anyhow::ensure!(keep >= 1, "GUIVAULT_BACKUP_KEEP : au moins 1");
                    Some(BackupConfig {
                        dir: dir.into(),
                        interval: Duration::from_secs(hours * 3600),
                        keep,
                        verify_database_url: env("GUIVAULT_BACKUP_VERIFY_DATABASE_URL"),
                    })
                }
            },
            mail: env("GUIVAULT_SMTP_URL").map(|smtp_url| MailConfig {
                smtp_url,
                from: env("GUIVAULT_SMTP_FROM").unwrap_or_default(),
                public_url: env("GUIVAULT_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_string()),
            }),
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
            item_history: 0,
            trash_days: 0,
            send_max_days: 0,
            max_attachment_bytes: 0,
            health_lookups: false,
            hibp_url: String::new(),
            twofa_directory_url: String::new(),
            allowed_ips: IpAllowList::default(),
            admin_allowed_ips: IpAllowList::default(),
            quota_bytes: 0,
            backup: None,
            mail: None,
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

    #[test]
    fn ip_allow_list() {
        let ip = |s: &str| Some(s.parse::<IpAddr>().unwrap());
        let open = IpAllowList::parse("X", "").unwrap();
        assert!(open.allows(ip("8.8.8.8")) && open.allows(None), "vide : tout passe");
        let lan = IpAllowList::parse("X", "192.168.1.0/24, 10.0.0.7, fd00::/8").unwrap();
        assert!(lan.allows(ip("192.168.1.42")));
        assert!(lan.allows(ip("10.0.0.7")));
        assert!(!lan.allows(ip("10.0.0.8")));
        assert!(lan.allows(ip("fd12::1")));
        assert!(lan.allows(ip("::ffff:192.168.1.9")), "IPv4 vue sur une écoute IPv6");
        assert!(!lan.allows(ip("8.8.8.8")));
        assert!(!lan.allows(None), "adresse inconnue : refusée");
        let err = IpAllowList::parse("GUIVAULT_ALLOWED_IPS", "10.0.0.0/8, bureau").unwrap_err();
        assert!(err.to_string().contains("« bureau »"), "{err}");
    }
}
