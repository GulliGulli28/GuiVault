//! Types JSON de l'API GuiVault. Un seul crate pour le serveur et les clients :
//! une réponse qui change ici casse la compilation des deux côtés au lieu de
//! diverger silencieusement.
//!
//! Tous les champs binaires (clés, enveloppes, chiffrés) voyagent en base64
//! standard (`String` côté JSON, `Vec<u8>` côté Rust — voir [`b64`]).
//!
//! Le serveur ne comprend rien au contenu des champs `*_enc`, `ciphertext`,
//! `protected_*` et `wrapped_*` : ce sont des blobs opaques produits par
//! `guivault-crypto` côté client.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use guivault_crypto::KdfParams;

/// Version du protocole, renvoyée par `GET /api/v1/health`. Le client refuse
/// un serveur dont la version majeure diffère.
pub const PROTOCOL_VERSION: u32 = 1;

/// Sérialisation base64 des `Vec<u8>`. Usage : `#[serde(with = "b64")]`.
pub mod b64 {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        STANDARD.encode(bytes).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s).map_err(serde::de::Error::custom)
    }

    /// Variante pour `Option<Vec<u8>>`.
    pub mod option {
        use super::*;

        pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
            bytes.as_ref().map(|b| STANDARD.encode(b)).serialize(s)
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
            let s = Option::<String>::deserialize(d)?;
            s.map(|s| STANDARD.decode(s).map_err(serde::de::Error::custom))
                .transpose()
        }
    }
}

// ─── Erreurs ────────────────────────────────────────────────────────────────

/// Corps de toute réponse d'erreur. `code` est stable et destiné au code
/// client ; `message` est destiné à l'humain et peut changer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

// ─── Santé ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub protocol_version: u32,
    pub server_version: String,
    pub registration: RegistrationMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationMode {
    /// N'importe qui peut créer un compte.
    Open,
    /// Il faut une invitation en attente sur son e-mail.
    InviteOnly,
    /// Aucune inscription (déjà tous les comptes qu'il faut).
    Closed,
}

// ─── Comptes et authentification ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreloginRequest {
    pub email: String,
}

/// Paramètres de dérivation à utiliser pour cet e-mail. Renvoyés même pour un
/// e-mail inconnu (valeurs déterministes dérivées côté serveur) : la réponse
/// ne révèle pas si le compte existe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreloginResponse {
    pub kdf: KdfParams,
    #[serde(with = "b64")]
    pub kdf_salt: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub kdf: KdfParams,
    #[serde(with = "b64")]
    pub kdf_salt: Vec<u8>,
    #[serde(with = "b64")]
    pub auth_key: Vec<u8>,
    #[serde(with = "b64")]
    pub protected_user_key: Vec<u8>,
    #[serde(with = "b64")]
    pub public_key: Vec<u8>,
    #[serde(with = "b64")]
    pub protected_private_key: Vec<u8>,
    /// Le vault personnel est créé avec le compte : son nom chiffré et sa clé
    /// enveloppée pour le nouvel utilisateur lui-même.
    pub personal_vault: CreateVaultRequest,
    /// Nom de l'appareil, affiché dans la liste des sessions.
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    #[serde(with = "b64")]
    pub auth_key: Vec<u8>,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
    /// Durée de vie du jeton d'accès, en secondes.
    pub access_expires_in: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    #[serde(flatten)]
    pub tokens: TokenPair,
    pub user: UserProfile,
    #[serde(with = "b64")]
    pub protected_user_key: Vec<u8>,
    #[serde(with = "b64")]
    pub protected_private_key: Vec<u8>,
}

/// Réponse `202` de `/auth/login` quand le compte a un second facteur : le
/// mot de passe est bon, il manque le code. `totp_token` est opaque et
/// expire en quelques minutes ; il s'échange contre une session sur
/// `/auth/totp/verify`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TotpChallenge {
    pub totp_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TotpVerifyRequest {
    pub totp_token: String,
    /// Code à 6 chiffres, ou un code de récupération.
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TotpStatus {
    pub enabled: bool,
}

/// Secret fraîchement généré, pas encore actif : l'utilisateur l'enregistre
/// dans son application puis prouve qu'il y arrive (`/auth/totp/enable`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TotpSetupResponse {
    /// Secret en base32, à saisir à la main dans l'application.
    pub secret: String,
    /// `otpauth://totp/...`, à encoder en QR côté client si désiré.
    pub otpauth_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TotpCodeRequest {
    pub code: String,
}

/// Codes de récupération, montrés **une seule fois**.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TotpEnableResponse {
    pub recovery_codes: Vec<String>,
}

/// Notification poussée sur `GET /events` (SSE). Dit *que* quelque chose a
/// changé, jamais *quoi* : le client resynchronise.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    /// Un item a été écrit ou supprimé, ou la clé a tourné.
    VaultChanged { vault_id: Uuid, revision: i64 },
    /// Une invitation vous attend.
    InvitationReceived { invitation_id: Uuid, vault_id: Uuid },
    /// Vous avez été ajouté, retiré, ou votre rôle a changé.
    MembershipChanged { vault_id: Uuid },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: Uuid,
    pub email: String,
    #[serde(with = "b64")]
    pub public_key: Vec<u8>,
    pub created_at: DateTime<Utc>,
}

/// Changement de mot de passe maître : le client prouve l'ancien, envoie le
/// nouveau matériel. Toutes les autres sessions sont révoquées.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangePasswordRequest {
    #[serde(with = "b64")]
    pub current_auth_key: Vec<u8>,
    pub kdf: KdfParams,
    #[serde(with = "b64")]
    pub kdf_salt: Vec<u8>,
    #[serde(with = "b64")]
    pub auth_key: Vec<u8>,
    #[serde(with = "b64")]
    pub protected_user_key: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: Uuid,
    pub device_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
    /// Vrai pour la session qui fait la requête.
    pub current: bool,
}

/// Clé publique d'un autre utilisateur, pour lui envelopper une clé de vault.
/// Le client DOIT afficher `fingerprint` et demander une vérification hors
/// bande avant le premier partage — voir `docs/SECURITY.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserLookupResponse {
    pub id: Uuid,
    pub email: String,
    #[serde(with = "b64")]
    pub public_key: Vec<u8>,
    pub fingerprint: String,
}

// ─── Vaults ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Lecture des items.
    Reader,
    /// + écriture/suppression des items.
    Writer,
    /// + gestion des membres et invitations.
    Admin,
    /// + suppression du vault, transfert de propriété. Un seul par vault.
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Reader => "reader",
            Role::Writer => "writer",
            Role::Admin => "admin",
            Role::Owner => "owner",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "reader" => Some(Role::Reader),
            "writer" => Some(Role::Writer),
            "admin" => Some(Role::Admin),
            "owner" => Some(Role::Owner),
            _ => None,
        }
    }

    pub fn can_write_items(self) -> bool {
        self >= Role::Writer
    }

    pub fn can_manage_members(self) -> bool {
        self >= Role::Admin
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultKind {
    /// Créé à l'inscription, un seul par utilisateur, non partageable.
    Personal,
    Shared,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateVaultRequest {
    /// Choisi par le client : l'id fait partie de l'AAD du nom chiffré, il
    /// doit donc être connu avant de chiffrer (même logique que les items).
    pub id: Uuid,
    /// Nom chiffré sous la clé du vault (`seal_vault_name`).
    #[serde(with = "b64")]
    pub name_enc: Vec<u8>,
    /// Clé du vault enveloppée pour le créateur lui-même.
    #[serde(with = "b64")]
    pub wrapped_vault_key: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameVaultRequest {
    #[serde(with = "b64")]
    pub name_enc: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vault {
    pub id: Uuid,
    pub kind: VaultKind,
    #[serde(with = "b64")]
    pub name_enc: Vec<u8>,
    /// Rôle de l'utilisateur qui fait la requête.
    pub role: Role,
    /// Clé du vault enveloppée pour l'utilisateur qui fait la requête.
    #[serde(with = "b64")]
    pub wrapped_vault_key: Vec<u8>,
    /// Compteur monotone incrémenté à chaque écriture d'item : si inchangé
    /// depuis la dernière synchronisation, rien à télécharger.
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMember {
    pub user_id: Uuid,
    pub email: String,
    #[serde(with = "b64")]
    pub public_key: Vec<u8>,
    pub fingerprint: String,
    pub role: Role,
    pub added_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMemberRequest {
    pub role: Role,
}

/// Ajout direct d'un utilisateur existant (le client a déjà sa clé publique
/// via `GET /users/lookup`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddMemberRequest {
    pub user_id: Uuid,
    pub role: Role,
    #[serde(with = "b64")]
    pub wrapped_vault_key: Vec<u8>,
}

/// Rotation de la clé d'un vault après le départ d'un membre : le client
/// génère une nouvelle clé, ré-enveloppe pour chaque membre restant et
/// re-chiffre tous les items. Appliqué atomiquement par le serveur.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RotateVaultKeyRequest {
    #[serde(with = "b64")]
    pub name_enc: Vec<u8>,
    pub members: Vec<RotatedMemberKey>,
    pub items: Vec<RotatedItem>,
    /// Révision attendue du vault : refusé (409) si quelqu'un a écrit entre-temps.
    pub base_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RotatedMemberKey {
    pub user_id: Uuid,
    #[serde(with = "b64")]
    pub wrapped_vault_key: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RotatedItem {
    pub id: Uuid,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
}

// ─── Invitations ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvitationStatus {
    /// En attente d'acceptation par l'invité.
    Pending,
    /// L'invité a accepté mais n'avait pas encore de clé publique au moment de
    /// l'invitation (pas encore inscrit) : l'inviteur doit fournir la clé
    /// enveloppée (`complete`) pour que l'appartenance soit créée.
    AwaitingKey,
    Accepted,
    Declined,
    Expired,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateInvitationRequest {
    pub email: String,
    pub role: Role,
    /// Absent si l'invité n'a pas encore de compte (l'inviteur complétera
    /// après son inscription).
    #[serde(default, with = "b64::option")]
    pub wrapped_vault_key: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompleteInvitationRequest {
    #[serde(with = "b64")]
    pub wrapped_vault_key: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invitation {
    pub id: Uuid,
    pub vault_id: Uuid,
    pub inviter_email: String,
    pub invitee_email: String,
    /// Clé publique de l'invité si déjà inscrit — pour que l'inviteur puisse
    /// compléter l'invitation après vérification de l'empreinte.
    #[serde(default, with = "b64::option")]
    pub invitee_public_key: Option<Vec<u8>>,
    pub invitee_fingerprint: Option<String>,
    pub role: Role,
    pub status: InvitationStatus,
    pub has_key: bool,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

// ─── Items ──────────────────────────────────────────────────────────────────

/// Un item chiffré. `item_type` est en clair (le client filtre sans
/// déchiffrer) mais lié au chiffré par l'AAD : le serveur ne peut pas le
/// changer sans que le client s'en aperçoive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: Uuid,
    pub vault_id: Uuid,
    pub item_type: String,
    pub revision: i64,
    /// Vide pour une pierre tombale (`deleted = true`).
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
    pub deleted: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutItemRequest {
    pub item_type: String,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
    /// Révision que le client pense être la dernière de cet item. `None` pour
    /// une création. Si elle ne correspond pas : 409 avec l'item courant.
    #[serde(default)]
    pub base_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemsPage {
    pub items: Vec<Item>,
    /// Révision du vault au moment de la réponse — à mémoriser pour le
    /// prochain `?since=`.
    pub revision: i64,
}

/// Résumé de tout ce que voit l'utilisateur : ses vaults (avec révisions) et
/// ses invitations. Un seul appel au démarrage pour savoir quoi rafraîchir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResponse {
    pub user: UserProfile,
    pub vaults: Vec<Vault>,
    pub invitations: Vec<Invitation>,
    pub server_time: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_roundtrip_and_option() {
        let req = CreateInvitationRequest {
            email: "a@b".into(),
            role: Role::Writer,
            wrapped_vault_key: Some(vec![1, 2, 3]),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"AQID\""));
        let back: CreateInvitationRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.wrapped_vault_key, Some(vec![1, 2, 3]));
        let none: CreateInvitationRequest = serde_json::from_str(r#"{"email":"a@b","role":"reader"}"#).unwrap();
        assert_eq!(none.wrapped_vault_key, None);
    }

    #[test]
    fn roles_order() {
        assert!(Role::Owner > Role::Admin && Role::Admin > Role::Writer && Role::Writer > Role::Reader);
        assert!(Role::Writer.can_write_items() && !Role::Reader.can_write_items());
        assert!(Role::Admin.can_manage_members() && !Role::Writer.can_manage_members());
        assert_eq!(Role::parse("admin"), Some(Role::Admin));
    }
}
