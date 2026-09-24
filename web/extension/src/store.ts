/** La session de l'extension, persistée entre deux ouvertures du popup.
 *
 * - `chrome.storage.session` : jetons, clés du compte, clés et noms des
 *   vaults, items déchiffrés. Mémoire du navigateur, jamais sur disque,
 *   effacée à sa fermeture — et par nous au verrouillage.
 * - `chrome.storage.local` : ce qui n'est pas secret et doit survivre
 *   (URL du serveur, e-mail, délai de verrouillage). */
import { setTokens } from "../../src/lib/api";
import { deserializeSession, serializeSession, type StoredSession } from "../../src/lib/persist";
import type { DecodedItem, SessionState } from "../../src/lib/session";
import type { Payload, TokenPair } from "../../src/lib/types";

export const LOCK_ALARM = "guivault-lock";

export interface Settings {
  serverUrl: string;
  email: string;
  /** Minutes d'inactivité avant verrouillage ; 0 = jamais (jusqu'à la
   * fermeture du navigateur). */
  lockMinutes: number;
  /** Le bouton GuiVault dans les champs de mot de passe des pages. */
  inlineAutofill: boolean;
  /** Remplir de lui-même le champ de code (TOTP) d'une page quand un seul
   * identifiant du site a un secret TOTP. */
  autoTotp: boolean;
  /** Motifs de champs de code en plus de ceux reconnus d'office, un par
   * ligne : `regex` (comparée au nom, à l'id, au libellé… du champ) ou
   * `regex d'URL => regex de champ`. */
  otpPatterns: string;
}

export const DEFAULT_SETTINGS: Settings = { serverUrl: "", email: "", lockMinutes: 15, inlineAutofill: true, autoTotp: true, otpPatterns: "" };

export interface OtpRule {
  url: RegExp | null;
  field: RegExp;
}

/** Les lignes de `otpPatterns`, compilées ; `errors` : les numéros des
 * lignes qui ne se compilent pas (ignorées). */
export function parseOtpPatterns(text: string): { rules: OtpRule[]; errors: number[] } {
  const rules: OtpRule[] = [];
  const errors: number[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const cut = line.indexOf("=>");
    try {
      if (cut >= 0) rules.push({ url: new RegExp(line.slice(0, cut).trim(), "i"), field: new RegExp(line.slice(cut + 2).trim(), "i") });
      else rules.push({ url: null, field: new RegExp(line, "i") });
    } catch {
      errors.push(i + 1);
    }
  });
  return { rules, errors };
}

/** Les items d'un vault, tels que déchiffrés à une révision donnée. */
export interface ItemsCache {
  [vaultId: string]: { revision: number; items: DecodedItem[] };
}

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(r.settings as Partial<Settings> | undefined) };
}

export async function saveSettings(s: Settings) {
  await chrome.storage.local.set({ settings: s });
}

export async function loadSession(): Promise<{ state: SessionState; tokens: TokenPair } | null> {
  const r = await chrome.storage.session.get("session");
  const s = r.session as StoredSession | undefined;
  if (!s) return null;
  const state = deserializeSession(s);
  setTokens(s.tokens);
  return { state, tokens: s.tokens };
}

export async function saveSession(state: SessionState, tokens: TokenPair) {
  await chrome.storage.session.set({ session: serializeSession(state, tokens) });
}

export async function saveTokens(tokens: TokenPair) {
  const r = await chrome.storage.session.get("session");
  const s = r.session as StoredSession | undefined;
  if (s) await chrome.storage.session.set({ session: { ...s, tokens } });
}

export async function loadItemsCache(): Promise<ItemsCache> {
  const r = await chrome.storage.session.get("items");
  return (r.items as ItemsCache | undefined) ?? {};
}

export async function saveItemsCache(cache: ItemsCache) {
  await chrome.storage.session.set({ items: cache });
}

// ─── Où en était le popup ────────────────────────────────────────────────────
//
// Un clic hors du popup le ferme, et avec lui son état React. On le garde
// ici — en mémoire de session, parce qu'un brouillon de formulaire peut
// contenir un secret — pour rouvrir au même endroit. Effacé au verrouillage
// comme le reste.

export type PopupView =
  | { kind: "list" }
  | { kind: "detail"; id: string }
  | { kind: "edit"; id: string }
  | { kind: "new"; vaultId: string; itemKind: Payload["kind"] }
  | { kind: "settings" };

export interface PopupState {
  tab: "vaults" | "totp" | "generator";
  view: PopupView;
  query: string;
  filter: string;
  /** Le formulaire en cours (`new` ou `edit`), tel qu'on l'a laissé. */
  draft: Payload | null;
  at: number;
}

/** Au-delà, on rouvre sur la liste (un brouillon, lui, est toujours repris). */
export const POPUP_STATE_TTL_MS = 15 * 60_000;

export async function loadPopupState(): Promise<PopupState | null> {
  const r = await chrome.storage.session.get("popup");
  return (r.popup as PopupState | undefined) ?? null;
}

export async function savePopupState(state: PopupState) {
  await chrome.storage.session.set({ popup: state });
}

/** Le dernier identifiant rempli dans un onglet : une page de SSO qui suit
 * (autre domaine, même onglet) peut demander *son* code TOTP. */
export const RECENT_FILL_TTL_MS = 10 * 60_000;

export async function noteRecentFill(tabId: number, loginId: string) {
  const r = await chrome.storage.session.get("recentFill");
  const all = (r.recentFill as Record<string, { id: string; at: number }> | undefined) ?? {};
  all[tabId] = { id: loginId, at: Date.now() };
  await chrome.storage.session.set({ recentFill: all });
}

export async function recentFill(tabId: number): Promise<string | null> {
  const r = await chrome.storage.session.get("recentFill");
  const e = ((r.recentFill as Record<string, { id: string; at: number }> | undefined) ?? {})[tabId];
  return e && Date.now() - e.at < RECENT_FILL_TTL_MS ? e.id : null;
}

export type LockReason = "manual" | "timeout" | "expired";

/** Efface tout ce qui est secret. Le prochain popup demande le mot de
 * passe maître — et dit pourquoi (`reason`). */
export async function lock(reason: LockReason = "manual") {
  // Verrouiller n'annule pas l'effacement du presse-papiers en attente.
  const pending = await chrome.storage.session.get(CLIPBOARD_CLEAR_KEY);
  await chrome.storage.session.clear();
  if (pending[CLIPBOARD_CLEAR_KEY]) await chrome.storage.session.set(pending);
  await chrome.alarms.clear(LOCK_ALARM);
  await chrome.storage.local.set({ lockReason: reason });
}

// ─── Presse-papiers ─────────────────────────────────────────────────────────

/** L'effacement du presse-papiers en attente (`lib/clipboard.ts`) : le popup
 * se ferme au premier clic ailleurs, le service worker s'en charge. Il n'en
 * garde que l'empreinte (SHA-256) de ce qui a été copié, en mémoire de
 * session — jamais la valeur, jamais sur disque. */
export const CLIPBOARD_ALARM = "guivault-clipboard";
const CLIPBOARD_CLEAR_KEY = "clipboardClear";

export async function scheduleClipboardClear(hash: string, delayMs: number) {
  await chrome.storage.session.set({ [CLIPBOARD_CLEAR_KEY]: hash });
  // Une alarme ne part pas avant 30 s.
  await chrome.alarms.create(CLIPBOARD_ALARM, { when: Date.now() + Math.max(delayMs, 30_000) });
}

export async function takeClipboardClear(): Promise<string | null> {
  const r = await chrome.storage.session.get(CLIPBOARD_CLEAR_KEY);
  await chrome.storage.session.remove(CLIPBOARD_CLEAR_KEY);
  return typeof r[CLIPBOARD_CLEAR_KEY] === "string" ? (r[CLIPBOARD_CLEAR_KEY] as string) : null;
}

export async function lockReason(): Promise<LockReason | null> {
  const r = await chrome.storage.local.get("lockReason");
  return (r.lockReason as LockReason | undefined) ?? null;
}

export async function clearLockReason() {
  await chrome.storage.local.remove("lockReason");
}

/** (Re)pose l'alarme de verrouillage : chaque ouverture du popup repousse
 * l'échéance. */
export async function touchLock(minutes: number) {
  await chrome.alarms.clear(LOCK_ALARM);
  if (minutes > 0) await chrome.alarms.create(LOCK_ALARM, { delayInMinutes: minutes });
}
