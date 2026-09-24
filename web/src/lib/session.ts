/** La session déverrouillée : le compte, les vaults avec leur clé en clair,
 * et les opérations qui combinent l'API et la cryptographie (l'équivalent de
 * `account.rs` + `sharing.rs` + la partie chiffrement de `sync.rs` dans
 * Guiterm). Tout vit en mémoire : recharger la page, c'est se reconnecter. */
import { api, ApiError, setTokens } from "./api";
import { fromBase64, toBase64, utf8, uuid, randomBytes } from "./bytes";
import * as c from "./crypto";
import { fingerprint as fingerprintOf, type UnlockedAccount } from "./crypto";
import { pinKdf, requireKdfNotDowngraded } from "./kdfPins";
import { requirePinned } from "./pins";
import { acceptRollback as acceptRollbackRevision, observeRevisions, type VaultRollback } from "./vaultRevisions";
import type { Invitation, Item, LoginResponse, Payload, Role, UserProfile, Vault, VaultMember } from "./types";

/** Qui a remis la clé de ce vault à ce compte : soi-même (vault créé ou
 * clé renouvelée ici), la détentrice d'une clé publique (enveloppe de format
 * 2 : `fingerprint` à comparer aux membres et aux empreintes épinglées), ou
 * on ne sait pas (format 1, boîte scellée anonyme — le serveur a pu la
 * fabriquer). */
export type KeyFrom = { kind: "self" } | { kind: "member"; fingerprint: string } | { kind: "anonymous" };

export interface VaultView {
  id: string;
  kind: Vault["kind"];
  role: Role;
  name: string;
  key: Uint8Array;
  keyFrom: KeyFrom;
  revision: number;
  updatedAt: string;
}

export interface SessionState {
  user: UserProfile;
  account: UnlockedAccount;
  fingerprint: string;
  vaults: VaultView[];
  invitations: Invitation[];
  /** Vaults dont le serveur annonce une révision plus basse que celle déjà
   * vue d'ici (`vaultRevisions.ts`) — à montrer tant qu'on n'en a pas pris
   * acte. */
  rollbacks: VaultRollback[];
}

/** Un item déchiffré — ou pas : un item illisible (clé d'un autre âge,
 * blob altéré) est montré comme tel plutôt que de faire disparaître toute la
 * liste. */
export type DecodedItem =
  | { id: string; revision: number; updatedAt: string; ok: true; payload: Payload }
  | { id: string; revision: number; updatedAt: string; ok: false; itemType: string; error: string };

const b64 = toBase64;
const unb64 = fromBase64;

/** « GuiVault Web » ou « Extension GuiVault » : ce que la liste des sessions
 * montre. */
let deviceLabel = "GuiVault Web";

export function setDeviceLabel(label: string) {
  deviceLabel = label;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "navigateur";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : "";
  return `${deviceLabel} (${browser}${os ? `, ${os}` : ""})`;
}

// ─── Connexion ──────────────────────────────────────────────────────────────

function unlock(login: LoginResponse, stretchedKey: Uint8Array): { user: UserProfile; account: UnlockedAccount } {
  const account = c.unlockAccount(stretchedKey, unb64(login.protected_user_key), unb64(login.protected_private_key));
  stretchedKey.fill(0);
  return { user: login.user, account };
}

export async function openSession(user: UserProfile, account: UnlockedAccount): Promise<SessionState> {
  const state: SessionState = { user, account, fingerprint: fingerprintOf(account.keypair.publicKey), vaults: [], invitations: [], rollbacks: [] };
  await refresh(state);
  return state;
}

export type LoginOutcome =
  | { kind: "ok"; session: SessionState }
  | { kind: "totp"; verify: (code: string) => Promise<SessionState> };

export async function login(email: string, password: string): Promise<LoginOutcome> {
  const normalized = email.trim().toLowerCase();
  const pre = await api.prelogin(normalized);
  requireKdfNotDowngraded(normalized, pre.kdf);
  const master = await c.deriveMasterKey(password, unb64(pre.kdf_salt), pre.kdf);
  const res = await api.login(normalized, b64(master.authKey), deviceName());
  master.authKey.fill(0);
  const finish = async (login: LoginResponse) => {
    setTokens(login);
    const { user, account } = unlock(login, master.stretchedKey);
    // La user key s'est ouverte : ces paramètres sont les vrais.
    pinKdf(normalized, pre.kdf);
    return openSession(user, account);
  };
  if (res.kind === "ok") return { kind: "ok", session: await finish(res.login) };
  const token = res.challenge.totp_token;
  return { kind: "totp", verify: async (code) => finish(await api.totpVerify(token, code.replace(/\s+/g, ""))) };
}

export async function register(email: string, password: string): Promise<SessionState> {
  const normalized = email.trim().toLowerCase();
  const { material, account } = await c.createAccount(password);
  const vaultId = uuid();
  const vaultKey = randomBytes(c.KEY_LEN);
  const login = await api.register({
    email: normalized,
    kdf: material.kdf,
    kdf_salt: b64(material.kdfSalt),
    auth_key: b64(material.authKey),
    protected_user_key: b64(material.protectedUserKey),
    public_key: b64(material.publicKey),
    protected_private_key: b64(material.protectedPrivateKey),
    personal_vault: {
      id: vaultId,
      name_enc: b64(c.sealVaultName(vaultKey, vaultId, "Personnel")),
      wrapped_vault_key: b64(c.wrapVaultKey(account.keypair, material.publicKey, vaultId, vaultKey)),
    },
    device_name: deviceName(),
  });
  setTokens(login);
  pinKdf(normalized, material.kdf);
  return openSession(login.user, account);
}

export async function logout() {
  try {
    await api.logout();
  } finally {
    setTokens(null);
  }
}

/** Efface les clés en mémoire. Le ramasse-miettes ne promet rien, mais un
 * tableau mis à zéro ne livre plus rien à qui lirait la mémoire après. */
export function wipe(state: SessionState) {
  state.account.userKey.fill(0);
  state.account.keypair.privateKey.fill(0);
  for (const v of state.vaults) v.key.fill(0);
  state.vaults = [];
}

export async function changePassword(state: SessionState, current: string, next: string) {
  // La clé d'auth courante prouve qu'on connaît l'ancien mot de passe ; le
  // serveur la vérifie avant de remplacer quoi que ce soit.
  const pre = await api.prelogin(state.user.email);
  requireKdfNotDowngraded(state.user.email, pre.kdf);
  const old = await c.deriveMasterKey(current, unb64(pre.kdf_salt), pre.kdf);
  const rekey = await c.rekeyAccount(state.account, next);
  await api.changePassword({
    current_auth_key: b64(old.authKey),
    kdf: rekey.kdf,
    kdf_salt: b64(rekey.kdfSalt),
    auth_key: b64(rekey.authKey),
    protected_user_key: b64(rekey.protectedUserKey),
  });
  pinKdf(state.user.email, rekey.kdf);
}

// ─── Vaults ─────────────────────────────────────────────────────────────────

function keyFromSender(state: SessionState, sender: Uint8Array | null): KeyFrom {
  if (!sender) return { kind: "anonymous" };
  const fingerprint = fingerprintOf(sender);
  return fingerprint === state.fingerprint ? { kind: "self" } : { kind: "member", fingerprint };
}

function decodeVault(state: SessionState, v: Vault): VaultView {
  const { key, sender } = c.unwrapVaultKey(state.account, v.id, unb64(v.wrapped_vault_key));
  let name: string;
  try {
    name = c.openVaultName(key, v.id, unb64(v.name_enc));
  } catch {
    name = v.kind === "personal" ? "Personnel" : "(nom illisible)";
  }
  return { id: v.id, kind: v.kind, role: v.role, name, key, keyFrom: keyFromSender(state, sender), revision: v.revision, updatedAt: v.updated_at };
}

/** Recharge vaults et invitations depuis `/sync`. Un vault dont la clé ne
 * s'ouvre pas est écarté avec un avertissement : ça ne doit pas arriver,
 * mais un compte entier ne doit pas se retrouver bloqué par un seul vault. */
export async function refresh(state: SessionState): Promise<string[]> {
  const res = await api.sync();
  const warnings: string[] = [];
  const vaults: VaultView[] = [];
  for (const v of res.vaults) {
    try {
      vaults.push(decodeVault(state, v));
    } catch (e) {
      warnings.push(`Vault ${v.id} illisible : ${e instanceof Error ? e.message : e}`);
    }
  }
  // Personnel d'abord, puis par nom.
  vaults.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "personal" ? -1 : 1));
  state.user = res.user;
  state.vaults = vaults;
  state.invitations = res.invitations.filter((i) => i.status === "pending");
  state.rollbacks = observeRevisions(res.user.id, vaults);
  return warnings;
}

/** Ce que dit l'enveloppe jointe à une invitation, **avant** de l'accepter :
 * qui remet la clé (`KeyFrom`), `unreadable` si elle ne s'ouvre pas — elle
 * n'est pas pour ce compte, ou pas pour ce vault : ne pas accepter —, `null`
 * sans enveloppe (invitation émise avant l'inscription, serveur ancien). */
export type InvitationKey = KeyFrom | { kind: "unreadable" } | null;

export function invitationKeyFrom(state: SessionState, inv: Invitation): InvitationKey {
  if (!inv.wrapped_vault_key) return null;
  try {
    const { key, sender } = c.unwrapVaultKey(state.account, inv.vault_id, unb64(inv.wrapped_vault_key));
    key.fill(0);
    return keyFromSender(state, sender);
  } catch {
    return { kind: "unreadable" };
  }
}

/** Prendre acte d'un retour en arrière : la révision annoncée par le serveur
 * devient la référence, l'alerte disparaît. */
export function acceptRollback(state: SessionState, vaultId: string) {
  const r = state.rollbacks.find((x) => x.vaultId === vaultId);
  if (!r) return;
  acceptRollbackRevision(state.user.id, vaultId, r.seen);
  state.rollbacks = state.rollbacks.filter((x) => x.vaultId !== vaultId);
}

export function vaultOf(state: SessionState, id: string): VaultView {
  const v = state.vaults.find((v) => v.id === id);
  if (!v) throw new Error("Vault inconnu");
  return v;
}

export async function createVault(state: SessionState, name: string): Promise<VaultView> {
  const id = uuid();
  const key = randomBytes(c.KEY_LEN);
  const v = await api.createVault({
    id,
    name_enc: b64(c.sealVaultName(key, id, name)),
    wrapped_vault_key: b64(c.wrapVaultKey(state.account.keypair, state.account.keypair.publicKey, id, key)),
  });
  return decodeVault(state, v);
}

export async function renameVault(vault: VaultView, name: string) {
  await api.renameVault(vault.id, b64(c.sealVaultName(vault.key, vault.id, name)));
}

// ─── Items ──────────────────────────────────────────────────────────────────

/** L'identité d'un payload : l'id de l'entité qu'il contient. Doit être
 * celui de l'item, Guiterm ignore un item dont les deux divergent. */
export function payloadId(p: Payload): string {
  switch (p.kind) {
    case "host": return p.host.id;
    case "group": return p.group.id;
    case "snippet": return p.snippet.id;
    case "key": return p.key.id;
    case "sql-connection": return p.connection.id;
    case "icon": return p.icon.id;
    case "login": return p.login.id;
    case "note": return p.note.id;
    case "card": return p.card.id;
    case "identity": return p.identity.id;
    case "aws": return p.aws.id;
    case "api-key": return p.apiKey.id;
    case "runbook": return p.runbook.id;
  }
}

export function payloadName(p: Payload): string {
  switch (p.kind) {
    case "host": return p.host.label;
    case "group": return p.group.name;
    case "snippet": return p.snippet.name;
    case "key": return p.key.name;
    case "sql-connection": return p.connection.label;
    case "icon": return p.icon.name;
    case "login": return p.login.name;
    case "note": return p.note.name;
    case "card": return p.card.name;
    case "identity": return p.identity.name;
    case "aws": return p.aws.name;
    case "api-key": return p.apiKey.name;
    case "runbook": return p.runbook.name;
  }
}

/** L'entité d'un payload, quel que soit son type : pour lire `id`,
 * `groupId`, `favorite` sans dix `switch`. */
export function payloadEntity(p: Payload): Record<string, unknown> & { id: string } {
  switch (p.kind) {
    case "host": return p.host;
    case "group": return p.group;
    case "snippet": return p.snippet;
    case "key": return p.key;
    case "sql-connection": return p.connection;
    case "icon": return p.icon;
    case "login": return p.login;
    case "note": return p.note;
    case "card": return p.card;
    case "identity": return p.identity;
    case "aws": return p.aws;
    case "api-key": return p.apiKey;
    case "runbook": return p.runbook;
  }
}

export function decodeItem(vault: VaultView, item: Item): DecodedItem {
  const base = { id: item.id, revision: item.revision, updatedAt: item.updated_at };
  try {
    const plain = c.openItem(vault.key, vault.id, item.id, item.item_type, unb64(item.ciphertext));
    const payload = JSON.parse(utf8.decode(plain)) as Payload;
    if (typeof payload !== "object" || payload === null || payload.kind !== item.item_type) {
      return { ...base, ok: false, itemType: item.item_type, error: "contenu incohérent avec son type" };
    }
    if (payloadId(payload) !== item.id) {
      return { ...base, ok: false, itemType: item.item_type, error: "contenu incohérent avec son identité" };
    }
    return { ...base, ok: true, payload };
  } catch (e) {
    return { ...base, ok: false, itemType: item.item_type, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadItems(vault: VaultView): Promise<{ items: DecodedItem[]; revision: number }> {
  const page = await api.items(vault.id);
  return { items: page.items.filter((i) => !i.deleted).map((i) => decodeItem(vault, i)), revision: page.revision };
}

export class RevisionConflict extends Error {
  constructor(public readonly current: number) {
    super("Cet élément a été modifié entre-temps par quelqu'un d'autre : rechargez-le avant de réessayer.");
  }
}

/** Écrit un payload. `baseRevision` = verrou optimiste : `undefined` pour
 * une création, la révision lue pour une modification. */
export async function putPayload(vault: VaultView, payload: Payload, baseRevision?: number): Promise<Item> {
  const id = payloadId(payload);
  const plain = utf8.encode(JSON.stringify(payload));
  try {
    return await api.putItem(vault.id, id, {
      item_type: payload.kind,
      ciphertext: b64(c.sealItem(vault.key, vault.id, id, payload.kind, plain)),
      base_revision: baseRevision,
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === "revision_mismatch") throw new RevisionConflict(Number(e.extra.current));
    throw e;
  }
}

/** Copie une entité dans un autre vault : même id (une entité ne vit que
 * dans un vault, Guiterm supprime la copie en trop), re-chiffrée sous
 * l'autre clé. */
export async function moveItem(from: VaultView, to: VaultView, item: DecodedItem & { ok: true }) {
  await putPayload(to, item.payload);
  // Pas une suppression : l'item ne va pas dans la corbeille d'ici.
  await api.deleteItem(from.id, item.id, { moved: true });
}

// ─── Historique et corbeille ────────────────────────────────────────────────

/** Déchiffre une version précédente (historique ou corbeille) — même clé et
 * même AAD que l'item : `decodeItem` s'y applique tel quel. */
export function decodeVersion(vault: VaultView, v: { item_id: string; item_type: string; revision: number; ciphertext: string }, at: string): DecodedItem {
  return decodeItem(vault, { id: v.item_id, vault_id: vault.id, item_type: v.item_type, revision: v.revision, ciphertext: v.ciphertext, deleted: false, created_at: at, updated_at: at });
}

/** Restaure une version : la renvoyer telle quelle. `baseRevision` : la
 * révision courante de l'item, `undefined` s'il est dans la corbeille (il
 * est alors recréé). */
export async function restoreVersion(vault: VaultView, v: { item_id: string; item_type: string; ciphertext: string }, baseRevision: number | undefined): Promise<Item> {
  try {
    return await api.putItem(vault.id, v.item_id, { item_type: v.item_type, ciphertext: v.ciphertext, base_revision: baseRevision });
  } catch (e) {
    if (e instanceof ApiError && e.code === "revision_mismatch") throw new RevisionConflict(Number(e.extra.current));
    throw e;
  }
}

// ─── Partage ────────────────────────────────────────────────────────────────

function publicKeyOf(email: string, publicKeyB64: string, expectedFingerprint: string): Uint8Array {
  const pk = unb64(publicKeyB64);
  if (fingerprintOf(pk) !== expectedFingerprint) {
    throw new Error(`la clé publique de ${email} ne correspond pas à l'empreinte vérifiée — partage refusé`);
  }
  return pk;
}

/** Invite `email`. S'il a un compte, son empreinte doit avoir été épinglée
 * et la clé du vault part tout de suite ; sinon l'invitation part sans clé,
 * à compléter après son inscription. */
export async function invite(state: SessionState, vault: VaultView, email: string, role: Role): Promise<Invitation> {
  const normalized = email.trim().toLowerCase();
  const u = await api.lookup(normalized);
  let wrapped: string | undefined;
  if (u) {
    requirePinned(u.email, u.fingerprint);
    wrapped = b64(c.wrapVaultKey(state.account.keypair, publicKeyOf(u.email, u.public_key, u.fingerprint), vault.id, vault.key));
  }
  return api.invite(vault.id, { email: normalized, role, wrapped_vault_key: wrapped });
}

export async function completeInvitation(state: SessionState, vault: VaultView, inv: Invitation): Promise<Invitation> {
  if (!inv.invitee_public_key || !inv.invitee_fingerprint) throw new Error("L'invité n'a pas encore de clé publique.");
  requirePinned(inv.invitee_email, inv.invitee_fingerprint);
  const pk = publicKeyOf(inv.invitee_email, inv.invitee_public_key, inv.invitee_fingerprint);
  return api.completeInvitation(inv.id, b64(c.wrapVaultKey(state.account.keypair, pk, vault.id, vault.key)));
}

/** Nouvelle clé : chaque item est re-chiffré, une enveloppe est scellée vers
 * chaque membre restant — dont l'empreinte doit être vérifiée, sinon le
 * serveur pourrait glisser une clé à lui dans la liste. */
export async function rotateVaultKey(state: SessionState, vault: VaultView, members: VaultMember[]): Promise<void> {
  const fresh = await api.vault(vault.id);
  const page = await api.items(vault.id);
  const history = await api.vaultVersions(vault.id);
  const newKey = randomBytes(c.KEY_LEN);
  const items = page.items.map((it) => {
    const plain = c.openItem(vault.key, vault.id, it.id, it.item_type, unb64(it.ciphertext));
    return { id: it.id, ciphertext: b64(c.sealItem(newKey, vault.id, it.id, it.item_type, plain)) };
  });
  // L'historique et la corbeille suivent la clé. Une version qui ne s'ouvre
  // plus (altérée) repart telle quelle : illisible avant, illisible après,
  // mais elle ne bloque pas la rotation.
  const versions = history.map((v) => {
    let ciphertext = v.ciphertext;
    try {
      const plain = c.openItem(vault.key, vault.id, v.item_id, v.item_type, unb64(v.ciphertext));
      ciphertext = b64(c.sealItem(newKey, vault.id, v.item_id, v.item_type, plain));
    } catch {
      // gardée telle quelle
    }
    return { item_id: v.item_id, revision: v.revision, ciphertext };
  });
  const wrapped = members.map((m) => {
    if (m.user_id !== state.user.id) requirePinned(m.email, m.fingerprint);
    return { user_id: m.user_id, wrapped_vault_key: b64(c.wrapVaultKey(state.account.keypair, publicKeyOf(m.email, m.public_key, m.fingerprint), vault.id, newKey)) };
  });
  await api.rotateVaultKey(vault.id, {
    name_enc: b64(c.sealVaultName(newKey, vault.id, vault.name)),
    members: wrapped,
    items,
    versions,
    base_revision: fresh.revision,
  });
}
