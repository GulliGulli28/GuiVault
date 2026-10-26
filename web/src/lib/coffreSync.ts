/** Synchroniser la session avec une copie du même coffre local
 * (`docs/TRANSFERT.md`, « Synchroniser deux copies ») — le « Synchroniser »
 * de KeePass : un coffre sur Nextcloud ou Syncthing, modifié sur deux
 * appareils, redevient un.
 *
 * Seulement entre copies d'un même coffre (même vault personnel) : leurs
 * vaults ont les mêmes ids et les mêmes clés, et leurs items se comparent
 * chiffrés. Pour chaque vault des deux côtés, chaque élément :
 *
 * - identique : rien ;
 * - l'un est un état que l'autre a dépassé (dans l'historique de l'autre) :
 *   le plus avancé gagne, sans conflit ;
 * - sinon **conflit** : le plus récent (`updated_at`) gagne, l'autre reste
 *   dans l'historique de son côté (une écriture y garde la version d'avant) ;
 * - d'un seul côté : copié de l'autre (une pierre tombale, non).
 *
 * Un vault d'un seul côté est copié en entier (`copyVaults`). Toute écriture
 * porte le manifeste de son côté, tenu ici (les deux copies doivent passer
 * leur vérification d'abord). Rien n'est jamais déchiffré au-delà des
 * manifestes et des noms de vaults. */
import { ApiError } from "./api";
import { equalBytes, fromBase64, toBase64 } from "./bytes";
import * as c from "./crypto";
import type { UnlockedAccount } from "./crypto";
import { localAccount, localOpen, localTransport, type LocalHost } from "./localHost";
import { itemDigest, nextManifest, sealManifest, verifyManifest, type Manifest } from "./manifest";
import type { SessionState } from "./session";
import { copyAttachments, copyVaults, method, unlockWith, type End, type TransferVault } from "./transfer";
import { canWrite, type Item, type ItemVersion, type ManifestWrite } from "./types";

const b64 = toBase64;
const unb64 = fromBase64;

/** Une écriture à faire d'un côté. */
export type SyncAction =
  | { kind: "put"; id: string; itemType: string; ciphertext: string; baseRevision: number | undefined }
  | { kind: "delete"; id: string };

export interface MergePlan {
  /** À écrire dans la session (`here`), puis dans la copie (`there`). */
  here: SyncAction[];
  there: SyncAction[];
  /** Les éléments modifiés des deux côtés : la version la plus récente a
   * gagné, l'autre est dans l'historique de son côté. */
  conflicts: string[];
}

export interface SideItems {
  items: Item[];
  versions: ItemVersion[];
}

/** Les dates des deux côtés ne s'écrivent pas forcément pareil (précision,
 * fuseau) : comparées en instants. */
function newer(x: Item, y: Item): boolean {
  return Date.parse(x.updated_at) >= Date.parse(y.updated_at);
}

function put(winner: Item, loser: Item | undefined): SyncAction {
  return { kind: "put", id: winner.id, itemType: winner.item_type, ciphertext: winner.ciphertext, baseRevision: loser?.revision };
}

/** Le plan de fusion d'un vault : pur, sans réseau. */
export function planMerge(here: SideItems, there: SideItems): MergePlan {
  const plan: MergePlan = { here: [], there: [], conflicts: [] };
  const byId = (s: SideItems) => new Map(s.items.map((i) => [i.id, i]));
  const history = (s: SideItems) => {
    const h = new Map<string, Set<string>>();
    for (const v of s.versions) {
      if (!h.has(v.item_id)) h.set(v.item_id, new Set());
      h.get(v.item_id)!.add(v.ciphertext);
    }
    return h;
  };
  const a = byId(here);
  const b = byId(there);
  const ha = history(here);
  const hb = history(there);
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id);
    const y = b.get(id);
    if (!y) {
      if (x && !x.deleted) plan.there.push(put(x, undefined));
      continue;
    }
    if (!x) {
      if (!y.deleted) plan.here.push(put(y, undefined));
      continue;
    }
    if (x.ciphertext === y.ciphertext && x.deleted === y.deleted) continue;
    let hereWins: boolean;
    if (x.ciphertext === y.ciphertext) {
      // Même contenu, supprimé d'un côté : la plus récente des deux décisions.
      hereWins = newer(x, y);
    } else if (ha.get(id)?.has(y.ciphertext)) {
      hereWins = true;
    } else if (hb.get(id)?.has(x.ciphertext)) {
      hereWins = false;
    } else {
      hereWins = newer(x, y);
      plan.conflicts.push(id);
    }
    const [winner, loser, to] = hereWins ? [x, y, plan.there] : [y, x, plan.here];
    if (winner.deleted) {
      if (!loser.deleted) to.push({ kind: "delete", id });
    } else {
      to.push(put(winner, loser));
    }
  }
  return plan;
}

/** Le manifeste d'un côté, tenu au fil des écritures. */
class ManifestKeeper {
  constructor(
    private key: Uint8Array,
    private vaultId: string,
    private state: Manifest | null,
  ) {}

  /** Le manifeste à joindre à l'écriture, et celui qu'il devient si elle
   * passe. Sans manifeste de ce côté : rien à joindre. */
  next(action: SyncAction): { write?: ManifestWrite; after: Manifest | null } {
    if (!this.state) return { after: null };
    const after = nextManifest(this.state, this.state.counter);
    if (action.kind === "put") after.items[action.id] = itemDigest(unb64(action.ciphertext));
    else delete after.items[action.id];
    return { write: { ciphertext: b64(sealManifest(this.key, this.vaultId, after)), base_revision: this.state.counter }, after };
  }

  commit(after: Manifest | null) {
    if (after) this.state = after;
  }
}

async function readSide(end: End, key: Uint8Array, vaultId: string, label: string): Promise<SideItems & { keeper: ManifestKeeper }> {
  const page = await method(end, "items")(vaultId, 0);
  const versions = await method(end, "vaultVersions")(vaultId);
  const live = page.items.filter((i) => !i.deleted).map((i) => ({ id: i.id, ciphertext: unb64(i.ciphertext) }));
  const served = page.manifest ? { revision: page.manifest.revision, ciphertext: unb64(page.manifest.ciphertext) } : null;
  const { manifest, problems } = verifyManifest(key, vaultId, served, live, null);
  if (problems.length > 0) throw new Error(`le manifeste ne correspond pas aux éléments (${label}) : ouvrez ce coffre et prenez-en acte d'abord`);
  return { items: page.items, versions, keeper: new ManifestKeeper(key, vaultId, manifest) };
}

async function apply(end: End, vaultId: string, keeper: ManifestKeeper, actions: SyncAction[]) {
  for (const a of actions) {
    const { write, after } = keeper.next(a);
    if (a.kind === "put") {
      await method(end, "putItem")(vaultId, a.id, { item_type: a.itemType, ciphertext: a.ciphertext, base_revision: a.baseRevision, manifest: write });
    } else {
      await method(end, "deleteItem")(vaultId, a.id, { manifest: write });
    }
    keeper.commit(after);
  }
}

export interface SyncReport {
  id: string;
  name: string;
  /** Écritures reçues par la session, et par la copie. */
  here: number;
  there: number;
  conflicts: number;
  /** Le vault n'était que d'un côté : copié en entier. */
  copied?: "here" | "there";
  error?: string;
}

/** Synchronise les vaults communs, et copie ceux qui ne sont que d'un côté. */
export async function syncVaults(here: { api: End; account: UnlockedAccount; vaults: TransferVault[] }, there: { api: End; account: UnlockedAccount }): Promise<SyncReport[]> {
  const theirs = (await method(there.api, "sync")()).vaults;
  const theirKeys = new Map<string, TransferVault>();
  for (const v of theirs) {
    try {
      const { key } = c.unwrapVaultKey(there.account, v.id, unb64(v.wrapped_vault_key));
      theirKeys.set(v.id, { id: v.id, kind: v.kind, key, name: c.openVaultName(key, v.id, unb64(v.name_enc)) });
    } catch {
      // Une clé qui ne s'ouvre pas : ce vault n'est pas synchronisé.
    }
  }
  const herePersonal = here.vaults.find((v) => v.kind === "personal");
  const therePersonal = [...theirKeys.values()].find((v) => v.kind === "personal");
  if (!herePersonal || !therePersonal || herePersonal.id !== therePersonal.id) {
    throw new Error("Ce coffre n'est pas une copie de celui-ci : pour y mettre des vaults, utilisez « Copier vers un coffre local ».");
  }

  const reports: SyncReport[] = [];
  for (const v of here.vaults) {
    const report: SyncReport = { id: v.id, name: v.name, here: 0, there: 0, conflicts: 0 };
    reports.push(report);
    const other = theirKeys.get(v.id);
    try {
      if (!other) {
        const [r] = await copyVaults(here.api, { api: there.api, account: there.account }, [v]);
        if (r.error) throw new Error(r.error);
        report.copied = "there";
        continue;
      }
      if (!equalBytes(v.key, other.key)) throw new Error("même identifiant, clé différente : ce n'est pas le même vault");
      const a = await readSide(here.api, v.key, v.id, "ici");
      const b = await readSide(there.api, v.key, v.id, "la copie");
      const plan = planMerge(a, b);
      report.conflicts = plan.conflicts.length;
      await apply(here.api, v.id, a.keeper, plan.here);
      report.here = plan.here.length;
      await apply(there.api, v.id, b.keeper, plan.there);
      report.there = plan.there.length;
      // Les fichiers suivent les items, dans les deux sens.
      const liveHere = new Set((await method(here.api, "items")(v.id, 0)).items.filter((i) => !i.deleted).map((i) => i.id));
      const liveThere = new Set((await method(there.api, "items")(v.id, 0)).items.filter((i) => !i.deleted).map((i) => i.id));
      await copyAttachments(here.api, there.api, v.id, liveThere);
      await copyAttachments(there.api, here.api, v.id, liveHere);
    } catch (e) {
      report.error = e instanceof ApiError || e instanceof Error ? e.message : String(e);
    }
  }
  for (const v of theirKeys.values()) {
    if (here.vaults.some((h) => h.id === v.id)) continue;
    const report: SyncReport = { id: v.id, name: v.name, here: 0, there: 0, conflicts: 0, copied: "here" };
    reports.push(report);
    const [r] = await copyVaults(there.api, { api: here.api, account: here.account }, [v]);
    if (r.error) report.error = r.error;
  }
  for (const v of theirKeys.values()) v.key.fill(0);
  return reports;
}

/** Ouvre la copie `path` dans le pair (avec **son** mot de passe maître, le
 * même s'il n'a pas changé depuis la copie), synchronise, la referme. La
 * session est à recharger ensuite. */
export async function syncWithCopy(state: SessionState, here: End, peer: LocalHost, path: string, password: string): Promise<SyncReport[]> {
  await localOpen(peer, path);
  try {
    const { account, authKey } = await unlockWith(password, await localAccount(peer));
    authKey.fill(0);
    try {
      const vaults = state.vaults.filter((v) => !v.emergency && canWrite(v.role)).map((v) => ({ id: v.id, kind: v.kind, name: v.name, key: v.key }));
      return await syncVaults({ api: here, account: state.account, vaults }, { api: localTransport(peer), account });
    } finally {
      account.userKey.fill(0);
      account.keypair.privateKey.fill(0);
    }
  } finally {
    await peer.close().catch(() => {});
  }
}
