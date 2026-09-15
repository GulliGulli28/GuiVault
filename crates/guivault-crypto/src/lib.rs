//! Primitives cryptographiques de GuiVault, partagées entre le serveur et les
//! clients (Guiterm en premier). Tout ce qui touche à un secret en clair vit
//! ici et s'exécute **côté client** ; le serveur n'utilise de ce crate que
//! [`hash_auth_key`]/[`verify_auth_key`], [`token_hash`] et [`random_bytes`].
//!
//! # Hiérarchie de clés (zero-knowledge)
//!
//! ```text
//! mot de passe maître ─Argon2id(sel utilisateur)─▶ master key (32 o)
//!                                                     │
//!                        ┌── HKDF("guivault/v1/enc") ─┴─ HKDF("guivault/v1/auth") ──┐
//!                        ▼                                                          ▼
//!                  stretched key                                              auth key ──▶ envoyée au
//!                        │ enveloppe (XChaCha20-Poly1305)                                serveur, qui la
//!                        ▼                                                                re-hache (Argon2id)
//!                  user key (32 o, aléatoire)                                             avant stockage
//!                        │ enveloppe
//!                        ▼
//!                clé privée X25519  ◀── déscelle ── vault key (32 o, aléatoire, une par vault)
//!                                                      │ enveloppe, AAD = vault_id‖item_id‖type
//!                                                      ▼
//!                                                   items (hôtes, clés SSH, mots de passe…)
//! ```
//!
//! - Changer le mot de passe maître ne ré-enveloppe que la *user key*.
//! - Partager un vault = sceller sa *vault key* vers la clé publique X25519 du
//!   destinataire (boîte scellée libsodium, [`seal_for`]) — le serveur ne
//!   transporte que des enveloppes.
//! - La clé d'authentification est dérivée par HKDF *à côté* de la clé de
//!   chiffrement, jamais à partir d'elle : la connaître ne donne rien sur les
//!   données.
//!
//! # Formats binaires
//!
//! Toutes les enveloppes commencent par un octet de version (`0x01`) pour
//! pouvoir changer d'algorithme sans casser les blobs existants.
//!
//! - Enveloppe symétrique : `0x01 ‖ nonce(24) ‖ ciphertext‖tag(16)`.
//! - Boîte scellée : `0x01 ‖ éphémère_pk(32) ‖ ciphertext‖tag(16)`.
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

pub use crypto_box::{PublicKey, SecretKey as PrivateKey};

pub const KEY_LEN: usize = 32;
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24;
pub const TAG_LEN: usize = 16;
const FORMAT_V1: u8 = 0x01;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("paramètres Argon2 invalides : {0}")]
    KdfParams(String),
    #[error("dérivation de clé impossible")]
    Kdf,
    #[error("enveloppe illisible (format ou version inconnus)")]
    Format,
    #[error("déchiffrement refusé : clé ou données incorrectes")]
    Decrypt,
    #[error("chiffrement impossible")]
    Encrypt,
    #[error("hash de mot de passe invalide")]
    PasswordHash,
}

// ─── Aléa ────────────────────────────────────────────────────────────────────

/// `n` octets depuis le CSPRNG de l'OS.
pub fn random_bytes(n: usize) -> Vec<u8> {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut b = vec![0u8; n];
    OsRng.fill_bytes(&mut b);
    b
}

pub fn random_salt() -> [u8; SALT_LEN] {
    let mut s = [0u8; SALT_LEN];
    s.copy_from_slice(&random_bytes(SALT_LEN));
    s
}

// ─── Clés symétriques ────────────────────────────────────────────────────────

/// Une clé de 32 octets effacée à la destruction.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SymmetricKey([u8; KEY_LEN]);

impl SymmetricKey {
    pub fn random() -> Self {
        let mut k = [0u8; KEY_LEN];
        k.copy_from_slice(&random_bytes(KEY_LEN));
        Self(k)
    }

    pub fn from_bytes(b: [u8; KEY_LEN]) -> Self {
        Self(b)
    }

    pub fn from_slice(b: &[u8]) -> Result<Self, CryptoError> {
        let arr: [u8; KEY_LEN] = b.try_into().map_err(|_| CryptoError::Format)?;
        Ok(Self(arr))
    }

    /// Accès brut — réservé à l'enveloppage d'une clé dans une autre.
    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl std::fmt::Debug for SymmetricKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SymmetricKey(…)")
    }
}

/// Chiffre `plaintext` sous `key` en liant `aad` (non chiffré, mais
/// authentifié : un blob déplacé dans un autre contexte ne s'ouvre plus).
pub fn seal(key: &SymmetricKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.0));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad })
        .map_err(|_| CryptoError::Encrypt)?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + ct.len());
    out.push(FORMAT_V1);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Inverse de [`seal`]. Le déchiffrement échoue sans distinguer « mauvaise
/// clé », « mauvais AAD » et « données altérées » — c'est voulu.
pub fn open(key: &SymmetricKey, blob: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let (&version, rest) = blob.split_first().ok_or(CryptoError::Format)?;
    if version != FORMAT_V1 || rest.len() < NONCE_LEN + TAG_LEN {
        return Err(CryptoError::Format);
    }
    let (nonce, ct) = rest.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key.0));
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| CryptoError::Decrypt)
}

// ─── Dérivation depuis le mot de passe maître ───────────────────────────────

/// Paramètres Argon2id, stockés côté serveur et renvoyés au client avant la
/// connexion (« prelogin ») pour qu'un même compte se dérive à l'identique
/// depuis n'importe quelle machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for KdfParams {
    /// ~64 MiB, 3 passes : quelques centaines de ms sur un poste de travail,
    /// très coûteux en force brute hors ligne. Mêmes valeurs que le coffre
    /// local de Guiterm.
    fn default() -> Self {
        Self {
            m_cost: 65536,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

impl KdfParams {
    /// Bornes acceptées par le serveur : refuse un client qui demanderait des
    /// paramètres trop faibles (compte cassable) ou absurdes (DoS du client).
    pub fn is_sane(&self) -> bool {
        (19_456..=1_048_576).contains(&self.m_cost) && (2..=10).contains(&self.t_cost) && (1..=8).contains(&self.p_cost)
    }

    fn argon(&self) -> Result<Argon2<'static>, CryptoError> {
        let p = Params::new(self.m_cost, self.t_cost, self.p_cost, Some(KEY_LEN))
            .map_err(|e| CryptoError::KdfParams(e.to_string()))?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, p))
    }
}

/// La clé maître : jamais utilisée directement, seulement via ses deux
/// sous-clés HKDF.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct MasterKey([u8; KEY_LEN]);

impl MasterKey {
    pub fn derive(password: &str, salt: &[u8], params: KdfParams) -> Result<Self, CryptoError> {
        let argon = params.argon()?;
        let mut key = [0u8; KEY_LEN];
        argon
            .hash_password_into(password.as_bytes(), salt, &mut key)
            .map_err(|_| CryptoError::Kdf)?;
        Ok(Self(key))
    }

    fn expand(&self, info: &[u8]) -> [u8; KEY_LEN] {
        let hk = Hkdf::<Sha256>::new(None, &self.0);
        let mut out = [0u8; KEY_LEN];
        hk.expand(info, &mut out)
            .expect("32 octets est une longueur HKDF valide");
        out
    }

    /// Clé qui enveloppe la *user key*. Ne quitte jamais le client.
    pub fn stretched_key(&self) -> SymmetricKey {
        SymmetricKey(self.expand(b"guivault/v1/enc"))
    }

    /// Preuve de possession envoyée au serveur à la place du mot de passe.
    pub fn auth_key(&self) -> AuthKey {
        AuthKey(self.expand(b"guivault/v1/auth"))
    }
}

/// 32 octets présentés au serveur comme « mot de passe ». Le serveur les
/// re-hache avec Argon2id avant stockage ([`hash_auth_key`]) : une fuite de la
/// base ne permet ni de se connecter ni de retrouver la clé maître.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct AuthKey([u8; KEY_LEN]);

impl AuthKey {
    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    pub fn from_slice(b: &[u8]) -> Result<Self, CryptoError> {
        let arr: [u8; KEY_LEN] = b.try_into().map_err(|_| CryptoError::Format)?;
        Ok(Self(arr))
    }
}

// ─── Côté serveur : hachage de la clé d'auth et des jetons ──────────────────

/// Paramètres Argon2id côté serveur — plus légers que ceux du client (le
/// serveur les paie à chaque connexion, et l'entrée est déjà 32 octets
/// aléatoires, pas un mot de passe humain). Recommandation OWASP 2023.
fn server_argon() -> Argon2<'static> {
    let p = Params::new(19_456, 2, 1, Some(KEY_LEN)).expect("paramètres constants valides");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, p)
}

/// Chaîne PHC (`$argon2id$v=19$m=…`) à stocker en base.
pub fn hash_auth_key(auth_key: &[u8]) -> Result<String, CryptoError> {
    let salt = SaltString::generate(&mut OsRng);
    server_argon()
        .hash_password(auth_key, &salt)
        .map(|h| h.to_string())
        .map_err(|_| CryptoError::PasswordHash)
}

/// Vérification en temps constant contre une chaîne PHC.
pub fn verify_auth_key(auth_key: &[u8], phc: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else {
        return false;
    };
    server_argon().verify_password(auth_key, &parsed).is_ok()
}

/// Empreinte SHA-256 d'un jeton opaque : le serveur ne stocke jamais le jeton
/// lui-même, seulement ceci — une lecture de la base ne donne pas de session.
pub fn token_hash(token: &[u8]) -> [u8; 32] {
    Sha256::digest(token).into()
}

// ─── Clés publiques : partage ───────────────────────────────────────────────

/// Paire X25519 d'un utilisateur. La clé publique est publiée par le serveur ;
/// la clé privée est stockée enveloppée sous la *user key*.
pub struct KeyPair {
    pub public: PublicKey,
    pub private: PrivateKey,
}

impl KeyPair {
    pub fn generate() -> Self {
        let private = PrivateKey::generate(&mut OsRng);
        Self {
            public: private.public_key(),
            private,
        }
    }
}

/// Boîte scellée libsodium vers `recipient` (X25519 éphémère + XSalsa20-
/// Poly1305). Sert à transmettre une *vault key* à un membre.
pub fn seal_for(recipient: &PublicKey, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let sealed = recipient
        .seal(&mut OsRng, plaintext)
        .map_err(|_| CryptoError::Encrypt)?;
    let mut out = Vec::with_capacity(1 + sealed.len());
    out.push(FORMAT_V1);
    out.extend_from_slice(&sealed);
    Ok(out)
}

pub fn unseal(private: &PrivateKey, blob: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let (&version, rest) = blob.split_first().ok_or(CryptoError::Format)?;
    if version != FORMAT_V1 {
        return Err(CryptoError::Format);
    }
    private.unseal(rest).map_err(|_| CryptoError::Decrypt)
}

/// Empreinte lisible d'une clé publique, à comparer hors bande (voix, chat
/// interne…) avant de partager un vault : c'est la seule défense contre un
/// serveur qui substituerait sa propre clé publique à celle du destinataire.
pub fn fingerprint(public: &PublicKey) -> String {
    let h = Sha256::digest(public.as_bytes());
    h[..16]
        .chunks(2)
        .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
        .collect::<Vec<_>>()
        .join("-")
}

// ─── Compte : création et déverrouillage ────────────────────────────────────

/// Ce que le client envoie au serveur à l'inscription. Aucun champ ne permet
/// de retrouver un secret sans le mot de passe maître.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountMaterial {
    pub kdf: KdfParams,
    pub kdf_salt: Vec<u8>,
    pub auth_key: Vec<u8>,
    /// *user key* enveloppée sous la *stretched key*.
    pub protected_user_key: Vec<u8>,
    pub public_key: Vec<u8>,
    /// Clé privée X25519 enveloppée sous la *user key*.
    pub protected_private_key: Vec<u8>,
}

/// Le compte une fois déverrouillé, en mémoire client seulement.
pub struct UnlockedAccount {
    pub user_key: SymmetricKey,
    pub keypair: KeyPair,
}

const AAD_USER_KEY: &[u8] = b"guivault/v1/user-key";
const AAD_PRIVATE_KEY: &[u8] = b"guivault/v1/private-key";

/// Génère tout le matériel d'un nouveau compte à partir du mot de passe
/// maître. Retourne aussi le compte déverrouillé pour enchaîner sans
/// re-dériver.
pub fn create_account(password: &str) -> Result<(AccountMaterial, UnlockedAccount), CryptoError> {
    let kdf = KdfParams::default();
    let salt = random_salt();
    let master = MasterKey::derive(password, &salt, kdf)?;
    let user_key = SymmetricKey::random();
    let keypair = KeyPair::generate();

    let protected_user_key = seal(&master.stretched_key(), user_key.as_bytes(), AAD_USER_KEY)?;
    let protected_private_key = seal(&user_key, &keypair.private.to_bytes(), AAD_PRIVATE_KEY)?;

    let material = AccountMaterial {
        kdf,
        kdf_salt: salt.to_vec(),
        auth_key: master.auth_key().as_bytes().to_vec(),
        protected_user_key,
        public_key: keypair.public.as_bytes().to_vec(),
        protected_private_key,
    };
    Ok((material, UnlockedAccount { user_key, keypair }))
}

/// Ce qu'il faut pour se connecter : la clé d'auth à présenter au serveur, et
/// la clé qui ouvrira la *user key* une fois le serveur d'accord.
pub struct LoginMaterial {
    pub auth_key: AuthKey,
    pub stretched_key: SymmetricKey,
}

pub fn prepare_login(password: &str, salt: &[u8], kdf: KdfParams) -> Result<LoginMaterial, CryptoError> {
    let master = MasterKey::derive(password, salt, kdf)?;
    Ok(LoginMaterial {
        auth_key: master.auth_key(),
        stretched_key: master.stretched_key(),
    })
}

/// Déverrouille le compte à partir des blobs renvoyés par le serveur après
/// connexion. Un mauvais mot de passe échoue ici (tag AEAD) — le serveur,
/// lui, l'aura déjà refusé sur la clé d'auth.
pub fn unlock_account(
    stretched_key: &SymmetricKey,
    protected_user_key: &[u8],
    protected_private_key: &[u8],
) -> Result<UnlockedAccount, CryptoError> {
    let user_key = SymmetricKey::from_slice(&open(stretched_key, protected_user_key, AAD_USER_KEY)?)?;
    let private_bytes = open(&user_key, protected_private_key, AAD_PRIVATE_KEY)?;
    let private = PrivateKey::try_from(private_bytes.as_slice()).map_err(|_| CryptoError::Format)?;
    let keypair = KeyPair {
        public: private.public_key(),
        private,
    };
    Ok(UnlockedAccount { user_key, keypair })
}

/// Changement de mot de passe maître : seule la *user key* est ré-enveloppée.
/// Retourne le nouveau sel, la nouvelle clé d'auth et la nouvelle enveloppe.
pub struct RekeyMaterial {
    pub kdf: KdfParams,
    pub kdf_salt: Vec<u8>,
    pub auth_key: Vec<u8>,
    pub protected_user_key: Vec<u8>,
}

pub fn rekey_account(account: &UnlockedAccount, new_password: &str) -> Result<RekeyMaterial, CryptoError> {
    let kdf = KdfParams::default();
    let salt = random_salt();
    let master = MasterKey::derive(new_password, &salt, kdf)?;
    Ok(RekeyMaterial {
        kdf,
        kdf_salt: salt.to_vec(),
        auth_key: master.auth_key().as_bytes().to_vec(),
        protected_user_key: seal(&master.stretched_key(), account.user_key.as_bytes(), AAD_USER_KEY)?,
    })
}

// ─── Vaults et items ────────────────────────────────────────────────────────

/// Enveloppe une *vault key* pour un membre : boîte scellée vers sa clé
/// publique. C'est ce blob qui est stocké sur son appartenance au vault.
pub fn wrap_vault_key(recipient: &PublicKey, vault_key: &SymmetricKey) -> Result<Vec<u8>, CryptoError> {
    seal_for(recipient, vault_key.as_bytes())
}

pub fn unwrap_vault_key(account: &UnlockedAccount, wrapped: &[u8]) -> Result<SymmetricKey, CryptoError> {
    SymmetricKey::from_slice(&unseal(&account.keypair.private, wrapped)?)
}

/// AAD d'un item : lie le chiffré à son vault, son identifiant et son type.
/// Le serveur ne peut ni déplacer un item d'un vault à l'autre ni le faire
/// passer pour un autre type sans que le client le détecte.
pub fn item_aad(vault_id: &str, item_id: &str, item_type: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(vault_id.len() + item_id.len() + item_type.len() + 20);
    aad.extend_from_slice(b"guivault/v1/item\0");
    aad.extend_from_slice(vault_id.as_bytes());
    aad.push(0);
    aad.extend_from_slice(item_id.as_bytes());
    aad.push(0);
    aad.extend_from_slice(item_type.as_bytes());
    aad
}

pub fn seal_item(
    vault_key: &SymmetricKey,
    vault_id: &str,
    item_id: &str,
    item_type: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    seal(vault_key, plaintext, &item_aad(vault_id, item_id, item_type))
}

pub fn open_item(
    vault_key: &SymmetricKey,
    vault_id: &str,
    item_id: &str,
    item_type: &str,
    blob: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    open(vault_key, blob, &item_aad(vault_id, item_id, item_type))
}

/// Le nom d'un vault est lui aussi chiffré (sous la vault key) : le serveur ne
/// sait pas qu'un vault s'appelle « Prod bancaire ».
pub fn seal_vault_name(vault_key: &SymmetricKey, vault_id: &str, name: &str) -> Result<Vec<u8>, CryptoError> {
    seal(vault_key, name.as_bytes(), &item_aad(vault_id, "", "vault-name"))
}

pub fn open_vault_name(vault_key: &SymmetricKey, vault_id: &str, blob: &[u8]) -> Result<String, CryptoError> {
    let bytes = open(vault_key, blob, &item_aad(vault_id, "", "vault-name"))?;
    String::from_utf8(bytes).map_err(|_| CryptoError::Format)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Paramètres légers : les tests ne mesurent pas la résistance à la force
    // brute, ils vérifient la mécanique.
    fn fast_kdf() -> KdfParams {
        KdfParams {
            m_cost: 19_456,
            t_cost: 2,
            p_cost: 1,
        }
    }

    #[test]
    fn seal_open_roundtrip_and_aad_binding() {
        let k = SymmetricKey::random();
        let blob = seal(&k, b"hello", b"ctx-a").unwrap();
        assert_eq!(open(&k, &blob, b"ctx-a").unwrap(), b"hello");
        assert!(matches!(open(&k, &blob, b"ctx-b"), Err(CryptoError::Decrypt)));
        assert!(matches!(
            open(&SymmetricKey::random(), &blob, b"ctx-a"),
            Err(CryptoError::Decrypt)
        ));
        // Version inconnue → Format, jamais un déchiffrement tenté.
        let mut bad = blob.clone();
        bad[0] = 0x7f;
        assert!(matches!(open(&k, &bad, b"ctx-a"), Err(CryptoError::Format)));
        assert!(matches!(open(&k, &[], b"ctx-a"), Err(CryptoError::Format)));
    }

    #[test]
    fn auth_and_enc_keys_are_independent_and_deterministic() {
        let salt = random_salt();
        let m1 = MasterKey::derive("correct horse", &salt, fast_kdf()).unwrap();
        let m2 = MasterKey::derive("correct horse", &salt, fast_kdf()).unwrap();
        assert_eq!(m1.auth_key().as_bytes(), m2.auth_key().as_bytes());
        assert_eq!(m1.stretched_key().as_bytes(), m2.stretched_key().as_bytes());
        assert_ne!(m1.auth_key().as_bytes(), m1.stretched_key().as_bytes());
        let m3 = MasterKey::derive("correct horse", &random_salt(), fast_kdf()).unwrap();
        assert_ne!(m1.auth_key().as_bytes(), m3.auth_key().as_bytes());
    }

    #[test]
    fn server_side_auth_hash_verifies() {
        let ak = random_bytes(32);
        let phc = hash_auth_key(&ak).unwrap();
        assert!(phc.starts_with("$argon2id$"));
        assert!(verify_auth_key(&ak, &phc));
        assert!(!verify_auth_key(&random_bytes(32), &phc));
        assert!(!verify_auth_key(&ak, "not-a-phc"));
    }

    #[test]
    fn account_lifecycle_share_and_rekey() {
        // Alice crée son compte…
        let (mat, alice) = create_account("alice-pw").unwrap();
        assert_eq!(mat.public_key, alice.keypair.public.as_bytes());

        // …se reconnecte depuis une autre machine (mêmes blobs, même mot de passe).
        let login = prepare_login("alice-pw", &mat.kdf_salt, mat.kdf).unwrap();
        assert_eq!(login.auth_key.as_bytes().as_slice(), mat.auth_key.as_slice());
        let alice2 = unlock_account(
            &login.stretched_key,
            &mat.protected_user_key,
            &mat.protected_private_key,
        )
        .unwrap();
        assert_eq!(alice2.user_key.as_bytes(), alice.user_key.as_bytes());
        assert_eq!(alice2.keypair.public, alice.keypair.public);

        // Mauvais mot de passe : la clé d'auth diffère ET l'enveloppe ne s'ouvre pas.
        let wrong = prepare_login("alice-pw-typo", &mat.kdf_salt, mat.kdf).unwrap();
        assert_ne!(wrong.auth_key.as_bytes().as_slice(), mat.auth_key.as_slice());
        assert!(
            unlock_account(
                &wrong.stretched_key,
                &mat.protected_user_key,
                &mat.protected_private_key
            )
            .is_err()
        );

        // Un vault, un item, partagé avec Bob.
        let (bob_mat, bob) = create_account("bob-pw").unwrap();
        let vault_key = SymmetricKey::random();
        let vault_id = "v-1";
        let item = seal_item(&vault_key, vault_id, "i-1", "host", b"{\"host\":\"db1\"}").unwrap();
        let bob_pk = PublicKey::try_from(bob_mat.public_key.as_slice()).unwrap();
        let wrapped_for_bob = wrap_vault_key(&bob_pk, &vault_key).unwrap();
        let bob_vault_key = unwrap_vault_key(&bob, &wrapped_for_bob).unwrap();
        assert_eq!(
            open_item(&bob_vault_key, vault_id, "i-1", "host", &item).unwrap(),
            b"{\"host\":\"db1\"}"
        );
        // Le serveur déplace l'item dans un autre vault / lui change son type → refus.
        assert!(open_item(&bob_vault_key, "v-2", "i-1", "host", &item).is_err());
        assert!(open_item(&bob_vault_key, vault_id, "i-1", "ssh-key", &item).is_err());
        // Alice ne peut pas ouvrir l'enveloppe destinée à Bob.
        assert!(unwrap_vault_key(&alice, &wrapped_for_bob).is_err());

        // Alice change de mot de passe : sa user key ne bouge pas.
        let rk = rekey_account(&alice, "alice-new-pw").unwrap();
        assert_ne!(rk.auth_key, mat.auth_key);
        let login = prepare_login("alice-new-pw", &rk.kdf_salt, rk.kdf).unwrap();
        let alice3 = unlock_account(&login.stretched_key, &rk.protected_user_key, &mat.protected_private_key).unwrap();
        assert_eq!(alice3.user_key.as_bytes(), alice.user_key.as_bytes());
    }

    #[test]
    fn vault_name_roundtrip() {
        let k = SymmetricKey::random();
        let blob = seal_vault_name(&k, "v-1", "Prod").unwrap();
        assert_eq!(open_vault_name(&k, "v-1", &blob).unwrap(), "Prod");
        assert!(open_vault_name(&k, "v-2", &blob).is_err());
    }

    #[test]
    fn fingerprint_is_stable_and_readable() {
        let kp = KeyPair::generate();
        let fp = fingerprint(&kp.public);
        assert_eq!(fp, fingerprint(&kp.public));
        assert_eq!(fp.split('-').count(), 8);
        assert_ne!(fp, fingerprint(&KeyPair::generate().public));
    }

    #[test]
    fn kdf_params_bounds() {
        assert!(KdfParams::default().is_sane());
        assert!(fast_kdf().is_sane());
        assert!(
            !KdfParams {
                m_cost: 1024,
                t_cost: 1,
                p_cost: 1
            }
            .is_sane()
        );
        assert!(
            !KdfParams {
                m_cost: 65536,
                t_cost: 1,
                p_cost: 1
            }
            .is_sane()
        );
    }
}
