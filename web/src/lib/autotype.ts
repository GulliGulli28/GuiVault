/** La saisie automatique, à la KeePass : taper un identifiant dans une autre
 * fenêtre, d'après une **séquence** (`{USERNAME}{TAB}{PASSWORD}{ENTER}`).
 * Ce module ne tape rien — il dit quoi taper (`AutoTypeAction[]`) et pour
 * quelle fenêtre ; c'est l'application qui tape (`platform.ts`,
 * `app-tauri/src/autotype.rs`). Tout est pur, donc testé à part.
 *
 * Séquences : du texte tapé tel quel, et des champs entre accolades —
 * `{USERNAME}` `{PASSWORD}` `{TITLE}` `{URL}` `{NOTES}` `{TOTP}`
 * `{S:nom}` (un champ personnalisé) ; des touches `{TAB}` `{ENTER}`
 * `{SPACE}` `{BACKSPACE}` `{DELETE}` `{ESC}` `{UP}` `{DOWN}` `{LEFT}`
 * `{RIGHT}` `{HOME}` `{END}` `{PGUP}` `{PGDN}` `{INSERT}`, répétées par
 * `{TAB 3}` ; une pause `{DELAY 500}` (ms) ; `{{}` et `{}}` pour les
 * accolades. Un champ inconnu est une erreur : mieux vaut ne rien taper que
 * taper `{USERNAEM}` dans un formulaire. Les noms sont ceux de KeePass, sans
 * casse. */
import { parseTotp, totpCode } from "./totp";
import type { AutoType, Login } from "./types";

export const DEFAULT_SEQUENCE = "{USERNAME}{TAB}{PASSWORD}{ENTER}";

export type AutoTypeKey = "Tab" | "Enter" | "Space" | "Backspace" | "Delete" | "Escape" | "Up" | "Down" | "Left" | "Right" | "Home" | "End" | "PageUp" | "PageDown" | "Insert";

export type AutoTypeAction =
  | { kind: "text"; text: string }
  | { kind: "key"; key: AutoTypeKey }
  | { kind: "delay"; ms: number };

const KEYS: Record<string, AutoTypeKey> = {
  TAB: "Tab", ENTER: "Enter", SPACE: "Space",
  BACKSPACE: "Backspace", BS: "Backspace", BKSP: "Backspace",
  DELETE: "Delete", DEL: "Delete", ESC: "Escape",
  UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right",
  HOME: "Home", END: "End", PGUP: "PageUp", PGDN: "PageDown",
  INSERT: "Insert", INS: "Insert",
};
const FIELDS = new Set(["USERNAME", "PASSWORD", "TITLE", "URL", "NOTES", "TOTP"]);
/** Au-delà, c'est une faute de frappe, pas une intention. */
const MAX_REPEAT = 100;
const MAX_DELAY = 10_000;

export class AutoTypeError extends Error {}

type Token =
  | { kind: "text"; text: string }
  | { kind: "field"; name: string }
  | { kind: "custom"; name: string }
  | { kind: "key"; key: AutoTypeKey; times: number }
  | { kind: "delay"; ms: number };

/** Découpe une séquence ; lève `AutoTypeError` sur ce qu'elle ne comprend
 * pas — à montrer sous le champ de la séquence, avant d'enregistrer. */
export function parseSequence(sequence: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const text = (t: string) => {
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  while (i < sequence.length) {
    const c = sequence[i];
    if (c === "}") {
      if (sequence.startsWith("}}", i)) throw new AutoTypeError("« }} » : pour une accolade fermante, écrire {}}.");
      throw new AutoTypeError(`Accolade fermante sans ouvrante (position ${i + 1}). Pour la taper : {}}.`);
    }
    if (c !== "{") {
      text(c);
      i++;
      continue;
    }
    // `{{}` et `{}}` : les accolades elles-mêmes.
    if (sequence.startsWith("{{}", i) || sequence.startsWith("{}}", i)) {
      text(sequence[i + 1]);
      i += 3;
      continue;
    }
    const end = sequence.indexOf("}", i);
    if (end < 0) throw new AutoTypeError(`Accolade ouvrante sans fermante (position ${i + 1}).`);
    const inner = sequence.slice(i + 1, end).trim();
    i = end + 1;
    if (/^S:/i.test(inner)) {
      const name = inner.slice(2).trim();
      if (!name) throw new AutoTypeError("{S:…} : il manque le nom du champ.");
      out.push({ kind: "custom", name });
      continue;
    }
    const m = /^([A-Za-z]+)(?:\s+(\d+))?$/.exec(inner);
    if (!m) throw new AutoTypeError(`{${inner}} : inconnu.`);
    const name = m[1].toUpperCase();
    const n = m[2] === undefined ? null : Number(m[2]);
    if (name === "DELAY") {
      if (n === null) throw new AutoTypeError("{DELAY} : il manque la durée, en millisecondes ({DELAY 500}).");
      if (n > MAX_DELAY) throw new AutoTypeError(`{DELAY ${n}} : ${MAX_DELAY} ms au plus.`);
      out.push({ kind: "delay", ms: n });
    } else if (KEYS[name]) {
      if (n !== null && (n < 1 || n > MAX_REPEAT)) throw new AutoTypeError(`{${inner}} : de 1 à ${MAX_REPEAT} fois.`);
      out.push({ kind: "key", key: KEYS[name], times: n ?? 1 });
    } else if (FIELDS.has(name)) {
      if (n !== null) throw new AutoTypeError(`{${inner}} : un champ ne se répète pas.`);
      out.push({ kind: "field", name });
    } else {
      throw new AutoTypeError(`{${inner}} : inconnu.`);
    }
  }
  return out;
}

/** Le message d'erreur d'une séquence, ou `null` si elle se lit. */
export function sequenceError(sequence: string): string | null {
  try {
    parseSequence(sequence);
    return null;
  } catch (e) {
    return e instanceof AutoTypeError ? e.message : String(e);
  }
}

/** Ce qu'il faut taper pour `login` : la séquence lue, les champs
 * remplacés par leur valeur, le code TOTP du moment calculé. Un champ vide
 * ne tape rien ; un `{TOTP}` sans secret, un `{S:…}` absent sont des
 * erreurs (la séquence ne ferait pas ce qu'on attend). */
export async function resolveSequence(sequence: string, login: Login, now = Date.now()): Promise<AutoTypeAction[]> {
  const out: AutoTypeAction[] = [];
  const text = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  for (const tok of parseSequence(sequence)) {
    switch (tok.kind) {
      case "text":
        text(tok.text);
        break;
      case "key":
        for (let k = 0; k < tok.times; k++) out.push({ kind: "key", key: tok.key });
        break;
      case "delay":
        out.push({ kind: "delay", ms: tok.ms });
        break;
      case "custom": {
        const f = (login.fields ?? []).find((x) => x.name.toLowerCase() === tok.name.toLowerCase());
        if (!f) throw new AutoTypeError(`{S:${tok.name}} : « ${login.name} » n'a pas de champ « ${tok.name} ».`);
        text(f.value);
        break;
      }
      case "field":
        switch (tok.name) {
          case "USERNAME": text(login.username); break;
          case "PASSWORD": text(login.password); break;
          case "TITLE": text(login.name); break;
          case "URL": text(login.uris[0]?.uri ?? ""); break;
          case "NOTES": text(login.notes ?? ""); break;
          case "TOTP": {
            const p = login.totp ? parseTotp(login.totp) : null;
            if (!p) throw new AutoTypeError(`{TOTP} : « ${login.name} » n'a pas de secret TOTP.`);
            text(await totpCode(p, now));
            break;
          }
        }
    }
  }
  return out;
}

/** Un motif de titre : `*` = n'importe quoi, le reste littéral, sans casse,
 * sur tout le titre. */
export function titleMatches(pattern: string, title: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "is");
  return re.test(title.trim());
}

function hostOf(uri: string): string | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : `https://${uri}`).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function autoTypeEnabled(login: Login): boolean {
  return login.autoType?.enabled !== false;
}

/** Un identifiant que le raccourci global propose pour une fenêtre, et la
 * séquence à y taper. */
export interface AutoTypeMatch<T> {
  item: T;
  sequence: string;
  /** Pourquoi : un motif de fenêtre associé (le plus précis), le nom dans
   * le titre, ou le domaine d'une de ses adresses. */
  reason: "window" | "title" | "url";
}

/** Les identifiants à proposer pour la fenêtre `title`, comme KeePass : un
 * motif de fenêtre associé qui correspond, sinon le nom de l'identifiant
 * contenu dans le titre, sinon le domaine d'une de ses adresses. Les motifs
 * d'abord : qui en a réglé un sait ce qu'il veut. */
export function matchWindow<T>(title: string, items: T[], loginOf: (item: T) => Login, defaultSequence = DEFAULT_SEQUENCE): AutoTypeMatch<T>[] {
  const t = title.trim();
  if (!t) return [];
  const lower = t.toLowerCase();
  const byWindow: AutoTypeMatch<T>[] = [];
  const byTitle: AutoTypeMatch<T>[] = [];
  const byUrl: AutoTypeMatch<T>[] = [];
  for (const item of items) {
    const login = loginOf(item);
    if (!autoTypeEnabled(login)) continue;
    const own = sequenceOf(login.autoType, defaultSequence);
    const w = (login.autoType?.windows ?? []).find((x) => titleMatches(x.title, t));
    if (w) {
      byWindow.push({ item, sequence: w.sequence?.trim() || own, reason: "window" });
    } else if (login.name.trim().length >= 2 && lower.includes(login.name.trim().toLowerCase())) {
      byTitle.push({ item, sequence: own, reason: "title" });
    } else if (login.uris.some((u) => {
      const h = hostOf(u.uri);
      return !!h && lower.includes(h);
    })) {
      byUrl.push({ item, sequence: own, reason: "url" });
    }
  }
  return [...byWindow, ...byTitle, ...byUrl];
}

/** La séquence d'un identifiant, à défaut celle de l'application. */
export function sequenceOf(autoType: AutoType | undefined, defaultSequence = DEFAULT_SEQUENCE): string {
  return autoType?.sequence?.trim() || defaultSequence;
}

// ─── Réglages de l'application (cet appareil) ───────────────────────────────

export interface AutoTypeSettings {
  /** Le raccourci global ; `""` : désactivé. Syntaxe des accélérateurs de
   * Tauri : `Ctrl+Alt+A`, `Super+Shift+V`… */
  hotkey: string;
  /** La séquence des identifiants qui n'en ont pas. */
  defaultSequence: string;
}

const SETTINGS_KEY = "guivault.autotype";
export const DEFAULT_SETTINGS: AutoTypeSettings = { hotkey: "Ctrl+Alt+A", defaultSequence: DEFAULT_SEQUENCE };

export function loadAutoTypeSettings(): AutoTypeSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<AutoTypeSettings> | null;
    return {
      hotkey: typeof raw?.hotkey === "string" ? raw.hotkey : DEFAULT_SETTINGS.hotkey,
      defaultSequence: typeof raw?.defaultSequence === "string" && !sequenceError(raw.defaultSequence) ? raw.defaultSequence : DEFAULT_SETTINGS.defaultSequence,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveAutoTypeSettings(s: AutoTypeSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // stockage indisponible : le réglage vaut pour cette fenêtre seulement
  }
}
