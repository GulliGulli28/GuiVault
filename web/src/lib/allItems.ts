/** Les éléments de tous les vaults, déchiffrés une fois et partagés par ce
 * qui en a besoin hors de la page d'un vault : l'accueil (accès rapide,
 * codes 2FA, santé), les compteurs de la barre latérale. Relus quand la
 * révision d'un vault change ; en mémoire seulement, effacés avec la session
 * (`clearAllItems`). */
import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "./api";
import { allSecrets, findReused, findWeak, type HealthEntry } from "./health";
import { loadItems, type DecodedItem, type SessionState, type VaultView } from "./session";

interface VaultItems {
  revision: number;
  items: DecodedItem[];
}

const store = new Map<string, VaultItems>();
const listeners = new Set<() => void>();
const pending = new Map<string, Promise<void>>();

function emit() {
  for (const f of listeners) f();
}

/** À la fermeture de la session : rien de déchiffré ne reste en mémoire. */
export function clearAllItems() {
  store.clear();
  pending.clear();
  emit();
}

/** Ce que la page d'un vault vient de lire : plus frais que la révision que
 * la session connaît quand rien ne la pousse (coffre local, pas de SSE). */
export function putVaultItems(vaultId: string, revision: number, items: DecodedItem[]) {
  const have = store.get(vaultId);
  if (have && have.revision > revision) return;
  store.set(vaultId, { revision, items });
  emit();
}

function refresh(v: VaultView, onError: (m: string) => void): Promise<void> {
  const have = store.get(v.id);
  if (have && have.revision >= v.revision) return Promise.resolve();
  const key = `${v.id}:${v.revision}`;
  let p = pending.get(key);
  if (!p) {
    p = loadItems(v)
      .then((page) => {
        putVaultItems(v.id, page.revision, page.items);
      })
      .catch((e) => onError(`${v.name} : ${errorMessage(e)}`))
      .finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

/** Un élément lisible et le vault où il vit. */
export interface VaultItem {
  vault: VaultView;
  item: DecodedItem & { ok: true };
}

/** Les éléments de tous les vaults de la session ; `loading` tant que l'un
 * d'eux n'a pas encore été lu. */
export function useAllItems(session: SessionState, onError: (m: string) => void): { items: VaultItem[]; counts: Record<string, number>; loading: boolean } {
  const [tick, setTick] = useState(0);
  const vaults = useMemo(() => [...session.vaults, ...session.emergencyVaults], [session.vaults, session.emergencyVaults]);
  const revisions = vaults.map((v) => `${v.id}:${v.revision}`).join(",");

  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  useEffect(() => {
    for (const v of vaults) void refresh(v, onError);
    // Les révisions disent quand relire ; `onError` n'en est pas une raison.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisions]);

  return useMemo(() => {
    const items: VaultItem[] = [];
    const counts: Record<string, number> = {};
    let loading = false;
    for (const v of vaults) {
      const have = store.get(v.id);
      if (!have) {
        loading = true;
        continue;
      }
      let n = 0;
      for (const it of have.items) {
        if (!it.ok) continue;
        if (it.payload.kind !== "group" && it.payload.kind !== "icon") n++;
        items.push({ vault: v, item: it });
      }
      counts[v.id] = n;
    }
    return { items, counts, loading };
    // `tick` : le magasin a changé.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisions, tick]);
}

/** Le résumé de santé de l'accueil et de la barre latérale : les secrets
 * faibles ou réutilisés (le reste — fuites, 2FA possible — demande les
 * relais du serveur, sur la page Santé). Le score est la part des secrets
 * sains. */
export function healthSummary(items: VaultItem[]): { total: number; weak: number; reused: number; issues: number; score: number } {
  const entries: HealthEntry[] = items.map(({ vault, item }) => ({ vault, item }));
  const secrets = allSecrets(entries);
  const weak = findWeak(secrets);
  const reusedGroups = findReused(secrets);
  const reused = reusedGroups.flat();
  const bad = new Set([...weak, ...reused]);
  const total = secrets.length;
  return {
    total,
    weak: weak.length,
    reused: reused.length,
    issues: new Set([...bad].map((s) => s.entry.item.id)).size,
    score: total === 0 ? 100 : Math.round((100 * (total - bad.size)) / total),
  };
}
