/** La copie hors ligne : de quoi ouvrir le coffre quand le serveur ne répond
 * pas (auto-hébergé, en déplacement, panne) — en lecture seule.
 *
 * C'est exactement ce que le serveur garde, rien de plus : le compte
 * enveloppé (paramètres Argon2id, user key et clé privée scellées), les
 * vaults (clés enveloppées, noms chiffrés) et leurs items chiffrés. Elle
 * s'ouvre avec le mot de passe maître (`session.openOffline`), comme la
 * connexion. Sur le disque, elle vaut ce que vaut une copie de la base :
 * inexploitable sans le mot de passe maître, mais attaquable hors ligne —
 * d'où un réglage **par appareil**, désactivé par défaut.
 *
 * IndexedDB, par serveur et par compte : l'interface web (l'origine du
 * serveur) et l'extension (la sienne) ont chacune la leur. Tenue à jour
 * après chaque synchronisation, vault par vault, seulement ceux dont la
 * révision a bougé. */
import { api, baseUrl } from "./api";
import type { AccountBlobs, SessionState } from "./session";
import type { Item, UserProfile, Vault } from "./types";

export interface OfflineCopy {
  version: 1;
  email: string;
  user: UserProfile;
  blobs: AccountBlobs;
  vaults: Vault[];
  items: Record<string, { revision: number; items: Item[] }>;
  savedAt: string;
}

// ─── IndexedDB ──────────────────────────────────────────────────────────────

const DB_NAME = "guivault";
const STORE = "offline";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = f(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

function keyFor(email: string): string {
  return `${baseUrl()}|${email.trim().toLowerCase()}`;
}

export async function loadOfflineCopy(email: string): Promise<OfflineCopy | null> {
  try {
    const v = await tx<unknown>("readonly", (s) => s.get(keyFor(email)));
    return v && typeof v === "object" && (v as OfflineCopy).version === 1 ? (v as OfflineCopy) : null;
  } catch {
    // IndexedDB indisponible (navigation privée) : pas de copie.
    return null;
  }
}

async function saveCopy(copy: OfflineCopy) {
  await tx("readwrite", (s) => s.put(copy, keyFor(copy.email)));
}

// ─── Activer, désactiver, tenir à jour ──────────────────────────────────────

/** Crée la copie de ce compte sur cet appareil, et la remplit. Demande le
 * compte enveloppé reçu à la connexion : une session reprise d'avant ne
 * l'a pas, il faut alors se reconnecter. */
export async function enableOffline(state: SessionState): Promise<OfflineCopy> {
  if (!state.blobs) throw new Error("Reconnectez-vous pour activer la copie hors ligne : cette session ne garde pas de quoi l'ouvrir.");
  const res = await api.sync();
  const copy: OfflineCopy = { version: 1, email: state.user.email, user: res.user, blobs: state.blobs, vaults: res.vaults, items: {}, savedAt: new Date().toISOString() };
  await saveCopy(copy);
  return (await refreshOfflineCopy(state)) ?? copy;
}

export async function disableOffline(email: string) {
  try {
    await tx("readwrite", (s) => s.delete(keyFor(email)));
  } catch {
    // rien à effacer
  }
}

let running: Promise<OfflineCopy | null> | null = null;

/** Met la copie à jour si elle existe (sinon ne fait rien) : les vaults, et
 * les items de ceux dont la révision a bougé. Une seule à la fois. */
export function refreshOfflineCopy(state: SessionState): Promise<OfflineCopy | null> {
  if (state.offline) return Promise.resolve(null);
  const previous = running ?? Promise.resolve(null);
  const next = previous.catch(() => null).then(() => doRefresh(state));
  running = next.finally(() => {
    if (running === next) running = null;
  });
  return next;
}

async function doRefresh(state: SessionState): Promise<OfflineCopy | null> {
  const copy = await loadOfflineCopy(state.user.email);
  if (!copy) return null;
  const res = await api.sync();
  const items: OfflineCopy["items"] = {};
  for (const v of res.vaults) {
    const stored = copy.items[v.id];
    if (stored && stored.revision === v.revision) {
      items[v.id] = stored;
      continue;
    }
    const page = await api.items(v.id);
    items[v.id] = { revision: page.revision, items: page.items.filter((i) => !i.deleted) };
  }
  const next: OfflineCopy = {
    ...copy,
    user: res.user,
    // Le compte enveloppé de la session : à jour après un changement de mot
    // de passe fait ici.
    blobs: state.blobs ?? copy.blobs,
    vaults: res.vaults,
    items,
    savedAt: new Date().toISOString(),
  };
  await saveCopy(next);
  return next;
}
