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
  | { type: "membership_changed"; vault_id: string };

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

/** Miroir de `termius_core::guivault::entity::Payload` : `kind` en
 * kebab-case, c'est aussi l'`item_type` du serveur. */
export type Payload =
  | { kind: "host"; host: Host; secrets?: HostSecrets }
  | { kind: "group"; group: Group }
  | { kind: "snippet"; snippet: Snippet }
  | { kind: "key"; key: PrivateKey; content?: string | null; passphrase?: string | null }
  | { kind: "sql-connection"; connection: SqlConnection; password?: string | null }
  | { kind: "icon"; icon: CustomIcon };

export type ItemKind = Payload["kind"];

export const KIND_LABELS: Record<ItemKind, string> = {
  host: "hôte",
  group: "dossier",
  key: "clé",
  snippet: "snippet",
  "sql-connection": "connexion",
  icon: "icône",
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
}
