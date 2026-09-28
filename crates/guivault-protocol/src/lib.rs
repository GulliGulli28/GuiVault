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
    /// Durée de vie maximale d'un lien de partage, en jours ; `0` : liens
    /// désactivés sur ce serveur (ou serveur d'avant les liens).
    #[serde(default)]
    pub send_max_days: u32,
    /// Le serveur relaie les recherches du rapport de santé (fuites, sites
    /// qui proposent la 2FA) ; faux : désactivées (ou serveur plus ancien).
    #[serde(default)]
    pub health_lookups: bool,
}

/// Un site qui accepte un code TOTP (liste publique 2fa.directory, relayée
/// par `GET /lookups/2fa-directory`) : le rapport de santé signale un
/// identifiant de ce site qui n'a pas de secret TOTP.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TwoFactorSite {
    pub name: String,
    /// Domaine principal, puis les autres.
    pub domains: Vec<String>,
    /// La page qui explique comment l'activer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documentation: Option<String>,
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
    /// Vos réglages synchronisés ont changé (depuis un autre appareil).
    SettingsChanged { revision: i64 },
    /// Un accès d'urgence où vous êtes l'une des deux parties a changé
    /// (désignation, acceptation, demande, accord, refus, retrait).
    EmergencyChanged { grant_id: Uuid },
}

/// Les réglages synchronisés d'un utilisateur (apparence, générateur,
/// extension…) : un blob scellé sous sa *user key*
/// (`guivault_crypto::seal_user_settings`). Le serveur les garde pour ses
/// autres appareils sans pouvoir les lire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettings {
    #[serde(with = "b64")]
    pub blob: Vec<u8>,
    pub revision: i64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PutUserSettingsRequest {
    #[serde(with = "b64")]
    pub blob: Vec<u8>,
    /// La révision que le client a lue ; `None` s'il n'en a lu aucune. Si
    /// elle ne correspond pas : 409 avec les réglages courants.
    #[serde(default)]
    pub base_revision: Option<i64>,
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
    /// Administrateur du serveur (routes `/admin/*`). Absent : non.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_admin: bool,
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

/// Suppression du compte : le mot de passe maître (sa clé d'auth) le prouve,
/// et le code du second facteur s'il est actif. Refusée (`409
/// owns_shared_vaults`, ids dans `vaults`) tant que le compte possède un
/// vault partagé qui a d'autres membres.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteAccountRequest {
    #[serde(with = "b64")]
    pub auth_key: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_code: Option<String>,
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
    /// Les versions précédentes des items (historique et corbeille),
    /// re-chiffrées sous la nouvelle clé : **toutes** celles que le serveur
    /// garde (`GET /vaults/{id}/versions`), sinon 400 `incomplete_rotation`.
    /// Absent (client d'avant l'historique) : le serveur les efface — il ne
    /// garde pas de versions que plus personne ne saurait ouvrir.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub versions: Option<Vec<RotatedVersion>>,
    /// Les enveloppes d'urgence du vault, ré-enveloppées sous la nouvelle clé
    /// (`wrap_emergency_key`) pour **tous** les contacts qui le couvrent —
    /// seul le propriétaire peut les produire (le contact vérifie que c'est
    /// lui l'expéditeur). Absent (autre rôle, client plus ancien) : elles
    /// sont marquées à renouveler, et le propriétaire les refait plus tard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emergency: Option<Vec<RotatedEmergencyKey>>,
    /// Révision attendue du vault : refusé (409) si quelqu'un a écrit entre-temps.
    pub base_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RotatedVersion {
    pub item_id: Uuid,
    pub revision: i64,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RotatedEmergencyKey {
    pub grant_id: Uuid,
    #[serde(with = "b64")]
    pub wrapped_vault_key: Vec<u8>,
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
    /// L'enveloppe de la clé du vault, adressée à l'invité : il l'ouvre
    /// **avant** d'accepter pour voir qui la lui remet (format 2, empreinte
    /// de l'expéditeur). Absente d'un serveur plus ancien.
    #[serde(default, with = "b64::option", skip_serializing_if = "Option::is_none")]
    pub wrapped_vault_key: Option<Vec<u8>>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

// ─── Accès d'urgence ────────────────────────────────────────────────────────
//
// Un utilisateur (le « donneur ») désigne un proche (le « contact ») et lui
// enveloppe la clé de certains de ses vaults (`wrap_emergency_key`). Le
// serveur garde ces enveloppes sans pouvoir les ouvrir, et ne les remet au
// contact qu'après qu'il a demandé l'accès **et** que le délai d'attente
// s'est écoulé sans refus du donneur (ou que celui-ci a accordé plus tôt).

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmergencyStatus {
    /// Désigné, pas encore accepté par le contact.
    Invited,
    /// Accepté ; aucune demande en cours.
    Accepted,
    /// Le contact a demandé l'accès : il l'aura à `access_at` sauf refus.
    Requested,
    /// Accès accordé (délai écoulé, ou accord du donneur) : le contact lit
    /// les vaults couverts, jusqu'à ce que le donneur reprenne la main.
    Granted,
}

/// L'une des deux parties, avec sa clé publique : chacune vérifie l'empreinte
/// de l'autre hors bande, comme pour un partage de vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmergencyParty {
    pub id: Uuid,
    pub email: String,
    #[serde(with = "b64")]
    pub public_key: Vec<u8>,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmergencyVaultRef {
    pub vault_id: Uuid,
    /// Faux : la clé du vault a tourné sans que le donneur ré-enveloppe pour
    /// ce contact — ce vault ne lui serait pas remis.
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmergencyGrant {
    pub id: Uuid,
    pub grantor: EmergencyParty,
    pub grantee: EmergencyParty,
    /// Délai entre la demande et l'accès, en jours.
    pub wait_days: u32,
    pub status: EmergencyStatus,
    pub requested_at: Option<DateTime<Utc>>,
    /// Quand l'accès est (ou a été) accordé : fin du délai, ou accord
    /// anticipé. `None` sans demande en cours.
    pub access_at: Option<DateTime<Utc>>,
    pub vaults: Vec<EmergencyVaultRef>,
    pub created_at: DateTime<Utc>,
}

/// `GET /emergency` : ceux que j'ai désignés, et ceux qui m'ont désigné.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmergencyOverview {
    pub granted_by_me: Vec<EmergencyGrant>,
    pub granted_to_me: Vec<EmergencyGrant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmergencyVaultKey {
    pub vault_id: Uuid,
    /// `wrap_emergency_key` du donneur vers le contact.
    #[serde(with = "b64")]
    pub wrapped_vault_key: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateEmergencyGrantRequest {
    /// Le contact, déjà inscrit (sa clé publique vient de `/users/lookup`,
    /// empreinte vérifiée).
    pub grantee_id: Uuid,
    pub wait_days: u32,
    /// Des vaults dont le donneur est propriétaire.
    pub vaults: Vec<EmergencyVaultKey>,
}

/// Changer le délai, ou l'ensemble des vaults couverts (remplacé en entier :
/// c'est aussi ainsi qu'on renouvelle une enveloppe après une rotation).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateEmergencyGrantRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_days: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vaults: Option<Vec<EmergencyVaultKey>>,
}

/// Un vault remis au contact une fois l'accès accordé : de quoi l'ouvrir
/// (`unwrap_emergency_key`) et en lire les items, en lecture seule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmergencyVault {
    pub id: Uuid,
    pub kind: VaultKind,
    #[serde(with = "b64")]
    pub name_enc: Vec<u8>,
    #[serde(with = "b64")]
    pub wrapped_vault_key: Vec<u8>,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ─── Liens de partage (éphémères) ───────────────────────────────────────────
//
// Un contenu chiffré sous une clé tirée d'un secret qui ne voyage que dans le
// fragment de l'URL (`#/send/<id>/<secret>`) — voir `guivault_crypto::send_keys`.
// Le serveur garde le chiffré, l'expiration et le compte des vues ; il ne
// remet le chiffré qu'à qui présente la clé d'accès, tirée du même secret.

/// Le mot de passe facultatif d'un lien : de quoi le dériver
/// (`send_password_key`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendPassword {
    pub kdf: KdfParams,
    #[serde(with = "b64")]
    pub salt: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSendRequest {
    /// Choisi par le client : il est dans l'AAD du contenu.
    pub id: Uuid,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
    /// SHA-256 de la clé d'accès (`token_hash`) — jamais la clé.
    #[serde(with = "b64")]
    pub access_hash: Vec<u8>,
    /// Ce que l'auteur garde pour lui, sous sa user key (`seal_send_owner`).
    #[serde(with = "b64")]
    pub owner_blob: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<SendPassword>,
    /// Nombre d'ouvertures au plus ; `None` : jusqu'à l'expiration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_views: Option<u32>,
    /// Durée de vie, en secondes (une heure au moins, `send_max_days` au plus).
    pub expires_in_secs: u64,
}

/// Un lien, vu par son auteur (`GET /sends`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendSummary {
    pub id: Uuid,
    #[serde(with = "b64")]
    pub owner_blob: Vec<u8>,
    pub has_password: bool,
    pub max_views: Option<u32>,
    pub views: u32,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub last_viewed_at: Option<DateTime<Utc>>,
    /// Encore ouvrable : ni expiré, ni épuisé.
    pub available: bool,
}

/// `GET /sends/{id}/access`, sans authentification : ce qu'il faut savoir
/// avant d'ouvrir un lien.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<SendPassword>,
    pub expires_at: DateTime<Utc>,
    /// Ouvertures restantes ; `None` : sans limite.
    pub views_left: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendAccessRequest {
    #[serde(with = "b64")]
    pub access_key: Vec<u8>,
}

/// `POST /sends/{id}/access` : le contenu chiffré — une vue de consommée.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendContent {
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
    pub expires_at: DateTime<Utc>,
    pub views_left: Option<u32>,
}

// ─── Administration du serveur ──────────────────────────────────────────────

/// `GET /admin/overview` : l'état du serveur, sans rien de chiffré.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminOverview {
    pub server_version: String,
    pub registration: RegistrationMode,
    pub users: i64,
    pub disabled_users: i64,
    pub admins: i64,
    pub vaults: i64,
    pub shared_vaults: i64,
    pub items: i64,
    /// Octets de chiffrés vivants, tous vaults confondus.
    pub storage_bytes: i64,
    pub sends: i64,
    pub active_sessions: i64,
    pub pending_registrations: i64,
    /// Quota par défaut d'un compte, en octets ; `0` : aucun.
    pub default_quota_bytes: u64,
    /// `GUIVAULT_ALLOWED_IPS` et `GUIVAULT_ADMIN_ALLOWED_IPS` ; vides : toutes.
    #[serde(default)]
    pub allowed_ips: Vec<String>,
    #[serde(default)]
    pub admin_allowed_ips: Vec<String>,
    /// E-mails configurés et utilisables (`GUIVAULT_SMTP_URL`).
    #[serde(default)]
    pub mail_enabled: bool,
    /// Demandés mais inutilisables : pourquoi.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail_error: Option<String>,
}

/// Un compte vu par l'administrateur : des métadonnées, jamais un contenu.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminUserInfo {
    pub id: Uuid,
    pub email: String,
    pub created_at: DateTime<Utc>,
    pub disabled_at: Option<DateTime<Utc>>,
    pub is_admin: bool,
    pub totp_enabled: bool,
    /// Dernière requête d'une de ses sessions.
    pub last_seen_at: Option<DateTime<Utc>>,
    pub active_sessions: i64,
    pub vaults_owned: i64,
    /// Vaults partagés où il est membre sans en être propriétaire.
    pub vaults_joined: i64,
    /// Items vivants et leurs octets, dans les vaults qu'il possède.
    pub items: i64,
    pub storage_bytes: i64,
    /// Quota propre au compte : `None` = celui du serveur, `Some(0)` = aucun.
    pub quota_bytes: Option<i64>,
    /// Le quota qui s'applique, en octets ; `0` : aucun.
    pub effective_quota_bytes: u64,
}

/// `PUT /admin/users/{id}/quota`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetQuotaRequest {
    /// `None` : revenir au quota du serveur ; `Some(0)` : aucun quota.
    pub quota_bytes: Option<u64>,
}

/// Une inscription ouverte par un administrateur à une adresse.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrationInvite {
    pub email: String,
    /// L'administrateur qui l'a ouverte (s'il existe encore).
    pub invited_by: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// `POST /admin/registrations`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRegistrationInvite {
    pub email: String,
    /// Durée de validité, 1 à 90 jours (14 par défaut).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<u32>,
}

/// `GET /admin/backups` : la configuration des sauvegardes et les derniers
/// passages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupsStatus {
    /// Sauvegardes automatiques configurées (`GUIVAULT_BACKUP_DIR`).
    pub enabled: bool,
    pub dir: Option<String>,
    pub interval_hours: u64,
    pub keep: u32,
    /// Chaque sauvegarde est aussi restaurée dans une base d'essai.
    pub restore_check: bool,
    pub running: bool,
    /// Les 20 derniers passages, du plus récent au plus ancien.
    pub runs: Vec<BackupRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRun {
    pub id: i64,
    /// `schedule`, `admin` ou `shell`.
    pub triggered_by: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    /// Nom du fichier dans le dossier des sauvegardes.
    pub file: Option<String>,
    pub bytes: Option<i64>,
    pub row_count: Option<i64>,
    pub sha256: Option<String>,
    /// `file` (relue et contrôlée) ou `restore` (restaurée à l'identique dans
    /// une base d'essai) ; absent : échouée ou en cours.
    pub verified: Option<String>,
    pub error: Option<String>,
}

// ─── Items ──────────────────────────────────────────────────────────────────

/// Une version précédente d'un item : ce qu'il était avant d'être modifié
/// ou supprimé. Même chiffré, même AAD (vault, id, type) : le client
/// l'ouvre avec la clé du vault, et la restaure en la renvoyant telle
/// quelle par `PUT`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemVersion {
    pub item_id: Uuid,
    /// La révision de l'item quand cette version était la sienne.
    pub revision: i64,
    pub item_type: String,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
    pub written_at: DateTime<Utc>,
    /// Quand elle a été remplacée (ou l'item supprimé), et par qui.
    pub replaced_at: DateTime<Utc>,
    pub replaced_by: Option<String>,
}

/// Un item de la corbeille : supprimé depuis moins de `GUIVAULT_TRASH_DAYS`
/// jours, avec sa dernière version.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrashedItem {
    pub item_id: Uuid,
    pub item_type: String,
    /// La révision de sa dernière version — à passer telle quelle pour la
    /// supprimer définitivement si elle n'a pas changé entre-temps.
    pub revision: i64,
    #[serde(with = "b64")]
    pub ciphertext: Vec<u8>,
    pub deleted_at: DateTime<Utc>,
    pub deleted_by: Option<String>,
    /// Date à laquelle elle sera effacée pour de bon.
    pub expires_at: DateTime<Utc>,
}

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
