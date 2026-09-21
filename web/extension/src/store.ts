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
import type { TokenPair } from "../../src/lib/types";

export const LOCK_ALARM = "guivault-lock";

export interface Settings {
  serverUrl: string;
  email: string;
  /** Minutes d'inactivité avant verrouillage ; 0 = jamais (jusqu'à la
   * fermeture du navigateur). */
  lockMinutes: number;
  /** Le bouton GuiVault dans les champs de mot de passe des pages. */
  inlineAutofill: boolean;
}

export const DEFAULT_SETTINGS: Settings = { serverUrl: "", email: "", lockMinutes: 15, inlineAutofill: true };

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

export type LockReason = "manual" | "timeout" | "expired";

/** Efface tout ce qui est secret. Le prochain popup demande le mot de
 * passe maître — et dit pourquoi (`reason`). */
export async function lock(reason: LockReason = "manual") {
  await chrome.storage.session.clear();
  await chrome.alarms.clear(LOCK_ALARM);
  await chrome.storage.local.set({ lockReason: reason });
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
