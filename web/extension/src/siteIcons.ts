/** Les icônes des sites, côté extension (`src/lib/siteIcon.ts`) : le
 * service worker les demande lui-même à chaque site (ses permissions d'hôte
 * le lui permettent, sans cookies), puis les écrit dans les identifiants
 * des vaults où l'on peut écrire. Seulement si le réglage est activé. */
import { fetchSiteIcon, fillMissingIcons, MAX_FETCH_BYTES, renderIcon, type Fetched, type IconTarget, type TriedStore } from "../../src/lib/siteIcon";
import { canWrite } from "../../src/lib/types";
import { loadItemsCache, loadSettings } from "./store";
import { refreshVault, session } from "./vaultops";

/** Une page ou une image, sans cookies ni référent, bornée en temps et en
 * taille. */
async function fetchLimited(url: string): Promise<Fetched> {
  if (!/^https?:\/\//i.test(url)) throw new Error("adresse non http(s)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow", signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (Number(r.headers.get("content-length") ?? 0) > MAX_FETCH_BYTES) throw new Error("trop grand");
    const reader = r.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_FETCH_BYTES) {
          void reader.cancel();
          throw new Error("trop grand");
        }
        parts.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    return { url: r.url || url, type: r.headers.get("content-type") ?? "", bytes };
  } finally {
    clearTimeout(timer);
  }
}

const tried: TriedStore = {
  async load() {
    return ((await chrome.storage.local.get("siteIconsTried")).siteIconsTried as Record<string, number> | undefined) ?? {};
  },
  async save(v) {
    await chrome.storage.local.set({ siteIconsTried: v });
  },
};

/** Une passe : ce qui manque, d'après le cache d'items ; les vaults
 * touchés sont relus. Rend le nombre d'identifiants qui ont reçu leur
 * icône (0 si le réglage est désactivé ou le coffre verrouillé). */
export async function runSiteIcons(retry = false): Promise<number> {
  if (!(await loadSettings()).siteIcons) return 0;
  let state;
  try {
    state = await session();
  } catch {
    return 0;
  }
  if (state.offline) return 0;
  if (retry) await chrome.storage.local.remove("siteIconsTried");
  const cache = await loadItemsCache();
  const targets: IconTarget[] = [];
  for (const vault of state.vaults) {
    const c = cache[vault.id];
    if (!c || c.problems?.length || !canWrite(vault.role) || vault.emergency) continue;
    for (const item of c.items) if (item.ok && item.payload.kind === "login") targets.push({ vault, item });
  }
  const n = await fillMissingIcons(targets, (site) => fetchSiteIcon(site, fetchLimited, renderIcon), tried, retry ? 1000 : 20);
  if (n) for (const v of new Set(targets.map((t) => t.vault.id))) await refreshVault(v).catch(() => undefined);
  return n;
}
