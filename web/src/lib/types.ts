/** Types JSON de l'API (`crates/guivault-protocol`, champs en snake_case tels
 * quels) et les entités Guiterm qu'un item déchiffré contient (camelCase,
 * mêmes noms que `src/lib/types.ts` de Guiterm — c'est ce que son moteur de
 * synchronisation lit et écrit). */

// ─── Protocole ──────────────────────────────────────────────────────────────

export type RegistrationMode = "open" | "invite_only" | "closed";

export interface HealthResponse {
  status: string;
  protocol_version: number;
  server_version: string;
  registration: RegistrationMode;
}

export interface KdfParams {
  m_cost: number;
  t_cost: number;
  p_cost: number;
}

export interface PreloginResponse {
  kdf: KdfParams;
  kdf_salt: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  access_expires_in: number;
}

export interface UserProfile {
  id: string;
  email: string;
  public_key: string;
  created_at: string;
}

export interface LoginResponse extends TokenPair {
  user: UserProfile;
  protected_user_key: string;
  protected_private_key: string;
}

export interface TotpChallenge {
  totp_token: string;
}

export interface Session {
  id: string;
  device_name: string | null;
  created_at: string;
  last_used_at: string;
  current: boolean;
}

export interface UserLookupResponse {
  id: string;
  email: string;
  public_key: string;
  fingerprint: string;
}

export type Role = "reader" | "writer" | "admin" | "owner";
export type VaultKind = "personal" | "shared";

export interface Vault {
  id: string;
  kind: VaultKind;
  name_enc: string;
  role: Role;
  wrapped_vault_key: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface VaultMember {
  user_id: string;
  email: string;
  public_key: string;
  fingerprint: string;
  role: Role;
  added_at: string;
}

export type InvitationStatus = "pending" | "awaiting_key" | "accepted" | "declined" | "expired" | "revoked";

export interface Invitation {
  id: string;
  vault_id: string;
  inviter_email: string;
  invitee_email: string;
  invitee_public_key: string | null;
  invitee_fingerprint: string | null;
  role: Role;
  status: InvitationStatus;
  has_key: boolean;
  /** L'enveloppe de la clé du vault, adressée à l'invité — pour voir qui la
   * lui remet avant d'accepter. Absente d'un serveur plus ancien. */
  wrapped_vault_key?: string | null;
  created_at: string;
  expires_at: string;
}

export interface Item {
  id: string;
  vault_id: string;
  item_type: string;
  revision: number;
  ciphertext: string;
  deleted: boolean;
  created_at: string;
  updated_at: string;
}

/** Une version précédente d'un item (historique) : même chiffré, même AAD
 * que l'item — restaurer, c'est la renvoyer telle quelle. */
export interface ItemVersion {
  item_id: string;
  revision: number;
  item_type: string;
  ciphertext: string;
  written_at: string;
  replaced_at: string;
  replaced_by: string | null;
}

/** Un item de la corbeille, avec sa dernière version. */
export interface TrashedItem {
  item_id: string;
  item_type: string;
  revision: number;
  ciphertext: string;
  deleted_at: string;
  deleted_by: string | null;
  expires_at: string;
}

export interface ItemsPage {
  items: Item[];
  revision: number;
}

export interface SyncResponse {
  user: UserProfile;
  vaults: Vault[];
  invitations: Invitation[];
  server_time: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor_id: string | null;
  actor_email: string | null;
  vault_id: string | null;
  action: string;
  target: string | null;
  metadata: unknown;
}

export type ServerEvent =
  | { type: "vault_changed"; vault_id: string; revision: number }
  | { type: "invitation_received"; invitation_id: string; vault_id: string }
  | { type: "membership_changed"; vault_id: string }
  | { type: "settings_changed"; revision: number };

/** Les réglages synchronisés, scellés sous la user key (`sealUserSettings`). */
export interface UserSettings {
  blob: string;
  revision: number;
  updated_at: string;
}

export const ROLE_LABELS: Record<Role, string> = {
  reader: "lecteur",
  writer: "éditeur",
  admin: "admin",
  owner: "propriétaire",
};

/** Ce qu'un rôle permet, en une ligne : c'est ce qu'on choisit en invitant. */
export const ROLE_HINTS: Record<Role, string> = {
  reader: "voit les hôtes et leurs identifiants, ne modifie rien",
  writer: "peut aussi ajouter, modifier et supprimer des entités",
  admin: "peut aussi inviter, retirer des membres et faire tourner la clé",
  owner: "peut aussi supprimer le vault et transférer la propriété",
};

const ROLE_RANK: Record<Role, number> = { reader: 0, writer: 1, admin: 2, owner: 3 };
export const canWrite = (r: Role) => ROLE_RANK[r] >= ROLE_RANK.writer;
export const canManage = (r: Role) => ROLE_RANK[r] >= ROLE_RANK.admin;

// ─── Entités Guiterm (contenu en clair des items) ───────────────────────────

export interface EnvVar {
  key: string;
  /** Vide quand `secret` : la valeur vit dans `HostSecrets.env`. */
  value: string;
  secret?: boolean;
}

export type AuthMethod =
  | "password"
  | "agent"
  | "keyboardInteractive"
  | { privateKey: { path: string; keyId: string | null; certPath: string | null } };

export type HostKind = "ssh" | "dockerExec" | "k8sExec" | "rdp";
export type PersistentShellMode = "off" | "tmux";

export interface Host {
  id: string;
  label: string;
  kind?: HostKind;
  address: string;
  port: number;
  username: string;
  auth: AuthMethod;
  dockerViaHostId?: string | null;
  groupId: string | null;
  jumpVia: string[];
  proxyCommand?: string | null;
  tags: string[];
  startupSnippets: string[];
  envVars: EnvVar[];
  icon?: string;
  keepaliveIntervalSecs?: number | null;
  agentForward?: boolean;
  persistentShell?: PersistentShellMode;
  /** Champs que ce client ne modifie pas mais doit conserver (`source`,
   * `lastFacts`…) : un item réécrit ne perd rien de ce que Guiterm y a mis. */
  [extra: string]: unknown;
}

export interface HostSecrets {
  password?: string;
  passphrase?: string;
  env?: Record<string, string>;
}

export interface Group {
  id: string;
  name: string;
  parentId: string | null;
  icon?: string;
  color?: string | null;
  [extra: string]: unknown;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  tags: string[];
  adaptive?: boolean;
  [extra: string]: unknown;
}

export interface PrivateKey {
  id: string;
  name: string;
  path: string;
  /** Jamais rempli dans un item : le contenu voyage dans `KeyPayload.content`. */
  content?: string | null;
  [extra: string]: unknown;
}

export type DbTunnel =
  | { kind: "direct" }
  | { kind: "sshHost"; hostId: string }
  | { kind: "ssm"; target: string; profile?: string | null; region?: string | null };

export interface SqlServerConfig {
  tunnel?: DbTunnel | null;
  address: string;
  port: number;
  username: string;
  database?: string | null;
  tls?: boolean;
}

export type SqlEngine = "mysql" | "postgres" | "sqlite" | "redis" | "mongodb";

export type SqlEngineConfig =
  | ({ engine: "mysql" } & SqlServerConfig)
  | ({ engine: "postgres" } & SqlServerConfig)
  | ({ engine: "redis" } & SqlServerConfig)
  | { engine: "sqlite"; path: string; sqliteHostId?: string | null }
  | { engine: "mongodb"; connectionString: string; username: string; tunnel?: DbTunnel | null; tls?: boolean; tlsCaFile?: string | null; tlsInsecure?: boolean };

export type SqlConnection = {
  id: string;
  label: string;
  groupId?: string | null;
  tags: string[];
  [extra: string]: unknown;
} & SqlEngineConfig;

export interface CustomIcon {
  id: string;
  name: string;
  dataUrl: string;
  [extra: string]: unknown;
}

/** Un runbook de Guiterm (`termius_core::model::Runbook`), tel quel : une
 * procédure ordonnée, sans cibles (elles se choisissent au lancement).
 * Pas de dossier dans Guiterm : rangé à part, comme les snippets. */
export interface Runbook {
  id: string;
  name: string;
  description: string;
  steps: RunbookStep[];
  [extra: string]: unknown;
}

export type RunbookAction =
  | { kind: "command"; command: string; [extra: string]: unknown }
  | { kind: "program"; programText: string; [extra: string]: unknown }
  | { kind: "playbook"; relayHostId: string; relayHostLabel: string; playbook: string; inventory: string; [extra: string]: unknown };

export type RunbookOnFailure = "stop" | "continue" | "dropFailed";
export type RunbookApproval = "beforeIrreversible" | "never" | "always";

export interface RunbookStep {
  id: string;
  title: string;
  notes: string;
  action: RunbookAction;
  /** Restreint les cibles de l'étape : tous ces tags ET un de ces dossiers
   * (par nom). Vide = toute la sélection. */
  scope: { tags: string[]; groups: string[] };
  onFailure: RunbookOnFailure;
  approval: RunbookApproval;
  [extra: string]: unknown;
}

// ─── Secrets (gestionnaire de mots de passe) ────────────────────────────────
//
// Les types que Guiterm ne connaît pas encore : `login`, `note`, `card`,
// `identity`. Même convention que ses entités (camelCase, `groupId` pour le
// dossier, `tags`), miroir Rust dans `crates/guivault-items` — c'est ce que
// Guiterm ajoutera à son `Payload` le jour de l'intégration (voir
// `docs/ITEMS.md`). Modelés sur les types de Bitwarden pour que l'import et
// l'export soient sans perte.

/** Un champ libre ajouté à n'importe quel secret. `hidden` se masque comme
 * un mot de passe. */
export interface CustomField {
  name: string;
  value: string;
  type: "text" | "hidden" | "boolean";
}

/** Ce que tous les secrets ont en commun. */
export interface SecretBase {
  id: string;
  name: string;
  groupId: string | null;
  tags: string[];
  favorite?: boolean;
  notes?: string;
  fields?: CustomField[];
  [extra: string]: unknown;
}

/** Comment une URI enregistrée se compare à celle d'une page (même sens que
 * Bitwarden) ; `null` = réglage par défaut du client. */
export type UriMatch = "domain" | "host" | "startsWith" | "exact" | "regex" | "never";

export interface LoginUri {
  uri: string;
  match?: UriMatch | null;
}

/** Une passkey (WebAuthn) rattachée à un identifiant — le format
 * `fido2Credentials` de Bitwarden, pour voyager sans perte. Une page web ne
 * peut pas jouer l'authentificateur : on la stocke, on l'affiche, on
 * l'importe et l'exporte ; l'utiliser sera le rôle de Guiterm ou d'une
 * extension. */
export interface Passkey {
  credentialId: string;
  keyType: string;
  keyAlgorithm: string;
  keyCurve: string;
  /** Clé privée (PKCS#8, base64). C'est le secret. */
  keyValue: string;
  rpId: string;
  rpName?: string | null;
  userHandle: string;
  userName?: string | null;
  userDisplayName?: string | null;
  counter: number;
  discoverable: boolean;
  createdAt: string;
}

export interface PasswordHistoryEntry {
  password: string;
  changedAt: string;
}

export interface Login extends SecretBase {
  username: string;
  password: string;
  uris: LoginUri[];
  /** Secret TOTP : une URI `otpauth://` ou un secret base32 nu. */
  totp: string | null;
  passkeys: Passkey[];
  passwordHistory: PasswordHistoryEntry[];
}

export interface Note extends SecretBase {
  content: string;
}

/** Un profil AWS : ce qu'une section `[profile …]` de `~/.aws/config` dit
 * (le `AwsProfile` de Guiterm). */
export interface AwsProfileEntry {
  name: string;
  accountId: string;
  roleName: string;
  region: string;
  [extra: string]: unknown;
}

/** Un accès AWS : une session SSO (IAM Identity Center) et ses profils —
 * de quoi réécrire `~/.aws/config` sur un autre poste et s'y reconnecter
 * depuis Guiterm — ou des clés d'accès IAM. */
export interface AwsAccess extends SecretBase {
  authType: "sso" | "keys";
  /** Le bloc `[sso-session <nom>]` (le `AwsSsoSession` de Guiterm). */
  ssoSessionName: string;
  ssoStartUrl: string;
  ssoRegion: string;
  /** Clés d'accès (authType `keys`). */
  accessKeyId: string;
  secretAccessKey: string;
  mfaSerial: string;
  /** Région par défaut des profils qui n'en ont pas. */
  region: string;
  profiles: AwsProfileEntry[];
}

/** Une clé d'API, un jeton, un couple client/secret OAuth. */
export interface ApiKey extends SecretBase {
  /** Le service (« Stripe », « GitHub »…). */
  service: string;
  /** La console ou l'URL de base de l'API. */
  url: string;
  /** La partie publique : identifiant de clé, client ID. */
  keyId: string;
  /** Le secret : la clé, le jeton, le client secret. */
  secret: string;
  /** Portée, droits accordés — texte libre. */
  scopes: string;
  /** Date d'expiration (AAAA-MM-JJ), vide si aucune. */
  expiresAt: string;
}

export interface Card extends SecretBase {
  cardholderName: string;
  brand: string;
  number: string;
  expMonth: string;
  expYear: string;
  code: string;
}

export interface Identity extends SecretBase {
  title: string;
  firstName: string;
  middleName: string;
  lastName: string;
  username: string;
  company: string;
  ssn: string;
  passportNumber: string;
  licenseNumber: string;
  email: string;
  phone: string;
  address1: string;
  address2: string;
  address3: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/** Le contenu en clair d'un item : `kind` en kebab-case, c'est aussi
 * l'`item_type` du serveur. Les six premiers sont le miroir de
 * `termius_core::guivault::entity::Payload`, les quatre suivants sont ceux
 * de `crates/guivault-items`. */
export type Payload =
  | { kind: "host"; host: Host; secrets?: HostSecrets }
  | { kind: "group"; group: Group }
  | { kind: "snippet"; snippet: Snippet }
  | { kind: "key"; key: PrivateKey; content?: string | null; passphrase?: string | null }
  | { kind: "sql-connection"; connection: SqlConnection; password?: string | null }
  | { kind: "icon"; icon: CustomIcon }
  | { kind: "login"; login: Login }
  | { kind: "note"; note: Note }
  | { kind: "card"; card: Card }
  | { kind: "identity"; identity: Identity }
  | { kind: "aws"; aws: AwsAccess }
  | { kind: "api-key"; apiKey: ApiKey }
  | { kind: "runbook"; runbook: Runbook };

export type ItemKind = Payload["kind"];
export type SecretKind = "login" | "note" | "card" | "identity" | "aws" | "api-key";
export const SECRET_KINDS: SecretKind[] = ["login", "note", "card", "identity", "aws", "api-key"];

export const KIND_LABELS: Record<ItemKind, string> = {
  host: "hôte",
  group: "dossier",
  key: "clé",
  snippet: "snippet",
  "sql-connection": "connexion",
  icon: "icône",
  login: "identifiant",
  note: "note",
  card: "carte",
  identity: "identité",
  aws: "accès AWS",
  "api-key": "clé d'API",
  runbook: "runbook",
};

export const KIND_LABELS_PLURAL: Record<ItemKind, string> = {
  host: "Hôtes",
  group: "Dossiers",
  key: "Clés",
  snippet: "Snippets",
  "sql-connection": "Connexions",
  icon: "Icônes",
  login: "Identifiants",
  note: "Notes",
  card: "Cartes",
  identity: "Identités",
  aws: "AWS",
  "api-key": "Clés d'API",
  runbook: "Runbooks",
};

export const SQL_ENGINE_LABELS: Record<SqlEngine, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
  redis: "Redis",
  mongodb: "MongoDB",
};

/** Une entité telle que l'arborescence la range — le même type que le
 * backend de Guiterm liste pour son panneau GuiVault. */
export type GuiVaultEntityKind = ItemKind;
export interface GuiVaultEntity {
  id: string;
  kind: GuiVaultEntityKind;
  name: string;
  /** Chemin de dossiers (« Prod / Bases »), pour les listes à plat. */
  path: string;
  /** Le dossier qui la contient ; `null` à la racine, et toujours pour une
   * clé, un snippet ou une icône. */
  parentId: string | null;
  /** Ce que la recherche voit en plus du nom (utilisateur, site…) — pas
   * dans Guiterm, qui n'a que le nom. */
  search?: string;
  /** La ligne secondaire d'une entité (utilisateur, site, fin de carte). */
  subtitle?: string;
  /** La ligne secondaire est une valeur (adresse, commande) : en mono,
   * comme dans les listes de Guiterm. */
  mono?: boolean;
  favorite?: boolean;
  /** Icône choisie (banque de Guiterm ou icône du vault) — hôte, dossier. */
  icon?: string;
  /** Pour un hôte : de quoi choisir l'icône du genre quand il n'en a pas. */
  hostKind?: HostKind;
  /** Pour un dossier : sa couleur, un nom d'accent de Guiterm. */
  color?: string;
  /** À côté du nom : le moteur d'une connexion, le type d'une clé. */
  badge?: string;
  tags?: string[];
  /** Dernière écriture et création de l'item, pour les tris par date. */
  updatedAt?: string;
  createdAt?: string;
}
