/** Le plus grand compteur de manifeste vu pour chaque vault, par serveur
 * (voir `manifest.ts`). Un manifeste servi plus ancien, ou plus de manifeste
 * du tout pour un vault qui en avait un, se voit ainsi. Rattaché au vault
 * (ses ids sont uniques) plutôt qu'au compte : deux comptes du même
 * navigateur qui partagent un vault en voient le même état. Pas secret :
 * `localStorage`, comme les révisions (`vaultRevisions.ts`). */
import { baseUrl } from "./api";

const KEY = "guivault.manifest-counters";

type Store = Record<string, Record<string, number>>;

function load(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
}

function save(store: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Stockage indisponible : rien de retenu d'une session à l'autre.
  }
}

export function seenCounter(vaultId: string): number | null {
  return load()[baseUrl()]?.[vaultId] ?? null;
}

/** Retient `counter` s'il est plus grand que ce qu'on avait. */
export function observeCounter(vaultId: string, counter: number) {
  const store = load();
  const seen = (store[baseUrl()] ??= {});
  if ((seen[vaultId] ?? -1) < counter) {
    seen[vaultId] = counter;
    save(store);
  }
}

/** Prise d'acte : `counter` devient la référence, même plus bas ; `null` :
 * plus rien de retenu pour ce vault. */
export function acceptCounter(vaultId: string, counter: number | null) {
  const store = load();
  const seen = (store[baseUrl()] ??= {});
  if (counter === null) delete seen[vaultId];
  else seen[vaultId] = counter;
  save(store);
}

/** Des vaults qui ne sont plus les nôtres (compte supprimé) : oubliés. */
export function forgetCounters(vaultIds: string[]) {
  const store = load();
  const seen = store[baseUrl()];
  if (!seen) return;
  for (const id of vaultIds) delete seen[id];
  save(store);
}
