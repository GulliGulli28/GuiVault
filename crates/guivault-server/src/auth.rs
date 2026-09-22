//! Sessions à jetons opaques et extracteur `AuthUser`.
//!
//! Pas de JWT : un jeton d'accès est 32 octets aléatoires dont seul le SHA-256
//! est en base. Chaque requête coûte une lecture indexée, en échange de quoi
//! une révocation est immédiate (déconnexion à distance, changement de mot de
//! passe) et il n'y a ni clé de signature à gérer ni algorithme à confondre.
use crate::config::TrustProxy;
use crate::error::AppError;
use crate::state::AppState;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::HeaderMap;
use axum::http::request::Parts;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::net::{IpAddr, SocketAddr};
use tower_governor::GovernorError;
use tower_governor::key_extractor::KeyExtractor;
use uuid::Uuid;

/// Jeton opaque : 32 octets aléatoires, base64url.
pub fn new_token() -> String {
    URL_SAFE_NO_PAD.encode(guivault_crypto::random_bytes(32))
}

pub fn hash_token(token: &str) -> Vec<u8> {
    guivault_crypto::token_hash(token.as_bytes()).to_vec()
}

/// L'utilisateur authentifié d'une requête. Extracteur axum : un handler qui
/// le prend en paramètre est protégé.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: Uuid,
    pub email: String,
    pub session_id: Uuid,
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    session_id: Uuid,
    user_id: Uuid,
    email: String,
    last_used_at: DateTime<Utc>,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer(&parts.headers).ok_or_else(AppError::unauthorized)?;
        let user = authenticate(&state.db, token).await?;
        Ok(user)
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then_some(token)
}

pub async fn authenticate(db: &PgPool, token: &str) -> Result<AuthUser, AppError> {
    let hash = hash_token(token);
    let row = sqlx::query_as::<_, SessionRow>(
        "SELECT s.id AS session_id, u.id AS user_id, u.email::text AS email, s.last_used_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.access_token_hash = $1
           AND s.revoked_at IS NULL
           AND s.access_expires_at > now()
           AND u.disabled_at IS NULL",
    )
    .bind(&hash)
    .fetch_optional(db)
    .await?
    .ok_or_else(AppError::unauthorized)?;

    // `last_used_at` sert à l'affichage des sessions : une précision à la
    // minute suffit, et ça évite une écriture par requête.
    if Utc::now() - row.last_used_at > chrono::Duration::seconds(60) {
        sqlx::query("UPDATE sessions SET last_used_at = now() WHERE id = $1")
            .bind(row.session_id)
            .execute(db)
            .await?;
    }

    Ok(AuthUser {
        id: row.user_id,
        email: row.email,
        session_id: row.session_id,
    })
}

// ─── IP cliente ─────────────────────────────────────────────────────────────

/// IP du client, selon qui a le droit de la déclarer (`TrustProxy`).
///
/// Avec une liste de proxys de confiance, on lit `X-Forwarded-For` **par la
/// droite**, en sautant les adresses de confiance : la dernière qui n'en est
/// pas est le client. C'est ce qui rend le réglage correct que le proxy
/// écrase l'en-tête (nginx `$remote_addr` : une seule entrée, le client) ou
/// qu'il l'ajoute à la suite (`$proxy_add_x_forwarded_for` : la valeur que le
/// client s'était donnée, puis l'adresse réelle vue par le proxy). Par la
/// gauche, ce second cas laisserait le client choisir son IP.
///
/// Avec `true`, il n'y a rien à vérifier — aucune adresse n'est connue comme
/// proxy — donc on prend la première, l'usage habituel de l'en-tête. Le
/// choix revient à celui qui a écrit `true` : le port doit être injoignable
/// autrement.
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, trust_proxy: &TrustProxy) -> Option<IpAddr> {
    let peer_ip = peer.map(|p| p.ip());
    let trusted = match (trust_proxy, peer_ip) {
        (TrustProxy::No, _) => false,
        (TrustProxy::Any, _) => true,
        (TrustProxy::From(_), Some(ip)) => trust_proxy.trusts(ip),
        // Sans adresse de pair (cas de test), une liste ne peut rien vérifier.
        (TrustProxy::From(_), None) => false,
    };
    if trusted {
        let raw = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok());
        let forwarded = raw.and_then(|v| {
            let mut hops = v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .filter_map(|s| s.parse::<IpAddr>().ok());
            match trust_proxy {
                TrustProxy::Any => hops.next(),
                _ => hops
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .find(|ip| !trust_proxy.trusts(*ip)),
            }
        });
        if forwarded.is_some() {
            return forwarded;
        }
    }
    peer_ip
}

/// Extracteur axum de l'IP cliente (pour le journal d'audit).
#[derive(Debug, Clone, Copy)]
pub struct ClientIp(pub Option<IpAddr>);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        Ok(ClientIp(client_ip(&parts.headers, peer, &state.config.trust_proxy)))
    }
}

/// Clé de rate-limit : la même IP que ci-dessus. Si aucune IP n'est trouvable
/// (ne devrait pas arriver avec `into_make_service_with_connect_info`), on
/// refuse plutôt que de partager un seau global.
#[derive(Debug, Clone)]
pub struct ClientIpKey {
    pub trust_proxy: TrustProxy,
}

impl KeyExtractor for ClientIpKey {
    type Key = IpAddr;

    fn extract<T>(&self, req: &axum::http::Request<T>) -> Result<Self::Key, GovernorError> {
        let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        client_ip(req.headers(), peer, &self.trust_proxy).ok_or(GovernorError::UnableToExtractKey)
    }
}

#[cfg(test)]
mod client_ip_tests {
    use super::*;

    fn xff(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", value.parse().unwrap());
        h
    }

    fn peer(s: &str) -> Option<SocketAddr> {
        Some(format!("{s}:1234").parse().unwrap())
    }

    fn ip(s: &str) -> Option<IpAddr> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn sans_confiance_l_en_tete_est_ignore() {
        let got = client_ip(&xff("1.2.3.4"), peer("10.0.0.9"), &TrustProxy::No);
        assert_eq!(got, ip("10.0.0.9"));
    }

    #[test]
    fn confiance_totale_prend_la_premiere_entree() {
        let got = client_ip(&xff("1.2.3.4, 10.0.0.1"), peer("10.0.0.1"), &TrustProxy::Any);
        assert_eq!(got, ip("1.2.3.4"));
    }

    #[test]
    fn une_liste_ignore_l_en_tete_d_un_inconnu() {
        // Le cas qui motive le réglage : quelqu'un qui joint le port
        // directement et se déclare une autre IP se fait rate-limiter sur la
        // sienne.
        let trust = TrustProxy::parse("192.168.1.10").unwrap();
        let got = client_ip(&xff("1.2.3.4"), peer("192.168.1.55"), &trust);
        assert_eq!(got, ip("192.168.1.55"));
    }

    #[test]
    fn une_liste_lit_l_en_tete_de_son_proxy() {
        let trust = TrustProxy::parse("192.168.1.10").unwrap();
        let got = client_ip(&xff("1.2.3.4"), peer("192.168.1.10"), &trust);
        assert_eq!(got, ip("1.2.3.4"));
    }

    #[test]
    fn un_proxy_qui_ajoute_ne_laisse_pas_choisir_son_ip() {
        // nginx `$proxy_add_x_forwarded_for` : « ce que le client prétend,
        // puis ce que le proxy a vu ». C'est la seconde qui compte.
        let trust = TrustProxy::parse("192.168.1.10").unwrap();
        let got = client_ip(&xff("9.9.9.9, 1.2.3.4"), peer("192.168.1.10"), &trust);
        assert_eq!(got, ip("1.2.3.4"));
    }

    #[test]
    fn plusieurs_proxys_chaines_sont_sautes() {
        let trust = TrustProxy::parse("192.168.1.10, 172.18.0.0/16").unwrap();
        let got = client_ip(&xff("1.2.3.4, 172.18.0.7"), peer("192.168.1.10"), &trust);
        assert_eq!(got, ip("1.2.3.4"));
    }

    #[test]
    fn un_cidr_reconnait_son_reseau() {
        let trust = TrustProxy::parse("172.18.0.0/16").unwrap();
        assert_eq!(client_ip(&xff("1.2.3.4"), peer("172.18.0.42"), &trust), ip("1.2.3.4"));
        assert_eq!(
            client_ip(&xff("1.2.3.4"), peer("172.19.0.42"), &trust),
            ip("172.19.0.42")
        );
    }

    #[test]
    fn un_proxy_v4_vu_en_v6_mappe_reste_reconnu() {
        let trust = TrustProxy::parse("192.168.1.10").unwrap();
        let got = client_ip(&xff("1.2.3.4"), peer("[::ffff:192.168.1.10]"), &trust);
        assert_eq!(got, ip("1.2.3.4"));
    }

    #[test]
    fn un_en_tete_absent_ou_illisible_retombe_sur_le_pair() {
        let trust = TrustProxy::parse("192.168.1.10").unwrap();
        assert_eq!(
            client_ip(&HeaderMap::new(), peer("192.168.1.10"), &trust),
            ip("192.168.1.10")
        );
        assert_eq!(
            client_ip(&xff("pas-une-ip"), peer("192.168.1.10"), &trust),
            ip("192.168.1.10")
        );
    }

    #[test]
    fn un_en_tete_ne_contenant_que_des_proxys_retombe_sur_le_pair() {
        let trust = TrustProxy::parse("192.168.1.10, 172.18.0.0/16").unwrap();
        let got = client_ip(&xff("172.18.0.7"), peer("192.168.1.10"), &trust);
        assert_eq!(got, ip("192.168.1.10"));
    }

    #[test]
    fn parse_accepte_les_formes_usuelles() {
        assert_eq!(TrustProxy::parse("").unwrap(), TrustProxy::No);
        assert_eq!(TrustProxy::parse("false").unwrap(), TrustProxy::No);
        assert_eq!(TrustProxy::parse("TRUE").unwrap(), TrustProxy::Any);
        assert!(
            matches!(TrustProxy::parse("192.168.1.10, 172.18.0.0/16").unwrap(), TrustProxy::From(n) if n.len() == 2)
        );
        assert!(TrustProxy::parse("guivault.example.com").is_err());
    }
}
