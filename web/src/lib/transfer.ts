/** Copier des vaults d'un endroit à un autre (`docs/TRANSFERT.md`) : un coffre
 * local vers un serveur (compte neuf ou existant), un compte vers un coffre
 * local (neuf ou existant).
 *
 * Tout voyage **chiffré, tel quel** : items, historique, corbeille, pièces
 * jointes, manifeste. L'AAD d'un item ne contient que son vault, son id et
 * son type, et les ids sont gardés. Seule la clé de chaque vault est
 * ré-enveloppée, ici, pour le compte d'arrivée — ni le serveur ni l'hôte du
 * coffre ne voient rien de plus que d'habitude. Les items arrivent par
 * `importItems` (dates comprises) ; un transfert coupé reprend en
 * n'envoyant que ce qui manque. La source n'est jamais modifiée. */
import { ApiError, serverConnection, type Transport } from "./api";
import { fromBase64, toBase64 } from "./bytes";
import * as c from "./crypto";
import type { UnlockedAccount } from "./crypto";
import { pinKdf, requireKdfNotDowngraded } from "./kdfPins";
import { localAccount, localCreate, localOpen, localTransport, type LocalHost } from "./localHost";
import { deviceName, type AccountBlobs, type SessionState, type VaultView } from "./session";
import type { ImportedItem, Item, ItemVersion, LoginResponse, TrashedItem, VaultManifest } from "./types";
import { t } from "./i18n";

const b64 = toBase64;
const unb64 = fromBase64;

/** Au plus autant d'items par lot (`IMPORT_BATCH` du protocole)… */
export const BATCH_ITEMS = 1000;
/** … et à peu près autant d'octets de base64 : loin sous la limite de corps
 * du serveur (64 fois la taille maximale d'un item). */
export const BATCH_BYTES = 4 * 1024 * 1024;

/** Une extrémité : la façade `api` de la session, une connexion à un autre
 * serveur, ou le transport d'un coffre local. */
export type End = Partial<Transport>;

export function method<K extends keyof Transport>(end: End, name: K): Transport[K] {
  const f = end[name];
  if (!f) throw new ApiError(501, "local_unsupported", t("« {0} » manque à l'une des deux extrémités.", String(name)));
  return f;
}

/** Un vault à copier : ce que la session en sait déjà (clé ouverte). */
export interface TransferVault {
  id: string;
  kind: VaultView["kind"];
  name: string;
  key: Uint8Array;
}

/** Où arrivent les vaults. */
export interface Destination {
  api: End;
  /** Le compte d'arrivée : les clés de vault sont enveloppées pour lui. */
  account: UnlockedAccount;
  /** Le compte d'arrivée a déjà son vault personnel : celui de la source
   * devient un vault ordinaire, sous ce nom. */
  personalName?: string;
  /** Le vault créé avec le compte ou le coffre d'arrivée (le personnel de
   * la source) : déjà là, mais vide — pas une reprise. */
  born?: string;
}

export interface TransferProgress {
  vault: string;
  step: "items" | "attachments";
  done: number;
  total: number;
}

export interface VaultReport {
  id: string;
  name: string;
  /** Items envoyés (vivants et corbeille) ; ceux déjà arrivés n'y sont pas. */
  items: number;
  versions: number;
  trashed: number;
  attachments: number;
  /** Pièces jointes d'items à la corbeille : le serveur n'en accepte que
   * pour un item vivant. */
  skippedAttachments: number;
  /** Le vault existait déjà à l'arrivée : on a complété. */
  resumed: boolean;
  error?: string;
}

/** Ce qu'une copie de vault enverra : les items absents de l'arrivée, avec
 * leurs versions (de la plus ancienne à la plus récente) ; les items de la
 * corbeille avec leur dernière version et leur date de suppression. Une
 * pierre tombale sans corbeille (purgée, déplacée) ne part pas. */
export function importPlan(all: Item[], trash: TrashedItem[], versions: ItemVersion[], present: Set<string>): ImportedItem[] {
  const byItem = new Map<string, ItemVersion[]>();
  for (const v of versions) byItem.set(v.item_id, [...(byItem.get(v.item_id) ?? []), v]);
  const trashed = new Map(trash.map((t) => [t.item_id, t]));
  const out: ImportedItem[] = [];
  for (const it of all) {
    if (present.has(it.id)) continue;
    const vs = (byItem.get(it.id) ?? [])
      .sort((a, b) => a.revision - b.revision)
      .map((v) => ({ item_type: v.item_type, ciphertext: v.ciphertext, written_at: v.written_at, replaced_at: v.replaced_at }));
    if (!it.deleted) {
      out.push({ id: it.id, item_type: it.item_type, ciphertext: it.ciphertext, created_at: it.created_at, updated_at: it.updated_at, versions: vs });
      continue;
    }
    const t = trashed.get(it.id);
    if (!t || vs.length === 0 || vs[vs.length - 1].item_type !== it.item_type) continue;
    out.push({ id: it.id, item_type: it.item_type, ciphertext: "", created_at: it.created_at, updated_at: it.updated_at, deleted_at: t.deleted_at, versions: vs });
  }
  return out;
}

function sizeOf(it: ImportedItem): number {
  return it.ciphertext.length + it.versions.reduce((n, v) => n + v.ciphertext.length, 0) + 200;
}

/** Les lots : au plus `BATCH_ITEMS` items et à peu près `BATCH_BYTES` (un
 * item plus gros part seul). */
export function batches(items: ImportedItem[]): ImportedItem[][] {
  const out: ImportedItem[][] = [];
  let cur: ImportedItem[] = [];
  let bytes = 0;
  for (const it of items) {
    const n = sizeOf(it);
    if (cur.length > 0 && (cur.length >= BATCH_ITEMS || bytes + n > BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Copie les vaults choisis de `source` vers `dest`. Un vault qui échoue
 * n'arrête pas les autres : son rapport porte l'erreur. */
export async function copyVaults(source: End, dest: Destination, vaults: TransferVault[], onProgress?: (p: TransferProgress) => void): Promise<VaultReport[]> {
  const there = new Set((await method(dest.api, "sync")()).vaults.map((v) => v.id));
  const reports: VaultReport[] = [];
  for (const v of vaults) {
    const report: VaultReport = { id: v.id, name: v.name, items: 0, versions: 0, trashed: 0, attachments: 0, skippedAttachments: 0, resumed: there.has(v.id) && v.id !== dest.born };
    try {
      await copyVault(source, dest, v, report, onProgress);
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    }
    reports.push(report);
  }
  return reports;
}

async function copyVault(source: End, dest: Destination, v: TransferVault, report: VaultReport, onProgress?: (p: TransferProgress) => void) {
  const to = dest.api;
  if (!report.resumed && v.id !== dest.born) {
    const name = v.kind === "personal" && dest.personalName ? dest.personalName : v.name;
    report.name = name;
    try {
      await method(to, "createVault")({
        id: v.id,
        name_enc: b64(c.sealVaultName(v.key, v.id, name)),
        wrapped_vault_key: b64(c.wrapVaultKey(dest.account.keypair, dest.account.keypair.publicKey, v.id, v.key)),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) throw new Error(t("Un vault de même identifiant existe déjà là-bas, à quelqu'un d'autre."), { cause: e });
      throw e;
    }
  }

  // Tout ce que garde la source, pierres tombales comprises (`since` 0).
  const page = await method(source, "items")(v.id, 0);
  const trash = await method(source, "trash")(v.id);
  const versions = await method(source, "vaultVersions")(v.id);
  const arrived = await method(to, "items")(v.id, 0);
  const present = new Set(arrived.items.map((i) => i.id));
  const plan = importPlan(page.items, trash, versions, present);
  const manifest: VaultManifest | undefined = page.manifest && !arrived.manifest ? page.manifest : undefined;

  const lots = batches(plan);
  if (lots.length === 0 && manifest) lots.push([]);
  let done = 0;
  onProgress?.({ vault: report.name, step: "items", done, total: plan.length });
  for (const [i, items] of lots.entries()) {
    await method(to, "importItems")(v.id, { items, manifest: i === lots.length - 1 ? manifest : undefined });
    done += items.length;
    report.items += items.length;
    report.trashed += items.filter((it) => it.deleted_at).length;
    report.versions += items.reduce((n, it) => n + it.versions.length, 0);
    onProgress?.({ vault: report.name, step: "items", done, total: plan.length });
  }

  // Les pièces jointes : leur clé voyage dans l'item, les morceaux tels quels.
  const live = new Set(page.items.filter((i) => !i.deleted).map((i) => i.id));
  const files = await copyAttachments(source, to, v.id, live, (done, total) => onProgress?.({ vault: report.name, step: "attachments", done, total }));
  report.attachments += files.copied;
  report.skippedAttachments += files.skipped;
}

/** Copie les pièces jointes complètes de `source` qui manquent à `to` (ou
 * n'y sont pas complètes), seulement pour les items vivants de `live` : un
 * fichier d'un item supprimé est compté à part, pas copié. */
export async function copyAttachments(source: End, to: End, vaultId: string, live: Set<string>, onProgress?: (done: number, total: number) => void): Promise<{ copied: number; skipped: number }> {
  let skipped = 0;
  const files = (await method(source, "attachments")(vaultId)).filter((a) => a.complete);
  const existing = new Map((await method(to, "attachments")(vaultId)).map((a) => [a.id, a]));
  const todo = files.filter((a) => {
    if (!live.has(a.item_id)) {
      skipped++;
      return false;
    }
    return !existing.get(a.id)?.complete;
  });
  for (const [n, a] of todo.entries()) {
    onProgress?.(n, todo.length);
    if (existing.has(a.id)) await method(to, "deleteAttachment")(vaultId, a.id);
    await method(to, "createAttachment")(vaultId, { id: a.id, item_id: a.item_id, size: a.size, chunks: a.chunks });
    for (let k = 0; k < a.chunks; k++) {
      await method(to, "putAttachmentChunk")(vaultId, a.id, k, await method(source, "attachmentChunk")(vaultId, a.id, k));
    }
    await method(to, "completeAttachment")(vaultId, a.id);
  }
  if (todo.length > 0) onProgress?.(todo.length, todo.length);
  return { copied: todo.length, skipped };
}

export function transferVaults(state: SessionState, ids: string[]): TransferVault[] {
  return state.vaults.filter((v) => ids.includes(v.id)).map((v) => ({ id: v.id, kind: v.kind, name: v.name, key: v.key }));
}

/** Le mot de passe maître ouvre-t-il ces enveloppes ? Rend le compte, et la
 * clé d'auth (pour une inscription). */
export async function unlockWith(password: string, blobs: AccountBlobs): Promise<{ account: UnlockedAccount; authKey: Uint8Array }> {
  const master = await c.deriveMasterKey(password, unb64(blobs.kdf_salt), blobs.kdf);
  try {
    return { account: c.unlockAccount(master.stretchedKey, unb64(blobs.protected_user_key), unb64(blobs.protected_private_key)), authKey: master.authKey };
  } catch {
    master.authKey.fill(0);
    throw new Error(t("Mot de passe maître incorrect."));
  } finally {
    master.stretchedKey.fill(0);
  }
}

function requireBlobs(state: SessionState): AccountBlobs {
  if (!state.blobs) throw new Error(t("Cette session ne garde pas le compte enveloppé : reconnectez-vous, puis recommencez."));
  return state.blobs;
}

function personalOf(state: SessionState): VaultView {
  const p = state.vaults.find((v) => v.kind === "personal");
  if (!p) throw new Error(t("Pas de vault personnel dans cette session."));
  return p;
}

/** Les réglages synchronisés : scellés sous la user key, qui est la même à
 * l'arrivée d'un compte ou d'un coffre neuf. */
async function copySettings(source: End, to: End) {
  const s = await method(source, "settings")().catch(() => null);
  if (s) await method(to, "putSettings")(s.blob, null);
}

// ─── Coffre local → serveur ─────────────────────────────────────────────────

/** Un compte de serveur ouvert pour y copier : sa connexion à lui, à côté de
 * la session en cours. `close` met fin à cette connexion. */
export interface AccountDestination extends Destination {
  email: string;
  close: () => Promise<void>;
}

/** Crée un compte sur `serverUrl` **avec le compte du coffre** : mêmes
 * paramètres Argon2id, même user key, même paire de clés, même vault
 * personnel — rien n'est re-chiffré. Le mot de passe maître du coffre
 * devient celui du compte. */
export async function createAccountFrom(state: SessionState, source: End, serverUrl: string, email: string, password: string): Promise<AccountDestination> {
  const blobs = requireBlobs(state);
  const personal = personalOf(state);
  const { authKey } = await unlockWith(password, blobs);
  const normalized = email.trim().toLowerCase();
  const conn = serverConnection(serverUrl);
  let login: LoginResponse;
  try {
    login = await conn.api.register({
      email: normalized,
      kdf: blobs.kdf,
      kdf_salt: blobs.kdf_salt,
      auth_key: b64(authKey),
      protected_user_key: blobs.protected_user_key,
      public_key: b64(state.account.keypair.publicKey),
      protected_private_key: blobs.protected_private_key,
      personal_vault: {
        id: personal.id,
        name_enc: b64(c.sealVaultName(personal.key, personal.id, personal.name)),
        wrapped_vault_key: b64(c.wrapVaultKey(state.account.keypair, state.account.keypair.publicKey, personal.id, personal.key)),
      },
      device_name: deviceName(),
    });
  } finally {
    authKey.fill(0);
  }
  conn.setTokens(login);
  pinKdf(normalized, blobs.kdf);
  await copySettings(source, conn.api);
  return { api: conn.api, account: state.account, email: normalized, born: personal.id, close: () => closeConnection(conn) };
}

async function closeConnection(conn: ReturnType<typeof serverConnection>) {
  await conn.api.logout().catch(() => {});
  conn.setTokens(null);
}

export type ConnectOutcome =
  | { kind: "ok"; dest: AccountDestination }
  | { kind: "totp"; verify: (code: string) => Promise<AccountDestination> };

/** Se connecte à un compte existant de `serverUrl`, pour y copier : même
 * dérivation et mêmes gardes que la connexion (`session.login`), mais une
 * connexion à part. */
export async function connectAccount(serverUrl: string, email: string, password: string, personalName: string): Promise<ConnectOutcome> {
  const normalized = email.trim().toLowerCase();
  const conn = serverConnection(serverUrl);
  const pre = await conn.api.prelogin(normalized);
  requireKdfNotDowngraded(normalized, pre.kdf);
  const master = await c.deriveMasterKey(password, unb64(pre.kdf_salt), pre.kdf);
  const res = await conn.api.login(normalized, b64(master.authKey), deviceName());
  master.authKey.fill(0);
  const finish = (login: LoginResponse): AccountDestination => {
    conn.setTokens(login);
    let account: UnlockedAccount;
    try {
      account = c.unlockAccount(master.stretchedKey, unb64(login.protected_user_key), unb64(login.protected_private_key));
    } finally {
      master.stretchedKey.fill(0);
    }
    pinKdf(normalized, pre.kdf);
    return { api: conn.api, account, email: normalized, personalName, close: () => closeConnection(conn) };
  };
  if (res.kind === "ok") return { kind: "ok", dest: finish(res.login) };
  const token = res.challenge.totp_token;
  return { kind: "totp", verify: async (code) => finish(await conn.api.totpVerify(token, code.replace(/\s+/g, ""))) };
}

// ─── Serveur → coffre local ─────────────────────────────────────────────────

/** Crée un coffre local dans `path` avec le compte de la session (même mot de
 * passe maître, même user key, même vault personnel), puis y copie les
 * vaults choisis. L'hôte est refermé ensuite : on ouvre le coffre depuis
 * l'accueil. */
export async function copyToNewCoffre(state: SessionState, source: End, host: LocalHost, path: string, password: string, vaults: TransferVault[], onProgress?: (p: TransferProgress) => void): Promise<VaultReport[]> {
  const blobs = requireBlobs(state);
  const personal = personalOf(state);
  const { authKey } = await unlockWith(password, blobs);
  authKey.fill(0);
  await localCreate(host, path, {
    account: { ...blobs, public_key: b64(state.account.keypair.publicKey) },
    personal: {
      id: personal.id,
      name_enc: b64(c.sealVaultName(personal.key, personal.id, personal.name)),
      wrapped_vault_key: b64(c.wrapVaultKey(state.account.keypair, state.account.keypair.publicKey, personal.id, personal.key)),
    },
  });
  try {
    const to = localTransport(host);
    await copySettings(source, to);
    return await copyVaults(source, { api: to, account: state.account, born: personal.id }, vaults, onProgress);
  } finally {
    await host.close().catch(() => {});
  }
}

/** Copie dans un coffre local existant, ouvert avec **son** mot de passe : les
 * clés de vault sont enveloppées pour son compte à lui, et le vault personnel
 * de la session y devient un vault ordinaire (`personalName`). */
export async function copyToCoffre(source: End, host: LocalHost, path: string, password: string, personalName: string, vaults: TransferVault[], onProgress?: (p: TransferProgress) => void): Promise<VaultReport[]> {
  await localOpen(host, path);
  try {
    const a = await localAccount(host);
    const { account, authKey } = await unlockWith(password, a);
    authKey.fill(0);
    try {
      return await copyVaults(source, { api: localTransport(host), account, personalName }, vaults, onProgress);
    } finally {
      account.userKey.fill(0);
      account.keypair.privateKey.fill(0);
    }
  } finally {
    await host.close().catch(() => {});
  }
}
