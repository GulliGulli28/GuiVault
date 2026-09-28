/** Le rapport de santé du coffre, calculé ici sur les items déchiffrés :
 * mots de passe faibles, réutilisés, anciens, fuités (Have I Been Pwned par
 * k-anonymat, relayé par le serveur) ; sites qui acceptent un code TOTP sans
 * qu'on en ait enregistré (liste 2fa.directory, relayée) ; clés d'API et
 * cartes qui expirent. Rien ne part au serveur, sauf — sur demande — les
 * 5 premiers caractères de l'empreinte SHA-1 de chaque mot de passe.
 *
 * Pur (hors `checkPwned`, qui reçoit de quoi interroger) : `health.test.ts`. */
import { sha1 } from "@noble/hashes/legacy.js";
import { toHex, utf8 } from "./bytes";
import { estimateStrength } from "./generator";
import type { DecodedItem, VaultView } from "./session";
import type { TwoFactorSite } from "./types";
import { registrableDomain } from "./urimatch";

/** Un item lisible et le vault où il vit. */
export interface HealthEntry {
  vault: Pick<VaultView, "id" | "name" | "role">;
  item: DecodedItem & { ok: true };
}

/** Un secret à juger : le mot de passe d'un identifiant, d'un hôte, d'une
 * connexion SQL, la passphrase d'un hôte ou d'une clé. */
export interface SecretRef {
  entry: HealthEntry;
  /** Ce que c'est, pour l'affichage (« mot de passe », « passphrase »). */
  label: string;
  value: string;
}

export function secretsOf(entry: HealthEntry): SecretRef[] {
  const p = entry.item.payload;
  const out: SecretRef[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) out.push({ entry, label, value });
  };
  switch (p.kind) {
    case "login": add("mot de passe", p.login.password); break;
    case "host": add("mot de passe", p.secrets?.password); add("passphrase", p.secrets?.passphrase); break;
    case "sql-connection": add("mot de passe", p.password); break;
    case "key": add("passphrase", p.passphrase); break;
  }
  return out;
}

export function allSecrets(entries: HealthEntry[]): SecretRef[] {
  return entries.flatMap(secretsOf);
}

/** Faibles : « très faible » ou « faible » selon `estimateStrength`. */
export function findWeak(secrets: SecretRef[]): SecretRef[] {
  return secrets.filter((s) => estimateStrength(s.value).score <= 1);
}

/** Réutilisés : le même secret à plusieurs endroits — les groupes, le plus
 * grand d'abord. */
export function findReused(secrets: SecretRef[]): SecretRef[][] {
  const by = new Map<string, SecretRef[]>();
  for (const s of secrets) by.set(s.value, [...(by.get(s.value) ?? []), s]);
  return [...by.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
}

/** Depuis quand le mot de passe d'un identifiant est le même : son dernier
 * changement (l'historique), sinon la création de l'item. */
export function passwordSince(entry: HealthEntry): Date | null {
  const p = entry.item.payload;
  if (p.kind !== "login" || !p.login.password) return null;
  const changed = p.login.passwordHistory?.map((h) => Date.parse(h.changedAt)).filter((t) => !Number.isNaN(t)) ?? [];
  if (changed.length) return new Date(Math.max(...changed));
  const created = Date.parse(entry.item.createdAt ?? entry.item.updatedAt);
  return Number.isNaN(created) ? null : new Date(created);
}

export interface Aged {
  entry: HealthEntry;
  since: Date;
  days: number;
}

/** Anciens : un mot de passe d'identifiant inchangé depuis plus de `days`
 * jours (un an par défaut). */
export function findOld(entries: HealthEntry[], now: Date, days = 365): Aged[] {
  const out: Aged[] = [];
  for (const e of entries) {
    const since = passwordSince(e);
    if (!since) continue;
    const age = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
    if (age > days) out.push({ entry: e, since, days: age });
  }
  return out.sort((a, b) => b.days - a.days);
}

export interface Expiring {
  entry: HealthEntry;
  /** Dernier jour de validité. */
  date: Date;
  expired: boolean;
  /** « clé d'API », « carte ». */
  what: string;
}

/** Le dernier jour d'une carte `MM` / `AA` ou `AAAA`. */
function cardEnd(month: string, year: string): Date | null {
  const m = Number(month);
  let y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || !year.trim()) return null;
  if (y < 100) y += 2000;
  return new Date(Date.UTC(y, m, 0));
}

/** Expirent : clés d'API (`expiresAt`) et cartes, déjà expirées ou dans les
 * `days` jours (30 par défaut). */
export function findExpiring(entries: HealthEntry[], now: Date, days = 30): Expiring[] {
  const limit = now.getTime() + days * 86_400_000;
  const out: Expiring[] = [];
  for (const e of entries) {
    const p = e.item.payload;
    let date: Date | null = null;
    let what = "";
    if (p.kind === "api-key" && p.apiKey.expiresAt) {
      const t = Date.parse(`${p.apiKey.expiresAt}T23:59:59Z`);
      date = Number.isNaN(t) ? null : new Date(t);
      what = "clé d'API";
    } else if (p.kind === "card") {
      date = cardEnd(p.card.expMonth, p.card.expYear);
      what = "carte";
    }
    if (date && date.getTime() <= limit) out.push({ entry: e, date, expired: date.getTime() < now.getTime(), what });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export interface MissingTotp {
  entry: HealthEntry;
  site: TwoFactorSite;
}

/** Les identifiants d'un site qui accepte un code TOTP, sans secret TOTP ni
 * passkey enregistrés. */
export function findMissingTotp(entries: HealthEntry[], sites: TwoFactorSite[]): MissingTotp[] {
  const byDomain = new Map<string, TwoFactorSite>();
  for (const s of sites) for (const d of s.domains) byDomain.set(d.toLowerCase(), s);
  const out: MissingTotp[] = [];
  for (const e of entries) {
    const p = e.item.payload;
    if (p.kind !== "login" || p.login.totp || p.login.passkeys?.length) continue;
    for (const u of p.login.uris) {
      let host: string;
      try {
        host = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u.uri) ? u.uri : `https://${u.uri}`).hostname.toLowerCase();
      } catch {
        continue;
      }
      const site = byDomain.get(host) ?? byDomain.get(registrableDomain(host));
      if (site) {
        out.push({ entry: e, site });
        break;
      }
    }
  }
  return out;
}

// ─── Fuites (k-anonymat) ────────────────────────────────────────────────────

/** Le SHA-1 d'un mot de passe en hexadécimal majuscule : ce que HIBP range. */
export function sha1Hex(password: string): string {
  return toHex(sha1(utf8.encode(password))).toUpperCase();
}

/** Combien de fois le suffixe apparaît dans une réponse « range » de HIBP
 * (`SUFFIXE:NOMBRE` par ligne ; les lignes de remplissage valent 0). */
export function countInRange(body: string, suffix: string): number {
  for (const line of body.split(/\r?\n/)) {
    const [s, n] = line.trim().split(":");
    if (s && s.toUpperCase() === suffix) return Number(n) || 0;
  }
  return 0;
}

/** Pour chaque secret distinct, combien de fois il apparaît dans les fuites
 * connues. `fetchRange(prefix)` rend la réponse « range » d'un préfixe de
 * 5 caractères (le relais du serveur) ; un même préfixe n'est demandé
 * qu'une fois, `concurrency` à la fois. */
export async function checkPwned(
  values: string[],
  fetchRange: (prefix: string) => Promise<string>,
  onProgress?: (done: number, total: number) => void,
  concurrency = 4,
): Promise<Map<string, number>> {
  const distinct = [...new Set(values)];
  const hashes = new Map(distinct.map((v) => [v, sha1Hex(v)]));
  const prefixes = [...new Set([...hashes.values()].map((h) => h.slice(0, 5)))];
  const bodies = new Map<string, string>();
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < prefixes.length) {
      const prefix = prefixes[next++];
      bodies.set(prefix, await fetchRange(prefix));
      onProgress?.(++done, prefixes.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, prefixes.length) }, worker));
  const out = new Map<string, number>();
  for (const [v, h] of hashes) out.set(v, countInRange(bodies.get(h.slice(0, 5)) ?? "", h.slice(5)));
  return out;
}
