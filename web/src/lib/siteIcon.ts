/** Les icônes des sites (`Login.favicon`) : récupérées par l'application
 * (commande `site_fetch`, `app-tauri/src/site_fetch.rs`) ou le service
 * worker de l'extension, **directement auprès du site** — jamais par le
 * serveur GuiVault ni par un service tiers. Le site voit l'adresse IP de qui
 * la demande, d'où un réglage, désactivé par défaut. L'icône est ramenée à
 * une image PNG de 64 px au plus et rangée chiffrée dans l'identifiant : le
 * web et le mobile la montrent ensuite sans rien demander à personne.
 *
 * Pur sauf `renderIcon` (canvas) et `fillMissingIcons` (écritures) ; testé
 * par `siteIcon.test.ts`. */
import { fromBase64, toBase64 } from "./bytes";
import { changeItem, type DecodedItem, type VaultView } from "./session";
import { canWrite, type Login, type Payload } from "./types";

/** La taille de l'icône gardée, en pixels. */
export const ICON_SIZE = 64;
/** Au-delà, une page ou une icône n'est pas lue. */
export const MAX_FETCH_BYTES = 512 * 1024;
/** Un site sans icône n'est pas redemandé avant une semaine. */
export const RETRY_AFTER_MS = 7 * 86_400_000;

/** Une réponse du site : l'adresse finale (après redirections), son type,
 * son contenu. */
export interface Fetched {
  url: string;
  type: string;
  bytes: Uint8Array;
}
export type SiteFetcher = (url: string) => Promise<Fetched>;
/** Des octets d'image vers une URL `data:` PNG de `ICON_SIZE`, ou `null`. */
export type IconRenderer = (bytes: Uint8Array, type: string) => Promise<string | null>;

/** Le site d'un identifiant : l'origine de sa première adresse http(s)
 * (ni expression régulière ni « jamais »). */
export function siteOf(login: Pick<Login, "uris">): string | null {
  for (const u of login.uris) {
    if (u.match === "regex" || u.match === "never") continue;
    const raw = u.uri.trim();
    if (!raw) continue;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}/`;
    } catch {
      // une adresse qui ne se lit pas : la suivante
    }
  }
  return null;
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    out[m[1].toLowerCase()] = value.replace(/&amp;/g, "&").replace(/&#x2f;/gi, "/").trim();
  }
  return out;
}

/** Les icônes qu'une page annonce (`<link rel="icon">`,
 * `apple-touch-icon`), la plus proche de `ICON_SIZE` (par au-dessus)
 * d'abord, puis `/favicon.ico`. Une lecture par motifs, pas un vrai
 * parseur : le service worker de l'extension n'a pas `DOMParser`. */
export function iconCandidates(html: string, pageUrl: string): string[] {
  const head = html.slice(0, 200_000);
  let base = pageUrl;
  const baseTag = head.match(/<base\b[^>]*>/i);
  if (baseTag) {
    const href = attributes(baseTag[0]).href;
    try {
      if (href) base = new URL(href, pageUrl).href;
    } catch {
      // base illisible : la page elle-même
    }
  }
  const found: { url: string; size: number }[] = [];
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    const touch = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!rel.includes("icon") && !touch) continue;
    if (!a.href) continue;
    let url: string;
    try {
      url = new URL(a.href, base).href;
    } catch {
      continue;
    }
    if (!/^(https?:|data:image\/)/i.test(url)) continue;
    const sizes = (a.sizes ?? "").toLowerCase();
    const listed = [...sizes.matchAll(/(\d+)x(\d+)/g)].map((s) => Math.max(Number(s[1]), Number(s[2])));
    const svg = /svg/i.test(a.type ?? "") || /\.svg(\?|$)/i.test(url);
    const size = listed.length ? Math.max(...listed) : sizes === "any" || svg ? 512 : touch ? 180 : 32;
    found.push({ url, size });
  }
  const big = found.filter((f) => f.size >= ICON_SIZE).sort((a, b) => a.size - b.size);
  const small = found.filter((f) => f.size < ICON_SIZE).sort((a, b) => b.size - a.size);
  let ico: string | null = null;
  try {
    ico = new URL("/favicon.ico", pageUrl).href;
  } catch {
    // pas d'origine : pas de repli
  }
  return [...new Set([...big, ...small].map((f) => f.url).concat(ico ? [ico] : []))];
}

/** Une icône `data:image/…` écrite dans la page. */
function dataUrlBytes(url: string): { bytes: Uint8Array; type: string } | null {
  const m = url.match(/^data:(image\/[-+.\w]+)(;base64)?,(.*)$/is);
  if (!m) return null;
  try {
    return { type: m[1], bytes: m[2] ? fromBase64(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])) };
  } catch {
    return null;
  }
}

/** L'icône d'un site : sa page d'accueil, les icônes qu'elle annonce, puis
 * `/favicon.ico` ; la première qui se dessine. `null` : rien de lisible. */
export async function fetchSiteIcon(site: string, fetcher: SiteFetcher, render: IconRenderer): Promise<string | null> {
  let html = "";
  let base = site;
  try {
    const page = await fetcher(site);
    base = page.url || site;
    if (!page.type || /html/i.test(page.type)) html = new TextDecoder().decode(page.bytes);
  } catch {
    // le site ne répond pas : son /favicon.ico peut-être
  }
  for (const url of iconCandidates(html, base).slice(0, 5)) {
    try {
      const got = url.startsWith("data:") ? dataUrlBytes(url) : await fetcher(url);
      if (!got || !got.bytes.length) continue;
      const icon = await render(got.bytes, got.type);
      if (icon) return icon;
    } catch {
      // la suivante
    }
  }
  return null;
}

/** Dessine une image (PNG, ICO, JPEG, GIF, WebP ; SVG hors service worker)
 * en PNG carré de `ICON_SIZE` au plus. `null` : illisible ou trop petite. */
export async function renderIcon(bytes: Uint8Array, type: string): Promise<string | null> {
  const blob = new Blob([bytes as BlobPart], { type: /^image\//i.test(type) ? type : "" });
  let source: ImageBitmap | HTMLImageElement;
  let width: number;
  let height: number;
  try {
    const bmp = await createImageBitmap(blob);
    source = bmp;
    width = bmp.width;
    height = bmp.height;
  } catch {
    // Un SVG ne se décode qu'en <img> (et sans ses scripts : une image).
    if (typeof Image === "undefined" || typeof document === "undefined") return null;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: type || "image/svg+xml" }));
    try {
      const img = new Image();
      await new Promise<void>((ok, ko) => { img.onload = () => ok(); img.onerror = () => ko(new Error("image")); img.src = url; });
      source = img;
      width = img.naturalWidth || ICON_SIZE;
      height = img.naturalHeight || ICON_SIZE;
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (width < 16 || height < 16) return null;
  const side = Math.min(ICON_SIZE, Math.max(width, height));
  const scale = side / Math.max(width, height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(side, side);
    const g = canvas.getContext("2d");
    if (!g) return null;
    g.imageSmoothingQuality = "high";
    g.drawImage(source, (side - w) / 2, (side - h) / 2, w, h);
    const out = await canvas.convertToBlob({ type: "image/png" });
    return `data:image/png;base64,${toBase64(new Uint8Array(await out.arrayBuffer()))}`;
  }
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, (side - w) / 2, (side - h) / 2, w, h);
  return canvas.toDataURL("image/png");
}

/** L'icône d'un identifiant à afficher : une image `data:` matricielle, rien
 * d'autre (une URL ferait sortir une requête vers qui l'a écrite). */
export function faviconOf(p: Payload): string | undefined {
  const f = p.kind === "login" ? p.login.favicon : undefined;
  return typeof f === "string" && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(f) ? f : undefined;
}

/** L'identifiant avec (ou sans, `null`) son icône ; `null` si rien ne
 * change. */
export function withFavicon(p: Payload, favicon: string | null): Payload | null {
  if (p.kind !== "login") return null;
  if ((p.login.favicon ?? null) === favicon) return null;
  const { favicon: _, ...login } = p.login;
  return { ...p, login: favicon ? { ...login, favicon } : login };
}

/** Les sites déjà tentés sans succès, et quand (`site → ms`). */
export interface TriedStore {
  load(): Promise<Record<string, number>>;
  save(tried: Record<string, number>): Promise<void>;
}

export interface IconTarget {
  vault: VaultView;
  item: DecodedItem & { ok: true };
}

/** Les identifiants sans icône, groupés par site — ceux d'un vault où l'on
 * peut écrire. Un site tenté récemment sans succès attend `RETRY_AFTER_MS`. */
export function missingBySite(targets: readonly IconTarget[], tried: Record<string, number>, now: number): Map<string, IconTarget[]> {
  const out = new Map<string, IconTarget[]>();
  for (const t of targets) {
    const p = t.item.payload;
    if (p.kind !== "login" || p.login.favicon) continue;
    const site = siteOf(p.login);
    if (!site || now - (tried[site] ?? 0) < RETRY_AFTER_MS) continue;
    out.set(site, [...(out.get(site) ?? []), t]);
  }
  return out;
}

let running: Promise<number> | null = null;

/** Récupère les icônes qui manquent (au plus `maxSites` sites par passe,
 * l'un après l'autre) et les écrit dans les identifiants. Une seule passe
 * à la fois ; rend le nombre d'identifiants écrits. */
export function fillMissingIcons(targets: readonly IconTarget[], fetchIcon: (site: string) => Promise<string | null>, store: TriedStore, maxSites = 20): Promise<number> {
  running ??= (async () => {
    const tried = await store.load();
    const sites = [...missingBySite(targets, tried, Date.now())].slice(0, maxSites);
    let written = 0;
    for (const [site, logins] of sites) {
      let icon: string | null = null;
      try {
        icon = await fetchIcon(site);
      } catch {
        icon = null;
      }
      if (!icon) {
        tried[site] = Date.now();
        continue;
      }
      delete tried[site];
      for (const t of logins) {
        try {
          // Une icône posée entre-temps (autre appareil) reste.
          if (await changeItem(t.vault, t.item, (p) => (p.kind === "login" && !p.login.favicon ? withFavicon(p, icon) : null))) written++;
        } catch {
          // vault changé, droits retirés : la prochaine passe
        }
      }
    }
    await store.save(tried);
    return written;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Les identifiants des vaults où l'on peut écrire (ni accès d'urgence, ni
 * vault en écart avec son manifeste). */
export async function writableTargets(vaults: readonly VaultView[], load: (v: VaultView) => Promise<{ items: DecodedItem[]; problems: unknown[] }>): Promise<IconTarget[]> {
  const out: IconTarget[] = [];
  for (const vault of vaults) {
    if (!canWrite(vault.role) || vault.emergency) continue;
    try {
      const page = await load(vault);
      if (page.problems.length) continue;
      for (const item of page.items) if (item.ok && item.payload.kind === "login") out.push({ vault, item });
    } catch {
      // vault illisible : les autres
    }
  }
  return out;
}

// ─── L'application : réglage et sites tentés, sur cet appareil ─────────────

const ENABLED_KEY = "guivault.siteIcons";
const TRIED_KEY = "guivault.siteIcons.tried";

/** Le réglage de l'application (désactivé par défaut) et ce qu'elle a
 * tenté, dans `localStorage` : propre à cet appareil, comme le choix de
 * contacter les sites depuis lui. */
export const localSiteIcons = {
  enabled(): boolean {
    try {
      return localStorage.getItem(ENABLED_KEY) === "1";
    } catch {
      return false;
    }
  },
  setEnabled(on: boolean) {
    try {
      if (on) localStorage.setItem(ENABLED_KEY, "1");
      else localStorage.removeItem(ENABLED_KEY);
    } catch {
      // stockage indisponible : le réglage vaut pour cette fenêtre
    }
  },
  tried: {
    async load() {
      try {
        return JSON.parse(localStorage.getItem(TRIED_KEY) ?? "{}") as Record<string, number>;
      } catch {
        return {};
      }
    },
    async save(tried: Record<string, number>) {
      try {
        localStorage.setItem(TRIED_KEY, JSON.stringify(tried));
      } catch {
        // la prochaine passe retentera
      }
    },
  } satisfies TriedStore,
  /** Oublier les échecs : « Récupérer maintenant » retente tout. */
  forget() {
    try {
      localStorage.removeItem(TRIED_KEY);
    } catch {
      // rien à oublier
    }
  },
};
