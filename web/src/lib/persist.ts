/** La session, mise à plat pour être rangée quelque part — et reprise.
 *
 * Le même format pour l'extension (`chrome.storage.session`) et pour
 * l'interface web (`sessionStorage` : survit au rechargement de l'onglet,
 * meurt avec lui, jamais sur disque). Dans les deux cas un délai
 * d'inactivité, réglable, efface tout avant : le même « Verrouiller après »
 * que celui du popup. */
import { fromBase64, toBase64 } from "./bytes";
import { fingerprint } from "./crypto";
import type { SessionState, VaultView } from "./session";
import type { TokenPair, UserProfile } from "./types";

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

export function serializeSession(state: SessionState, tokens: TokenPair): StoredSession {
  return {
    tokens,
    user: state.user,
    account: { userKey: toBase64(state.account.userKey), privateKey: toBase64(state.account.keypair.privateKey), publicKey: toBase64(state.account.keypair.publicKey) },
    vaults: state.vaults.map((v) => ({ id: v.id, kind: v.kind, role: v.role, name: v.name, key: toBase64(v.key), revision: v.revision, updatedAt: v.updatedAt })),
  };
}

export function deserializeSession(s: StoredSession): SessionState {
  const privateKey = fromBase64(s.account.privateKey);
  const publicKey = fromBase64(s.account.publicKey);
  return {
    user: s.user,
    account: { userKey: fromBase64(s.account.userKey), keypair: { privateKey, publicKey } },
    fingerprint: fingerprint(publicKey),
    vaults: s.vaults.map((v) => ({ ...v, key: fromBase64(v.key) })),
    invitations: [],
  };
}

// ─── Interface web ──────────────────────────────────────────────────────────

const SESSION_KEY = "guivault.session";
const LOCK_KEY = "guivault.lockMinutes";
export const DEFAULT_LOCK_MINUTES = 15;

/** Les délais proposés — les mêmes que dans l'extension. `0` : jamais, la
 * session ne meurt qu'avec l'onglet. */
export const LOCK_CHOICES: { value: number; label: string }[] = [
  { value: 5, label: "5 minutes d'inactivité" },
  { value: 15, label: "15 minutes d'inactivité" },
  { value: 60, label: "1 heure d'inactivité" },
  { value: 480, label: "8 heures d'inactivité" },
  { value: 0, label: "À la fermeture de l'onglet" },
];

export function loadLockMinutes(): number {
  try {
    const n = Number(localStorage.getItem(LOCK_KEY));
    return LOCK_CHOICES.some((c) => c.value === n) ? n : DEFAULT_LOCK_MINUTES;
  } catch {
    return DEFAULT_LOCK_MINUTES;
  }
}

export function saveLockMinutes(n: number): void {
  try {
    localStorage.setItem(LOCK_KEY, String(n));
  } catch {
    // Pas de stockage : le défaut.
  }
}

interface WebStored extends StoredSession {
  /** Dernière activité (ms depuis l'epoch) : ce que le délai mesure. */
  lastActivity: number;
}

function read(): WebStored | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as WebStored) : null;
  } catch {
    return null;
  }
}

function write(s: WebStored | null): void {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Pas de stockage : la session vaut jusqu'au rechargement.
  }
}

export function saveWebSession(state: SessionState, tokens: TokenPair): void {
  write({ ...serializeSession(state, tokens), lastActivity: Date.now() });
}

export function saveWebTokens(tokens: TokenPair): void {
  const s = read();
  if (s) write({ ...s, tokens });
}

export function clearWebSession(): void {
  write(null);
}

/** L'inactivité tolérée est dépassée ? Alors la session est effacée ici
 * même, et on le dit. */
export function webSessionExpired(s: WebStored, now = Date.now()): boolean {
  const minutes = loadLockMinutes();
  return minutes > 0 && now - s.lastActivity > minutes * 60_000;
}

/** La session laissée par l'onglet avant rechargement — `expired` si le
 * délai d'inactivité l'a tuée entre-temps, `null` s'il n'y en avait pas. */
export function loadWebSession(): { state: SessionState; tokens: TokenPair } | "expired" | null {
  const s = read();
  if (!s) return null;
  if (webSessionExpired(s)) {
    write(null);
    return "expired";
  }
  return { state: deserializeSession(s), tokens: s.tokens };
}

/** Marque une activité : appelé à chaque geste, sans écrire plus d'une fois
 * toutes les dix secondes. */
let lastTouch = 0;
export function touchWebSession(): void {
  const now = Date.now();
  if (now - lastTouch < 10_000) return;
  lastTouch = now;
  const s = read();
  if (s) write({ ...s, lastActivity: now });
}

/** Le délai est-il dépassé pour la session en cours ? À demander
 * périodiquement pendant que l'onglet est ouvert. */
export function webSessionIdle(): boolean {
  const s = read();
  return s ? webSessionExpired(s) : false;
}
