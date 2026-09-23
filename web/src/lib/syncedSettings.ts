/** Les réglages qui suivent le compte d'un appareil à l'autre : l'apparence,
 * le générateur, et ce que l'extension ajoute (remplissage, codes). Ils
 * voyagent en un seul blob scellé sous la *user key* (`PUT
 * /users/me/settings`) : le serveur les garde sans pouvoir les lire.
 *
 * Chaque réglage est une **section** (`registerSettingsSection`) qui sait se
 * lire et s'écrire localement — `localStorage` pour le web,
 * `chrome.storage.local` pour ce qui est propre à l'extension. Un client ne
 * touche jamais une section qu'il ne connaît pas : il la réécrit telle
 * qu'elle est venue (le web ne connaît pas `extension`).
 *
 * Restent propres à l'appareil : le délai de verrouillage (on ne verrouille
 * pas un portable comme un poste fixe), les épingles et l'état des listes.
 *
 * Le dernier qui écrit l'emporte, section par section : une modification
 * locale n'écrase que la sienne, et un appareil qui écrit sur une révision
 * dépassée (409) reprend celle du serveur avant de réécrire. */
import { api, ApiError } from "./api";
import { fromBase64, toBase64 } from "./bytes";
import { openUserSettings, sealUserSettings } from "./crypto";
import type { UserSettings } from "./types";

export interface SettingsSection {
  key: string;
  read: () => unknown | Promise<unknown>;
  write: (value: unknown) => void | Promise<void>;
}

const sections = new Map<string, SettingsSection>();

export function registerSettingsSection(section: SettingsSection) {
  sections.set(section.key, section);
}

// ─── Activation (par appareil) ──────────────────────────────────────────────

const ENABLED_KEY = "guivault.settingsSync";

export function settingsSyncEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSettingsSyncEnabled(on: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
  } catch {
    // sans stockage, le réglage vaut pour la session
  }
  if (on && userKey) void pullSettings();
}

// ─── État ───────────────────────────────────────────────────────────────────

let userKey: Uint8Array | null = null;
/** La révision lue ou écrite en dernier ; `null` : aucune n'existe encore. */
let revision: number | null = null;
/** Le contenu complet connu du serveur, sections inconnues comprises. */
let remote: Record<string, unknown> = {};
/** Les sections modifiées ici et pas encore envoyées. */
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** Faux jusqu'à la première lecture : un écran qui enregistre ses réglages
 * en s'ouvrant (le générateur) ne doit pas passer pour une modification et
 * écraser ceux du compte. */
let ready = false;
let running: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

/** Prévenu quand des réglages venus d'ailleurs viennent d'être appliqués :
 * un écran qui garde les siens en état React les relit. */
export function onSettingsApplied(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Une file : jamais deux échanges à la fois, l'état ci-dessus reste cohérent. */
function queue(task: () => Promise<void>): Promise<void> {
  running = running.then(task).catch(() => {});
  return running;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function decode(s: UserSettings): Record<string, unknown> {
  if (!userKey) return {};
  const data = JSON.parse(openUserSettings(userKey, fromBase64(s.blob))) as unknown;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

// ─── Échanges ───────────────────────────────────────────────────────────────

/** À la connexion (ou au déverrouillage) : lit ce que le compte a, et
 * l'applique ; s'il n'a rien, cet appareil envoie les siens. */
export function startSettingsSync(key: Uint8Array): Promise<void> {
  userKey = key;
  revision = null;
  remote = {};
  dirty.clear();
  ready = false;
  return pullSettings().finally(() => { ready = true; });
}

export function stopSettingsSync() {
  userKey = null;
  ready = false;
  clearTimeout(timer);
  dirty.clear();
}

/** Relit le serveur (événement `settings_changed`, connexion). */
export function pullSettings(): Promise<void> {
  return queue(async () => {
    if (!userKey || !settingsSyncEnabled()) return;
    const s = await api.settings();
    if (!s) {
      // Premier appareil du compte : il donne le ton.
      for (const k of sections.keys()) dirty.add(k);
      await pushNow();
      return;
    }
    if (s.revision === revision) return;
    await apply(s);
  });
}

async function apply(s: UserSettings) {
  const data = decode(s);
  revision = s.revision;
  remote = data;
  let changed = false;
  for (const [k, section] of sections) {
    // Une modification locale en attente passe avant ce qu'on reçoit : elle
    // partira au prochain envoi.
    if (dirty.has(k) || !(k in data)) continue;
    if (same(await section.read(), data[k])) continue;
    await section.write(data[k]);
    changed = true;
  }
  if (changed) for (const f of listeners) f();
}

/** Un réglage a changé ici : envoyé un peu plus tard (plusieurs frappes =
 * un envoi). */
export function settingsChanged(key: string) {
  if (!userKey || !ready || !settingsSyncEnabled() || !sections.has(key)) return;
  dirty.add(key);
  clearTimeout(timer);
  timer = setTimeout(() => void queue(pushNow), 1200);
}

async function pushNow(retry = true): Promise<void> {
  if (!userKey || dirty.size === 0) return;
  const next = { ...remote };
  for (const k of dirty) {
    const section = sections.get(k);
    if (section) next[k] = await section.read();
  }
  if (same(next, remote) && revision !== null) {
    dirty.clear();
    return;
  }
  const blob = toBase64(sealUserSettings(userKey, JSON.stringify(next)));
  try {
    const saved = await api.putSettings(blob, revision);
    revision = saved.revision;
    remote = next;
    dirty.clear();
  } catch (e) {
    if (retry && e instanceof ApiError && e.code === "revision_mismatch") {
      // Un autre appareil a écrit entre-temps : on reprend sa version (sauf
      // nos sections en attente), puis on réécrit par-dessus.
      const current = e.extra.current as UserSettings | null | undefined;
      if (current) await apply(current);
      else revision = null;
      return pushNow(false);
    }
    throw e;
  }
}
