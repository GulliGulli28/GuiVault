/** Écrire dans le coffre depuis l'extension — popup ou service worker :
 * enregistrer ou supprimer un identifiant, et tenir le cache d'items à
 * jour pour que la liste, le badge et les boutons dans les pages suivent
 * sans re-télécharger. */
import { setBaseUrl } from "../../src/lib/api";
import { deleteItem as deleteVaultItem, IntegrityError, loadItems, payloadEntity, putPayload, RevisionConflict, type DecodedItem, type SessionState, type VaultView } from "../../src/lib/session";
import type { Login, Payload } from "../../src/lib/types";
import { loadItemsCache, loadSession, loadSettings, saveItemsCache } from "./store";

async function session(): Promise<SessionState> {
  const s = await loadSession();
  if (!s) throw new Error("Coffre verrouillé.");
  setBaseUrl((await loadSettings()).serverUrl);
  return s.state;
}

/** L'identifiant `id` et le vault où il est, d'après le cache. */
export async function findLogin(id: string): Promise<{ vaultId: string; login: Login; revision: number } | null> {
  const cache = await loadItemsCache();
  for (const [vaultId, v] of Object.entries(cache)) {
    const it = v.items.find((i) => i.id === id);
    if (it?.ok && it.payload.kind === "login") return { vaultId, login: it.payload.login, revision: it.revision };
  }
  return null;
}

/** Un vault en écart avec son manifeste (vu par le popup, gardé dans le
 * cache) ne reçoit rien d'ici : le service worker n'a pas lu le manifeste
 * lui-même, `withManifest` ne le saurait pas. */
async function assertIntact(vault: VaultView) {
  if ((await loadItemsCache())[vault.id]?.problems?.length) throw new IntegrityError(vault.name);
}

/** Crée ou met à jour n'importe quel item ; `revision` = verrou optimiste
 * d'une modification. En cas de conflit, le vault est relu et l'erreur
 * remontée : l'appelant recommence sur la version fraîche. */
export async function savePayload(vaultId: string, payload: Payload, revision?: number): Promise<DecodedItem> {
  const state = await session();
  const vault = state.vaults.find((v) => v.id === vaultId);
  if (!vault) throw new Error("Vault inconnu.");
  const id = payloadEntity(payload).id;
  await assertIntact(vault);
  try {
    const item = await putPayload(vault, payload, revision);
    const decoded: DecodedItem = { id, revision: item.revision, updatedAt: item.updated_at, createdAt: item.created_at, ok: true, payload };
    const cache = await loadItemsCache();
    const entry = cache[vaultId] ?? { revision: 0, items: [] };
    entry.items = [...entry.items.filter((i) => i.id !== id), decoded];
    cache[vaultId] = entry;
    await saveItemsCache(cache);
    return decoded;
  } catch (e) {
    if (e instanceof RevisionConflict) await refreshVault(vaultId);
    throw e;
  }
}

export function saveLogin(vaultId: string, login: Login, revision?: number): Promise<DecodedItem> {
  return savePayload(vaultId, { kind: "login", login }, revision);
}

export async function deleteItem(vaultId: string, id: string): Promise<void> {
  const state = await session();
  const vault = state.vaults.find((v) => v.id === vaultId);
  if (!vault) throw new Error("Vault inconnu.");
  await assertIntact(vault);
  await deleteVaultItem(vault, id);
  const cache = await loadItemsCache();
  if (cache[vaultId]) {
    cache[vaultId].items = cache[vaultId].items.filter((i) => i.id !== id);
    await saveItemsCache(cache);
  }
}

export const deleteLogin = deleteItem;

export async function refreshVault(vaultId: string): Promise<void> {
  const state = await session();
  const vault = state.vaults.find((v) => v.id === vaultId);
  if (!vault) return;
  const page = await loadItems(vault);
  const cache = await loadItemsCache();
  cache[vaultId] = { revision: page.revision, items: page.items, problems: page.problems };
  await saveItemsCache(cache);
}
