/** Les doublons : les repérer (rapport de santé, onglet « Doublons »), en
 * fusionner deux, en créer un exprès (« Dupliquer »). Pur : testé par
 * `duplicates.test.ts`.
 *
 * Deux identifiants sont le même compte s'ils partagent un site (domaine
 * enregistrable d'une de leurs adresses) et un utilisateur (sans casse) ;
 * deux cartes, si elles ont le même numéro. Les doublons sont cherchés dans
 * chaque vault : le même compte dans deux vaults (le sien et celui de
 * l'équipe) est souvent voulu. */
import { uuid } from "./bytes";
import type { HealthEntry } from "./health";
import { uriHost } from "./items";
import { payloadEntity } from "./session";
import type { Login, Payload } from "./types";
import { registrableDomain } from "./urimatch";

/** Les clés sous lesquelles un élément se compare aux autres. */
function keysOf(p: Payload): string[] {
  if (p.kind === "login") {
    const user = p.login.username.trim().toLowerCase();
    // Sans utilisateur, c'est le mot de passe qui dit « même compte ».
    const who = user ? `u:${user}` : p.login.password ? `p:${p.login.password}` : null;
    if (!who) return [];
    const sites = new Set(p.login.uris.map((u) => u.uri.trim()).filter(Boolean).map((u) => registrableDomain(uriHost(u))));
    return [...sites].map((s) => `login|${s}|${who}`);
  }
  if (p.kind === "card") {
    const number = p.card.number.replace(/[\s-]/g, "");
    return number.length >= 8 ? [`card|${number}`] : [];
  }
  return [];
}

/** Les groupes de doublons (deux éléments ou plus), vault par vault. Un
 * élément qui partage une clé avec deux autres les réunit tous. */
export function findDuplicates(entries: HealthEntry[]): HealthEntry[][] {
  const parent = entries.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const first = new Map<string, number>();
  entries.forEach((e, i) => {
    for (const k of keysOf(e.item.payload)) {
      const key = `${e.vault.id}|${k}`;
      const j = first.get(key);
      if (j === undefined) first.set(key, i);
      else parent[root(i)] = root(j);
    }
  });
  const groups = new Map<number, HealthEntry[]>();
  entries.forEach((e, i) => {
    if (keysOf(e.item.payload).length === 0) return;
    const r = root(i);
    groups.set(r, [...(groups.get(r) ?? []), e]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Une copie à enregistrer comme un nouvel élément : autre id, « (copie) »
 * au nom. Sans ce qui ne se partage pas entre deux éléments : les pièces
 * jointes (leurs fichiers appartiennent à l'original), les passkeys (deux
 * fois le même identifiant de passkey), l'historique des mots de passe. */
export function duplicateOf(p: Payload): Payload {
  const copy = JSON.parse(JSON.stringify(p)) as Payload;
  const e = payloadEntity(copy);
  e.id = uuid();
  if (typeof e.name === "string") e.name = e.name ? `${e.name} (copie)` : e.name;
  if (typeof e.label === "string") e.label = `${e.label} (copie)`;
  delete e.attachments;
  if (copy.kind === "login") {
    copy.login.passkeys = [];
    copy.login.passwordHistory = [];
  }
  return copy;
}

const uniqueBy = <T,>(list: T[], key: (x: T) => string): T[] => {
  const seen = new Set<string>();
  return list.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Fusionne `drop` dans `keep` : rien ne se perd. Le mot de passe de
 * `keep` reste ; celui de `drop`, s'il diffère, entre dans l'historique.
 * Adresses, passkeys, champs, étiquettes, pièces jointes et historique
 * s'unissent ; les notes se mettent bout à bout ; le code TOTP de `keep`,
 * sinon celui de `drop`. Favori ou protégé, si l'un l'est. */
export function mergeLogins(keep: Login, drop: Login, now = new Date()): Login {
  const history = [...keep.passwordHistory, ...drop.passwordHistory];
  if (drop.password && drop.password !== keep.password) history.push({ password: drop.password, changedAt: now.toISOString() });
  const notes = [keep.notes, drop.notes].map((n) => n?.trim()).filter((n): n is string => !!n);
  return {
    ...keep,
    uris: uniqueBy([...keep.uris, ...drop.uris], (u) => u.uri.trim()),
    totp: keep.totp || drop.totp,
    passkeys: uniqueBy([...keep.passkeys, ...drop.passkeys], (k) => k.credentialId),
    fields: (() => {
      const all = uniqueBy([...(keep.fields ?? []), ...(drop.fields ?? [])], (f) => `${f.name}\0${f.value}`);
      return all.length ? all : undefined;
    })(),
    tags: uniqueBy([...keep.tags, ...drop.tags], (t) => t),
    notes: uniqueBy(notes, (n) => n).join("\n\n") || undefined,
    attachments: (() => {
      const all = uniqueBy([...(keep.attachments ?? []), ...(drop.attachments ?? [])], (a) => a.id);
      return all.length ? all : undefined;
    })(),
    passwordHistory: uniqueBy(history, (h) => `${h.password}\0${h.changedAt}`),
    favorite: keep.favorite || drop.favorite || undefined,
    reprompt: keep.reprompt || drop.reprompt || undefined,
    username: keep.username || drop.username,
    password: keep.password || drop.password,
  };
}
