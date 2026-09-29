//! WebAuthn côté serveur, le strict nécessaire à la connexion par passkey
//! (`docs/PASSKEYS.md`) : vérifier qu'une passkey a bien été créée pour ce
//! site (`verify_registration`), puis qu'une signature vient d'elle
//! (`verify_assertion`). Rien n'y est déchiffré — la user key reste sous la
//! clé que seule la PRF de l'authentificateur donne.
//!
//! En Rust pur (`webauthn-rs` tire OpenSSL) et volontairement étroit :
//! - attestation **non vérifiée** (format `none` accepté comme les autres) :
//!   on ne restreint pas les modèles d'authentificateur, on retient la clé ;
//! - **vérification de l'utilisateur exigée** (drapeau UV : code, biométrie) —
//!   la passkey remplace le mot de passe maître *et* le second facteur ;
//! - clés ES256 (P-256), EdDSA (Ed25519) et RS256 (Windows Hello) ;
//! - origine et identifiant de site fixés par `GUIVAULT_PUBLIC_URL`,
//!   `crossOrigin` refusé ;
//! - compteur de signatures : s'il est tenu, il doit monter (clone détecté).
use ciborium::Value;
use sha2::{Digest, Sha256};

/// Le site pour lequel les passkeys sont créées : l'origine exacte de
/// l'interface web et son domaine (identifiant WebAuthn).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelyingParty {
    pub id: String,
    pub origin: String,
    pub name: String,
}

impl RelyingParty {
    /// Depuis `GUIVAULT_PUBLIC_URL` (`https://vault.example.com[/…]`).
    pub fn from_public_url(url: &str) -> Option<Self> {
        let (scheme, rest) = url.split_once("://")?;
        if scheme != "https" && scheme != "http" {
            return None;
        }
        let authority = rest.split(['/', '?', '#']).next()?;
        let host = match authority.rsplit_once(':') {
            Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
            _ => authority,
        };
        if host.is_empty() {
            return None;
        }
        Some(RelyingParty {
            id: host.to_lowercase(),
            origin: format!("{scheme}://{}", authority.to_lowercase()),
            name: "GuiVault".into(),
        })
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WebauthnError {
    #[error("réponse WebAuthn mal formée : {0}")]
    Format(&'static str),
    #[error("ce n'est pas la réponse attendue ({0})")]
    WrongType(&'static str),
    #[error("défi inconnu ou déjà utilisé")]
    Challenge,
    #[error("origine inattendue : {0}")]
    Origin(String),
    #[error("passkey créée pour un autre site")]
    RpId,
    #[error("présence de l'utilisateur non attestée")]
    UserPresence,
    #[error("vérification de l'utilisateur exigée (code ou biométrie de la passkey)")]
    UserVerification,
    #[error("type de clé non pris en charge (ES256, EdDSA ou RS256)")]
    Algorithm,
    #[error("signature invalide")]
    Signature,
    #[error("compteur de signatures en recul : passkey peut-être clonée")]
    Counter,
}

type Result<T> = std::result::Result<T, WebauthnError>;

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_AT: u8 = 0x40;

struct AuthData<'a> {
    rp_id_hash: &'a [u8],
    flags: u8,
    sign_count: u32,
    /// Identifiant et clé COSE de la passkey (à la création).
    attested: Option<(Vec<u8>, Vec<u8>)>,
}

fn parse_auth_data(bytes: &[u8]) -> Result<AuthData<'_>> {
    if bytes.len() < 37 {
        return Err(WebauthnError::Format("authenticatorData trop courte"));
    }
    let flags = bytes[32];
    let sign_count = u32::from_be_bytes(bytes[33..37].try_into().expect("4 octets"));
    let mut attested = None;
    if flags & FLAG_AT != 0 {
        let rest = &bytes[37..];
        if rest.len() < 18 {
            return Err(WebauthnError::Format("données de passkey tronquées"));
        }
        let id_len = u16::from_be_bytes([rest[16], rest[17]]) as usize;
        let id = rest
            .get(18..18 + id_len)
            .ok_or(WebauthnError::Format("identifiant de passkey tronqué"))?
            .to_vec();
        let key_bytes = &rest[18 + id_len..];
        // La clé COSE est suivie des extensions éventuelles : sa longueur est
        // ce que le décodeur CBOR en consomme.
        let mut cursor = std::io::Cursor::new(key_bytes);
        let _: Value =
            ciborium::de::from_reader(&mut cursor).map_err(|_| WebauthnError::Format("clé COSE illisible"))?;
        let used = cursor.position() as usize;
        attested = Some((id, key_bytes[..used].to_vec()));
    }
    Ok(AuthData {
        rp_id_hash: &bytes[..32],
        flags,
        sign_count,
        attested,
    })
}

#[derive(serde::Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(default, rename = "crossOrigin")]
    cross_origin: bool,
}

fn check_client_data(json: &[u8], kind: &'static str, rp: &RelyingParty, challenge: &[u8]) -> Result<()> {
    use base64::Engine;
    let cd: ClientData = serde_json::from_slice(json).map_err(|_| WebauthnError::Format("clientDataJSON illisible"))?;
    if cd.kind != kind {
        return Err(WebauthnError::WrongType(kind));
    }
    let got = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cd.challenge.trim_end_matches('='))
        .map_err(|_| WebauthnError::Format("défi mal encodé"))?;
    if got != challenge {
        return Err(WebauthnError::Challenge);
    }
    if cd.origin != rp.origin || cd.cross_origin {
        return Err(WebauthnError::Origin(cd.origin));
    }
    Ok(())
}

fn check_flags(auth: &AuthData, rp: &RelyingParty) -> Result<()> {
    if auth.rp_id_hash != Sha256::digest(rp.id.as_bytes()).as_slice() {
        return Err(WebauthnError::RpId);
    }
    if auth.flags & FLAG_UP == 0 {
        return Err(WebauthnError::UserPresence);
    }
    if auth.flags & FLAG_UV == 0 {
        return Err(WebauthnError::UserVerification);
    }
    Ok(())
}

/// Une clé publique COSE qu'on sait vérifier.
enum PublicKey {
    Es256(p256::ecdsa::VerifyingKey),
    Ed25519(ed25519_dalek::VerifyingKey),
    Rs256(rsa::pkcs1v15::VerifyingKey<Sha256>),
}

fn cose_int(map: &[(Value, Value)], label: i64) -> Option<&Value> {
    map.iter()
        .find(|(k, _)| k.as_integer().is_some_and(|i| i128::from(i) == label as i128))
        .map(|(_, v)| v)
}

fn cose_bytes(map: &[(Value, Value)], label: i64) -> Result<&[u8]> {
    cose_int(map, label)
        .and_then(Value::as_bytes)
        .map(Vec::as_slice)
        .ok_or(WebauthnError::Algorithm)
}

fn parse_public_key(cose: &[u8]) -> Result<PublicKey> {
    let value: Value = ciborium::de::from_reader(cose).map_err(|_| WebauthnError::Format("clé COSE illisible"))?;
    let map = value.as_map().ok_or(WebauthnError::Format("clé COSE illisible"))?;
    let int = |label| cose_int(map, label).and_then(Value::as_integer).map(i128::from);
    match (int(1), int(3)) {
        // EC2, ES256, courbe P-256.
        (Some(2), Some(-7)) if int(-1) == Some(1) => {
            let (x, y) = (cose_bytes(map, -2)?, cose_bytes(map, -3)?);
            if x.len() != 32 || y.len() != 32 {
                return Err(WebauthnError::Algorithm);
            }
            let mut sec1 = vec![0x04];
            sec1.extend_from_slice(x);
            sec1.extend_from_slice(y);
            p256::ecdsa::VerifyingKey::from_sec1_bytes(&sec1)
                .map(PublicKey::Es256)
                .map_err(|_| WebauthnError::Algorithm)
        }
        // OKP, EdDSA, Ed25519.
        (Some(1), Some(-8)) if int(-1) == Some(6) => {
            let x: [u8; 32] = cose_bytes(map, -2)?.try_into().map_err(|_| WebauthnError::Algorithm)?;
            ed25519_dalek::VerifyingKey::from_bytes(&x)
                .map(PublicKey::Ed25519)
                .map_err(|_| WebauthnError::Algorithm)
        }
        // RSA, RS256 (PKCS#1 v1.5, SHA-256), 2048 bits au moins.
        (Some(3), Some(-257)) => {
            let (n, e) = (cose_bytes(map, -1)?, cose_bytes(map, -2)?);
            if n.len() < 256 {
                return Err(WebauthnError::Algorithm);
            }
            let key = rsa::RsaPublicKey::new(rsa::BigUint::from_bytes_be(n), rsa::BigUint::from_bytes_be(e))
                .map_err(|_| WebauthnError::Algorithm)?;
            Ok(PublicKey::Rs256(rsa::pkcs1v15::VerifyingKey::new(key)))
        }
        _ => Err(WebauthnError::Algorithm),
    }
}

fn verify_signature(key: &PublicKey, message: &[u8], signature: &[u8]) -> Result<()> {
    use p256::ecdsa::signature::Verifier;
    let ok = match key {
        PublicKey::Es256(k) => p256::ecdsa::Signature::from_der(signature)
            .map(|s| s.normalize_s().unwrap_or(s))
            .is_ok_and(|s| k.verify(message, &s).is_ok()),
        PublicKey::Ed25519(k) => {
            ed25519_dalek::Signature::from_slice(signature).is_ok_and(|s| k.verify_strict(message, &s).is_ok())
        }
        PublicKey::Rs256(k) => rsa::pkcs1v15::Signature::try_from(signature)
            .is_ok_and(|s| rsa::signature::Verifier::verify(k, message, &s).is_ok()),
    };
    if ok { Ok(()) } else { Err(WebauthnError::Signature) }
}

/// Une passkey tout juste créée, à retenir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCredential {
    pub id: Vec<u8>,
    /// La clé publique, en COSE, telle que l'authentificateur l'a donnée.
    pub public_key: Vec<u8>,
    pub sign_count: u32,
}

/// `navigator.credentials.create` : la réponse est-elle celle de ce défi, de
/// ce site, avec l'utilisateur vérifié, et une clé qu'on sait vérifier ?
pub fn verify_registration(
    rp: &RelyingParty,
    challenge: &[u8],
    client_data_json: &[u8],
    attestation_object: &[u8],
) -> Result<NewCredential> {
    check_client_data(client_data_json, "webauthn.create", rp, challenge)?;
    let att: Value = ciborium::de::from_reader(attestation_object)
        .map_err(|_| WebauthnError::Format("attestationObject illisible"))?;
    let auth_data = att
        .as_map()
        .and_then(|m| {
            m.iter()
                .find(|(k, _)| k.as_text() == Some("authData"))
                .and_then(|(_, v)| v.as_bytes())
        })
        .ok_or(WebauthnError::Format("authData absente"))?;
    let auth = parse_auth_data(auth_data)?;
    check_flags(&auth, rp)?;
    let (id, public_key) = auth
        .attested
        .ok_or(WebauthnError::Format("aucune passkey dans la réponse"))?;
    if id.is_empty() || id.len() > 1023 {
        return Err(WebauthnError::Format("identifiant de passkey invalide"));
    }
    parse_public_key(&public_key)?;
    Ok(NewCredential {
        id,
        public_key,
        sign_count: auth.sign_count,
    })
}

/// `navigator.credentials.get` : une signature de cette passkey, pour ce
/// défi et ce site, utilisateur vérifié. Rend le nouveau compteur.
pub fn verify_assertion(
    rp: &RelyingParty,
    challenge: &[u8],
    public_key: &[u8],
    stored_count: u32,
    client_data_json: &[u8],
    authenticator_data: &[u8],
    signature: &[u8],
) -> Result<u32> {
    check_client_data(client_data_json, "webauthn.get", rp, challenge)?;
    let auth = parse_auth_data(authenticator_data)?;
    check_flags(&auth, rp)?;
    let key = parse_public_key(public_key)?;
    let mut signed = authenticator_data.to_vec();
    signed.extend_from_slice(&Sha256::digest(client_data_json));
    verify_signature(&key, &signed, signature)?;
    if (stored_count > 0 || auth.sign_count > 0) && auth.sign_count <= stored_count {
        return Err(WebauthnError::Counter);
    }
    Ok(auth.sign_count)
}

/// Un authentificateur logiciel (P-256), pour les tests : il crée des passkeys
/// et signe comme le ferait une vraie, drapeaux compris.
#[doc(hidden)]
pub mod testing {
    use super::*;
    use base64::Engine;
    use p256::ecdsa::{SigningKey, signature::Signer};

    pub struct SoftAuthenticator {
        key: SigningKey,
        pub credential_id: Vec<u8>,
        pub sign_count: u32,
        /// Vérifie-t-il l'utilisateur (code, biométrie) ?
        pub user_verified: bool,
    }

    impl SoftAuthenticator {
        pub fn new(seed: u8) -> Self {
            SoftAuthenticator {
                key: SigningKey::from_bytes(&[seed.max(1); 32].into()).expect("clé valide"),
                credential_id: vec![seed; 16],
                sign_count: 0,
                user_verified: true,
            }
        }

        pub fn cose_key(&self) -> Vec<u8> {
            let point = self.key.verifying_key().to_encoded_point(false);
            let map = Value::Map(vec![
                (Value::from(1), Value::from(2)),
                (Value::from(3), Value::from(-7)),
                (Value::from(-1), Value::from(1)),
                (Value::from(-2), Value::Bytes(point.x().expect("x").to_vec())),
                (Value::from(-3), Value::Bytes(point.y().expect("y").to_vec())),
            ]);
            let mut out = Vec::new();
            ciborium::ser::into_writer(&map, &mut out).expect("CBOR");
            out
        }

        fn flags(&self, attested: bool) -> u8 {
            FLAG_UP | if self.user_verified { FLAG_UV } else { 0 } | if attested { FLAG_AT } else { 0 }
        }

        pub fn client_data(kind: &str, origin: &str, challenge: &[u8]) -> Vec<u8> {
            let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(challenge);
            serde_json::json!({ "type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false })
                .to_string()
                .into_bytes()
        }

        /// `(clientDataJSON, attestationObject)` d'une création.
        pub fn register(&self, rp_id: &str, origin: &str, challenge: &[u8]) -> (Vec<u8>, Vec<u8>) {
            let mut auth = Sha256::digest(rp_id.as_bytes()).to_vec();
            auth.push(self.flags(true));
            auth.extend_from_slice(&self.sign_count.to_be_bytes());
            auth.extend_from_slice(&[0u8; 16]);
            auth.extend_from_slice(&(self.credential_id.len() as u16).to_be_bytes());
            auth.extend_from_slice(&self.credential_id);
            auth.extend_from_slice(&self.cose_key());
            let att = Value::Map(vec![
                (Value::Text("fmt".into()), Value::Text("none".into())),
                (Value::Text("attStmt".into()), Value::Map(vec![])),
                (Value::Text("authData".into()), Value::Bytes(auth)),
            ]);
            let mut att_bytes = Vec::new();
            ciborium::ser::into_writer(&att, &mut att_bytes).expect("CBOR");
            (Self::client_data("webauthn.create", origin, challenge), att_bytes)
        }

        /// `(clientDataJSON, authenticatorData, signature)` d'une connexion ;
        /// le compteur monte.
        pub fn assert(&mut self, rp_id: &str, origin: &str, challenge: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
            self.sign_count += 1;
            let client_data = Self::client_data("webauthn.get", origin, challenge);
            let mut auth = Sha256::digest(rp_id.as_bytes()).to_vec();
            auth.push(self.flags(false));
            auth.extend_from_slice(&self.sign_count.to_be_bytes());
            let mut signed = auth.clone();
            signed.extend_from_slice(&Sha256::digest(&client_data));
            let sig: p256::ecdsa::Signature = self.key.sign(&signed);
            (client_data, auth, sig.to_der().as_bytes().to_vec())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::SoftAuthenticator;
    use super::*;

    fn rp() -> RelyingParty {
        RelyingParty::from_public_url("https://vault.example.com/").unwrap()
    }

    #[test]
    fn relying_party_from_the_public_url() {
        assert_eq!(rp().id, "vault.example.com");
        assert_eq!(rp().origin, "https://vault.example.com");
        let dev = RelyingParty::from_public_url("http://localhost:1430/app").unwrap();
        assert_eq!(
            (dev.id.as_str(), dev.origin.as_str()),
            ("localhost", "http://localhost:1430")
        );
        assert!(RelyingParty::from_public_url("vault.example.com").is_none());
    }

    #[test]
    fn a_passkey_registers_then_signs_in() {
        let rp = rp();
        let mut a = SoftAuthenticator::new(3);
        let (cd, att) = a.register(&rp.id, &rp.origin, b"challenge-1");
        let cred = verify_registration(&rp, b"challenge-1", &cd, &att).unwrap();
        assert_eq!(cred.id, a.credential_id);
        assert_eq!(cred.public_key, a.cose_key());

        let (cd, auth, sig) = a.assert(&rp.id, &rp.origin, b"challenge-2");
        let count = verify_assertion(&rp, b"challenge-2", &cred.public_key, 0, &cd, &auth, &sig).unwrap();
        assert_eq!(count, 1);
        // La même réponse rejouée : compteur en recul (et défi déjà utilisé,
        // côté route).
        assert_eq!(
            verify_assertion(&rp, b"challenge-2", &cred.public_key, count, &cd, &auth, &sig),
            Err(WebauthnError::Counter)
        );
    }

    #[test]
    fn wrong_challenge_origin_site_type_key_or_missing_verification_are_refused() {
        let rp = rp();
        let mut a = SoftAuthenticator::new(4);
        let (cd, att) = a.register(&rp.id, &rp.origin, b"c");
        let cred = verify_registration(&rp, b"c", &cd, &att).unwrap();
        assert_eq!(
            verify_registration(&rp, b"autre", &cd, &att),
            Err(WebauthnError::Challenge)
        );

        let (cd, att) = a.register(&rp.id, "https://evil.example", b"c");
        assert!(matches!(
            verify_registration(&rp, b"c", &cd, &att),
            Err(WebauthnError::Origin(_))
        ));
        let (cd, att) = a.register("evil.example", &rp.origin, b"c");
        assert_eq!(verify_registration(&rp, b"c", &cd, &att), Err(WebauthnError::RpId));

        // Une réponse de création présentée comme une connexion.
        let (cd, _) = a.register(&rp.id, &rp.origin, b"c");
        let (_, auth, sig) = a.assert(&rp.id, &rp.origin, b"c");
        assert_eq!(
            verify_assertion(&rp, b"c", &cred.public_key, 0, &cd, &auth, &sig),
            Err(WebauthnError::WrongType("webauthn.get"))
        );

        // Signée par une autre passkey.
        let mut other = SoftAuthenticator::new(5);
        let (cd, auth, sig) = other.assert(&rp.id, &rp.origin, b"d");
        assert_eq!(
            verify_assertion(&rp, b"d", &cred.public_key, 0, &cd, &auth, &sig),
            Err(WebauthnError::Signature)
        );

        // Sans vérification de l'utilisateur.
        a.user_verified = false;
        let (cd, auth, sig) = a.assert(&rp.id, &rp.origin, b"e");
        assert_eq!(
            verify_assertion(&rp, b"e", &cred.public_key, 0, &cd, &auth, &sig),
            Err(WebauthnError::UserVerification)
        );
        let (cd, att) = a.register(&rp.id, &rp.origin, b"f");
        assert_eq!(
            verify_registration(&rp, b"f", &cd, &att),
            Err(WebauthnError::UserVerification)
        );
    }

    #[test]
    fn ed25519_keys_verify() {
        use ed25519_dalek::Signer;
        let rp = rp();
        let sk = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let cose = {
            let map = Value::Map(vec![
                (Value::from(1), Value::from(1)),
                (Value::from(3), Value::from(-8)),
                (Value::from(-1), Value::from(6)),
                (Value::from(-2), Value::Bytes(sk.verifying_key().to_bytes().to_vec())),
            ]);
            let mut out = Vec::new();
            ciborium::ser::into_writer(&map, &mut out).unwrap();
            out
        };
        let cd = SoftAuthenticator::client_data("webauthn.get", &rp.origin, b"g");
        let mut auth = Sha256::digest(rp.id.as_bytes()).to_vec();
        auth.push(FLAG_UP | FLAG_UV);
        auth.extend_from_slice(&0u32.to_be_bytes());
        let mut signed = auth.clone();
        signed.extend_from_slice(&Sha256::digest(&cd));
        let sig = sk.sign(&signed).to_bytes();
        assert_eq!(verify_assertion(&rp, b"g", &cose, 0, &cd, &auth, &sig), Ok(0));
        assert_eq!(
            verify_assertion(&rp, b"g", &cose, 0, &cd, &auth, &[0u8; 64]),
            Err(WebauthnError::Signature)
        );
    }
}
