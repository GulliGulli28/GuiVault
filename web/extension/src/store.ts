/** La session de l'extension, persistée entre deux ouvertures du popup.
 *
 * - `chrome.storage.session` : jetons, clés du compte, clés et noms des
 *   vaults, items déchiffrés. Mémoire du navigateur, jamais sur disque,
 *   effacée à sa fermeture — et par nous au verrouillage.
 * - `chrome.storage.local` : ce qui n'est pas secret et doit survivre
 *   (URL du serveur, e-mail, délai de verrouillage). */
import { setTokens } from "../../src/lib/api";
import { fromBase64, toBase64 } from "../../src/lib/bytes";
import { fingerprint } from "../../src/lib/crypto";
import type { DecodedItem, SessionState, VaultView } from "../../src/lib/session";
import type { TokenPair, UserProfile } from "../../src/lib/types";

export const LOCK_ALARM = "guivault-lock";

export interface Settings {
  serverUrl: string;
  email: string;
  /** Minutes d'inactivité avant verrouillage ; 0 = jamais (jusqu'à la
   * fermeture du navigateur). */
  lockMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = { serverUrl: "", email: "", lockMinutes: 15 };

interface StoredVault {
  id: string;
  kind: VaultView["kind"];
  role: VaultView["role"];
  name: string;
  key: string;
  revision: number;
  updatedAt: string;
}

export interface StoredSession {
  tokens: TokenPair;
  user: UserProfile;
  account: { userKey: string; privateKey: string; publicKey: string };
  vaults: StoredVault[];
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
  const privateKey = fromBase64(s.account.privateKey);
  const publicKey = fromBase64(s.account.publicKey);
  const state: SessionState = {
    user: s.user,
    account: { userKey: fromBase64(s.account.userKey), keypair: { privateKey, publicKey } },
    fingerprint: fingerprint(publicKey),
    vaults: s.vaults.map((v) => ({ ...v, key: fromBase64(v.key) })),
    invitations: [],
  };
  setTokens(s.tokens);
  return { state, tokens: s.tokens };
}

export async function saveSession(state: SessionState, tokens: TokenPair) {
  const s: StoredSession = {
    tokens,
    user: state.user,
    account: { userKey: toBase64(state.account.userKey), privateKey: toBase64(state.account.keypair.privateKey), publicKey: toBase64(state.account.keypair.publicKey) },
    vaults: state.vaults.map((v) => ({ id: v.id, kind: v.kind, role: v.role, name: v.name, key: toBase64(v.key), revision: v.revision, updatedAt: v.updatedAt })),
  };
  await chrome.storage.session.set({ session: s });
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

/** Efface tout ce qui est secret. Le prochain popup demande le mot de
 * passe maître. */
export async function lock() {
  await chrome.storage.session.clear();
  await chrome.alarms.clear(LOCK_ALARM);
}

/** (Re)pose l'alarme de verrouillage : chaque ouverture du popup repousse
 * l'échéance. */
export async function touchLock(minutes: number) {
  await chrome.alarms.clear(LOCK_ALARM);
  if (minutes > 0) await chrome.alarms.create(LOCK_ALARM, { delayInMinutes: minutes });
}
