/** Quelle URI enregistrée correspond à la page courante — la sémantique de
 * Bitwarden, pour que ce qui est importé de là-bas se comporte pareil. */
import type { Login, LoginUri, UriMatch } from "./types";

export const DEFAULT_MATCH: UriMatch = "domain";

function parse(u: string): URL | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
  } catch {
    return null;
  }
}

/** Suffixes à deux étiquettes sous lesquels le domaine enregistrable en
 * compte trois (`bbc.co.uk`). Liste courte volontairement : les cas
 * fréquents, pas la Public Suffix List. */
const TWO_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "gouv", "asso"]);

/** Le domaine enregistrable d'un hôte : `mail.google.com` → `google.com`,
 * `www.bbc.co.uk` → `bbc.co.uk`. Une adresse IP ou un hôte sans point
 * reste tel quel. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase();
  if (/^[\d.]+$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const [tld, second] = [parts[parts.length - 1], parts[parts.length - 2]];
  const take = tld.length === 2 && TWO_LEVEL.has(second) && parts.length >= 3 ? 3 : 2;
  return parts.slice(-take).join(".");
}

export function uriMatches(entry: LoginUri, pageUrl: string): boolean {
  const mode = entry.match ?? DEFAULT_MATCH;
  if (mode === "never") return false;
  const page = parse(pageUrl);
  if (!page) return false;
  if (mode === "regex") {
    try {
      return new RegExp(entry.uri, "i").test(pageUrl);
    } catch {
      return false;
    }
  }
  if (mode === "startsWith") return pageUrl.toLowerCase().startsWith(entry.uri.toLowerCase());
  if (mode === "exact") return pageUrl.replace(/\/$/, "").toLowerCase() === entry.uri.replace(/\/$/, "").toLowerCase();
  const saved = parse(entry.uri);
  if (!saved) return false;
  if (mode === "host") return page.host.toLowerCase() === saved.host.toLowerCase();
  return registrableDomain(page.hostname) === registrableDomain(saved.hostname);
}

export function loginMatches(login: Login, pageUrl: string): boolean {
  return login.uris.some((u) => uriMatches(u, pageUrl));
}

/** À quel point une URI qui correspond vise la page : 4 une règle précise
 * (exacte, préfixe, expression), 3 le même hôte (`www.` mis à part), 2 un
 * domaine parent de la page (`example.com` pour `app.example.com`), 1 le
 * même domaine enregistrable seulement (un autre sous-domaine) ; 0 aucune
 * correspondance. */
export function uriScore(entry: LoginUri, pageUrl: string): number {
  if (!uriMatches(entry, pageUrl)) return 0;
  const mode = entry.match ?? DEFAULT_MATCH;
  if (mode === "exact" || mode === "startsWith" || mode === "regex") return 4;
  const page = parse(pageUrl);
  const saved = parse(entry.uri);
  if (!page || !saved) return 1;
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  // Le port ne compte que si l'URI enregistrée en donne un.
  if (saved.port ? strip(page.host) === strip(saved.host) : strip(page.hostname) === strip(saved.hostname)) return 3;
  return strip(page.hostname).endsWith(`.${strip(saved.hostname)}`) ? 2 : 1;
}

/** La meilleure de ses URI : plusieurs identifiants d'un même domaine se
 * rangent par là, celui du sous-domaine de la page en premier. */
export function loginScore(login: Login, pageUrl: string): number {
  return login.uris.reduce((best, u) => Math.max(best, uriScore(u, pageUrl)), 0);
}
