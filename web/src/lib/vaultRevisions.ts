/** Dernière révision vue de chaque vault, par serveur et par compte.
 *
 * Le serveur ne fait que monter la révision d'un vault (une par écriture) :
 * si `/sync` en annonce une plus basse que celle déjà vue d'ici, soit la
 * base a été restaurée depuis une sauvegarde (des écritures récentes sont
 * perdues), soit le serveur ment et sert une ancienne version du vault — un
 * ancien mot de passe, un élément supprimé qui revient. Dans les deux cas,
 * l'utilisateur doit le savoir. La révision n'étant pas authentifiée, un
 * serveur qui ment *aussi* sur elle passe : c'est le retour en arrière
 * grossier (ou honnête) que ceci attrape, pas le plus rusé.
 *
 * On garde la plus haute vue ; un recul la laisse telle quelle tant que
 * l'utilisateur n'a pas pris acte (`acceptRollback`), si bien que l'alerte
 * revient à chaque `/sync` d'ici là. Pas secret : `localStorage`, comme les
 * empreintes (`pins.ts`) — la même chose que Guiterm garde dans
 * `SyncState::vault_revisions`. */
import { baseUrl } from "./api";

const KEY = "guivault.vault-revisions";

/** Un vault revenu en arrière : `known` vue d'ici, `seen` annoncée. */
export interface VaultRollback {
  vaultId: string;
  name: string;
  known: number;
  seen: number;
}

type Store = Record<string, Record<string, number>>;

function scope(userId: string): string {
  return `${baseUrl()}|${userId}`;
}

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
    // Stockage indisponible (navigation privée) : rien de retenu, rien de
    // détecté d'une session à l'autre.
  }
}

/** Compare les révisions annoncées à celles déjà vues, retient les
 * nouvelles, et rend les vaults qui ont reculé. */
export function observeRevisions(userId: string, vaults: { id: string; name: string; revision: number }[]): VaultRollback[] {
  const store = load();
  const seen = (store[scope(userId)] ??= {});
  const rollbacks: VaultRollback[] = [];
  for (const v of vaults) {
    const known = seen[v.id];
    if (known !== undefined && v.revision < known) {
      rollbacks.push({ vaultId: v.id, name: v.name, known, seen: v.revision });
    } else {
      seen[v.id] = v.revision;
    }
  }
  save(store);
  return rollbacks;
}

/** L'utilisateur a pris acte : la révision annoncée devient la référence. */
export function acceptRollback(userId: string, vaultId: string, revision: number) {
  const store = load();
  (store[scope(userId)] ??= {})[vaultId] = revision;
  save(store);
}
