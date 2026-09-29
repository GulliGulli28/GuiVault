/** La fusion champ par champ d'un élément modifié des deux côtés : l'écriture
 * a été refusée (`409 revision_mismatch`) parce qu'un autre appareil ou un
 * autre membre l'a enregistré pendant qu'on le modifiait. Trois versions :
 * `base`, celle qu'on a ouverte ; `mine`, la nôtre ; `theirs`, celle du
 * serveur. Un champ changé d'un seul côté est repris tel quel ; changé des
 * deux côtés différemment, c'est à l'utilisateur de choisir (`MergeDialog`).
 *
 * Le grain est le champ de l'entité (`login.password`, `login.uris`…) : un
 * tableau (sites, tags, champs personnalisés) se reprend en entier. Le
 * résultat part de la version du serveur, pour garder ce que ce client ne
 * connaît pas (champs ajoutés par Guiterm ou une version plus récente). */
import { PASSWORD_HISTORY_MAX } from "./items";
import type { Payload, PasswordHistoryEntry } from "./types";

export type Side = "mine" | "theirs";

export interface MergeField {
  /** `login.password`, ou une clé du payload hors entité (`secrets.password`, `content`). */
  path: string;
  label: string;
  base: unknown;
  mine: unknown;
  theirs: unknown;
  /** À masquer à l'affichage. */
  secret: boolean;
}

export interface MergePlan {
  /** Changés de notre côté seulement : gardés. */
  fromMine: MergeField[];
  /** Changés en face seulement : repris. */
  fromTheirs: MergeField[];
  /** Changés des deux côtés, différemment : à choisir. */
  conflicts: MergeField[];
}

/** Fusionnés par union plutôt que choisis : l'historique des mots de passe
 * (les deux côtés y ajoutent l'ancien mot de passe en le changeant). */
const UNION = new Set(["login.passwordHistory"]);

const LABELS: Record<string, string> = {
  name: "Nom",
  label: "Nom",
  username: "Utilisateur",
  password: "Mot de passe",
  passphrase: "Phrase de passe",
  uris: "Sites",
  totp: "Code TOTP",
  passkeys: "Clés d'accès (passkeys)",
  notes: "Notes",
  tags: "Tags",
  groupId: "Dossier",
  parentId: "Dossier parent",
  favorite: "Favori",
  fields: "Champs personnalisés",
  content: "Contenu",
  hostname: "Adresse",
  port: "Port",
  icon: "Icône",
  color: "Couleur",
  command: "Commande",
  description: "Description",
  steps: "Étapes",
  secret: "Secret",
  keyId: "Identifiant de la clé",
  accessKeyId: "Clé d'accès",
  secretAccessKey: "Clé secrète",
  profiles: "Profils",
  number: "Numéro",
  code: "Code de sécurité",
  cardholderName: "Titulaire",
  expMonth: "Mois d'expiration",
  expYear: "Année d'expiration",
  expiresAt: "Expiration",
};

/** Libellés propres à un type (`kind:clé`). */
const KIND_LABELS: Record<string, string> = {
  "key:content": "Clé privée",
  "note:content": "Contenu",
};

const SECRET_KEYS = new Set(["password", "passphrase", "secret", "secretAccessKey", "totp", "number", "code", "keyValue", "ssn", "passportNumber", "licenseNumber"]);

export function fieldLabel(kind: string, path: string): string {
  const last = path.split(".").pop()!;
  return KIND_LABELS[`${kind}:${last}`] ?? LABELS[last] ?? last;
}

function isSecret(kind: string, path: string): boolean {
  const last = path.split(".").pop()!;
  return SECRET_KEYS.has(last) || (last === "content" && (kind === "key" || kind === "note"));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Le payload à plat, un niveau sous chaque objet (l'entité, `secrets`). */
function flatten(p: Payload): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(p)) {
    if (k === "kind") continue;
    if (isPlainObject(v)) for (const [sub, sv] of Object.entries(v)) out.set(`${k}.${sub}`, sv);
    else out.set(k, v);
  }
  return out;
}

/** JSON aux clés triées : l'ordre des clés n'est pas une modification. */
function canonical(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

export function planMerge(base: Payload, mine: Payload, theirs: Payload): MergePlan {
  const [b, m, t] = [flatten(base), flatten(mine), flatten(theirs)];
  const plan: MergePlan = { fromMine: [], fromTheirs: [], conflicts: [] };
  for (const path of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const field: MergeField = { path, label: fieldLabel(mine.kind, path), base: b.get(path), mine: m.get(path), theirs: t.get(path), secret: isSecret(mine.kind, path) };
    if (UNION.has(path) || same(field.mine, field.theirs)) continue;
    if (same(field.mine, field.base)) plan.fromTheirs.push(field);
    else if (same(field.theirs, field.base)) plan.fromMine.push(field);
    else plan.conflicts.push(field);
  }
  return plan;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const [head, sub] = path.split(".", 2);
  if (sub === undefined) {
    if (value === undefined) delete target[head];
    else target[head] = value;
    return;
  }
  const obj = (isPlainObject(target[head]) ? target[head] : (target[head] = {})) as Record<string, unknown>;
  if (value === undefined) delete obj[sub];
  else obj[sub] = value;
}

/** La version fusionnée : celle du serveur, plus nos changements, plus nos
 * choix (`mine` par défaut). */
export function buildMerge(mine: Payload, theirs: Payload, plan: MergePlan, choices: Record<string, Side> = {}, now = new Date()): Payload {
  const out = JSON.parse(JSON.stringify(theirs)) as Payload & Record<string, unknown>;
  for (const f of plan.fromMine) setPath(out, f.path, f.mine);
  for (const f of plan.conflicts) if ((choices[f.path] ?? "mine") === "mine") setPath(out, f.path, f.mine);
  if (out.kind === "login" && mine.kind === "login" && theirs.kind === "login") {
    // Les deux historiques ; et le mot de passe écarté par la fusion y entre :
    // il était en vigueur d'un côté, on ne le perd pas.
    const history = new Map<string, PasswordHistoryEntry>();
    for (const h of [...(mine.login.passwordHistory ?? []), ...(theirs.login.passwordHistory ?? [])]) {
      const known = history.get(h.password);
      if (!known || known.changedAt < h.changedAt) history.set(h.password, h);
    }
    const kept = out.login.password;
    for (const dropped of [mine.login.password, theirs.login.password]) {
      if (dropped && dropped !== kept && !history.has(dropped)) history.set(dropped, { password: dropped, changedAt: now.toISOString() });
    }
    history.delete(kept);
    out.login.passwordHistory = [...history.values()].sort((a, b) => b.changedAt.localeCompare(a.changedAt)).slice(0, PASSWORD_HISTORY_MAX);
  }
  return out;
}
