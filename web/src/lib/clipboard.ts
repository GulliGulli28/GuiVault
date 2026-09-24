/** Ce que GuiVault copie s'efface du presse-papiers au bout d'un délai —
 * **seulement s'il y est encore** : si l'utilisateur a copié autre chose
 * entre-temps, ce n'est plus à nous d'y toucher. La même règle que
 * `secretClipboard.ts` dans Guiterm (30 s) et que Bitwarden.
 *
 * Qui efface dépend de l'endroit :
 * - l'**interface web** efface elle-même (`scheduleInPage`). Une page ne
 *   peut lire le presse-papiers que si l'utilisateur l'a permis (Chrome ;
 *   jamais dans Firefox), et n'y écrit hors d'un geste de l'utilisateur
 *   (clic, touche) que si elle a le focus — et encore : Firefox refuse, et
 *   Chrome aussi sans la permission de lecture. Elle efface donc à
 *   l'échéance si elle le peut, sinon au premier geste qui suit dans la
 *   page. Sans lecture possible, elle n'efface que si elle n'a pas perdu le
 *   focus depuis la copie — personne d'autre n'a alors pu copier quoi que ce
 *   soit ; sinon elle laisse le presse-papiers tel quel plutôt que d'effacer
 *   ce que l'utilisateur y a mis depuis ;
 * - le **popup de l'extension** se ferme au premier clic ailleurs, et ses
 *   minuteries avec : il confie l'effacement au service worker
 *   (`setClearScheduler`), qui, lui, a le droit de lire le presse-papiers.
 *
 * Le délai est un réglage qui suit le compte (section `clipboard`). */
import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, utf8 } from "./bytes";
import { settingsChanged } from "./syncedSettings";

export const CLIPBOARD_KEY = "guivault.clipboard";
export const DEFAULT_CLEAR_SECONDS = 30;

/** Pas moins de 30 s : l'extension efface par une alarme, et les alarmes
 * ne descendent pas en dessous. */
export const CLEAR_CHOICES: { value: number; label: string }[] = [
  { value: 30, label: "30 secondes" },
  { value: 60, label: "1 minute" },
  { value: 120, label: "2 minutes" },
  { value: 300, label: "5 minutes" },
  { value: 0, label: "Jamais" },
];

export function loadClearSeconds(): number {
  try {
    const v = (JSON.parse(localStorage.getItem(CLIPBOARD_KEY) ?? "{}") as { clearAfterSeconds?: unknown }).clearAfterSeconds;
    return CLEAR_CHOICES.some((c) => c.value === v) ? (v as number) : DEFAULT_CLEAR_SECONDS;
  } catch {
    return DEFAULT_CLEAR_SECONDS;
  }
}

export function saveClearSeconds(seconds: number) {
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify({ clearAfterSeconds: seconds }));
  } catch {
    // sans stockage, le défaut
  }
  settingsChanged("clipboard");
}

/** L'empreinte d'une valeur copiée : ce qu'on garde pour savoir si elle est
 * encore dans le presse-papiers, plutôt que la valeur elle-même. */
export function clipboardHash(value: string): string {
  return toHex(sha256(utf8.encode(value)));
}

export type ClearScheduler = (value: string, delayMs: number) => void;

let scheduler: ClearScheduler = (value, delayMs) => scheduleInPage(value, delayMs);

/** Le popup de l'extension y branche le service worker. */
export function setClearScheduler(s: ClearScheduler) {
  scheduler = s;
}

/** Copie, et programme l'effacement selon le réglage. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    return false;
  }
  const seconds = loadClearSeconds();
  if (seconds > 0 && value !== "") scheduler(value, seconds * 1000);
  return true;
}

// ─── Dans une page ──────────────────────────────────────────────────────────

/** Ce dont l'effacement a besoin du navigateur — injectable pour les tests. */
export interface PageClipboard {
  write(text: string): Promise<void>;
  /** `null` : la page n'a pas le droit de lire (ou le navigateur ne sait pas). */
  read(): Promise<string | null>;
  hasFocus(): boolean;
  /** `gesture` : un clic ou une touche dans la page. */
  on(event: "blur" | "focus" | "copy" | "gesture", f: () => void): () => void;
  setTimeout(f: () => void, ms: number): () => void;
}

const browserClipboard: PageClipboard = {
  write: (t) => navigator.clipboard.writeText(t),
  read: async () => {
    // Sans permission accordée, `readText` ouvrirait une demande à
    // l'improviste (Chrome) ou échouerait (Firefox) : on ne la tente pas.
    try {
      const p = await navigator.permissions.query({ name: "clipboard-read" as PermissionName });
      if (p.state !== "granted") return null;
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  },
  hasFocus: () => document.hasFocus(),
  on: (event, f) => {
    if (event === "gesture") {
      // En capture : avant qu'un composant n'arrête l'événement.
      window.addEventListener("pointerdown", f, true);
      window.addEventListener("keydown", f, true);
      return () => {
        window.removeEventListener("pointerdown", f, true);
        window.removeEventListener("keydown", f, true);
      };
    }
    const target = event === "copy" ? document : window;
    target.addEventListener(event, f);
    return () => target.removeEventListener(event, f);
  },
  setTimeout: (f, ms) => {
    const t = setTimeout(f, ms);
    return () => clearTimeout(t);
  },
};

/** Au-delà, on renonce à effacer (la page est restée sans focus). */
const GIVE_UP_MS = 10 * 60_000;

let cancelPending: (() => void) | null = null;

/** Efface `value` du presse-papiers au bout de `delayMs`, si elle y est
 * encore. Une nouvelle copie remplace l'effacement en attente. */
export function scheduleInPage(value: string, delayMs: number, io: PageClipboard = browserClipboard) {
  cancelPending?.();
  // Une copie faite ici sans passer par nous (Ctrl+C sur du texte), ou un
  // passage par une autre fenêtre : le presse-papiers n'est peut-être plus
  // le nôtre.
  let elsewhere = !io.hasFocus();
  let due = false;
  const offs: (() => void)[] = [];
  const done = () => {
    offs.forEach((off) => off());
    offs.length = 0;
    if (cancelPending === done) cancelPending = null;
  };
  let busy = false;
  const attempt = async () => {
    // Écrire demande le focus : sinon, on réessaie à son retour.
    if (busy || !io.hasFocus()) return;
    busy = true;
    try {
      const current = await io.read().catch(() => null);
      const ours = current !== null ? current === value : !elsewhere;
      if (!ours) return done();
      await io.write("");
      done();
    } catch {
      // Écriture refusée hors d'un geste de l'utilisateur : au prochain.
    } finally {
      busy = false;
    }
  };
  offs.push(io.on("blur", () => { elsewhere = true; }));
  offs.push(io.on("copy", () => { elsewhere = true; }));
  offs.push(io.on("focus", () => { if (due) void attempt(); }));
  offs.push(io.on("gesture", () => { if (due) void attempt(); }));
  offs.push(io.setTimeout(() => { due = true; void attempt(); }, delayMs));
  offs.push(io.setTimeout(done, delayMs + GIVE_UP_MS));
  cancelPending = done;
}
