/** Le client HTTP de l'API, sans cryptographie — l'équivalent de
 * `core/src/guivault/client.rs` dans Guiterm. Une méthode par route ; les
 * blobs restent en base64, c'est `session.ts` qui chiffre et déchiffre. */
import type {
  AuditEntry, HealthResponse, Invitation, Item, ItemsPage, KdfParams, LoginResponse, PreloginResponse, Role,
  ServerEvent, Session, SyncResponse, TokenPair, TotpChallenge, UserLookupResponse, UserProfile, UserSettings, Vault, VaultMember,
} from "./types";

/** L'API : relative dans l'interface embarquée (même origine), absolue dans
 * l'extension (`setBaseUrl`). */
let BASE = "/api/v1";

export function setBaseUrl(serverUrl: string) {
  BASE = `${serverUrl.trim().replace(/\/+$/, "")}/api/v1`;
}

export function baseUrl(): string {
  return BASE;
}

/** Une erreur renvoyée par le serveur : `code` stable, `message` humain, et
 * les champs supplémentaires selon le code (`current` sur
 * `revision_mismatch`). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

interface Tokens {
  access: string;
  refresh: string;
}

let tokens: Tokens | null = null;
let refreshing: Promise<void> | null = null;
/** Le serveur a refusé le jeton et le rafraîchissement a échoué : la session
 * est morte, l'application repasse à l'écran de connexion. */
let onSessionLost: (() => void) | null = null;
/** Les jetons ont tourné (connexion, rafraîchissement) : l'extension les
 * re-persiste, l'interface embarquée n'en a pas besoin. */
let onTokensChanged: ((t: TokenPair | null) => void) | null = null;

let lastPair: TokenPair | null = null;

export function setTokens(t: TokenPair | null) {
  tokens = t ? { access: t.access_token, refresh: t.refresh_token } : null;
  lastPair = t;
  onTokensChanged?.(t);
}

export function setTokensChangedHandler(f: ((t: TokenPair | null) => void) | null) {
  onTokensChanged = f;
}

export function hasSession(): boolean {
  return tokens !== null;
}

/** Les jetons en cours, pour qui persiste la session avec eux. */
export function currentTokens(): TokenPair | null {
  return lastPair;
}

export function setSessionLostHandler(f: (() => void) | null) {
  onSessionLost = f;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as Record<string, unknown>;
    const code = typeof b.code === "string" ? b.code : `http_${res.status}`;
    const message = typeof b.message === "string" ? b.message : res.status === 429 ? "Trop de tentatives, réessayez dans un instant." : `Erreur ${res.status}`;
    const { code: _c, message: _m, ...extra } = b;
    throw new ApiError(res.status, code, message, extra);
  }
  return body as T;
}

async function raw<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && tokens) headers.authorization = `Bearer ${tokens.access}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return parse<T>(res);
}

/** Rafraîchit le jeton d'accès — une seule fois même si plusieurs requêtes
 * échouent en même temps (le jeton de rafraîchissement tourne à chaque usage,
 * le présenter deux fois serait pris pour un rejeu). */
async function refreshTokens(): Promise<void> {
  if (!refreshing) {
    refreshing = (async () => {
      const t = tokens;
      if (!t) throw new ApiError(401, "unauthorized", "Session expirée");
      try {
        const pair = await raw<TokenPair>("POST", "/auth/refresh", { refresh_token: t.refresh }, false);
        setTokens(pair);
      } catch (e) {
        tokens = null;
        lastPair = null;
        onSessionLost?.();
        throw e;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await raw<T>(method, path, body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && tokens) {
      await refreshTokens();
      return raw<T>(method, path, body);
    }
    throw e;
  }
}

const q = (s: string) => encodeURIComponent(s);

export const api = {
  health: () => raw<HealthResponse>("GET", "/health", undefined, false),

  // ── Authentification ──
  prelogin: (email: string) => raw<PreloginResponse>("POST", "/auth/prelogin", { email }, false),
  register: (req: {
    email: string; kdf: KdfParams; kdf_salt: string; auth_key: string; protected_user_key: string; public_key: string;
    protected_private_key: string; personal_vault: { id: string; name_enc: string; wrapped_vault_key: string }; device_name?: string;
  }) => raw<LoginResponse>("POST", "/auth/register", req, false),
  login: async (email: string, auth_key: string, device_name: string): Promise<{ kind: "ok"; login: LoginResponse } | { kind: "totp"; challenge: TotpChallenge }> => {
    const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, auth_key, device_name }) });
    if (res.status === 202) return { kind: "totp", challenge: await parse<TotpChallenge>(res) };
    return { kind: "ok", login: await parse<LoginResponse>(res) };
  },
  totpVerify: (totp_token: string, code: string) => raw<LoginResponse>("POST", "/auth/totp/verify", { totp_token, code }, false),
  logout: () => authed<void>("POST", "/auth/logout"),
  changePassword: (req: { current_auth_key: string; kdf: KdfParams; kdf_salt: string; auth_key: string; protected_user_key: string }) =>
    authed<void>("POST", "/auth/password", req),
  sessions: () => authed<Session[]>("GET", "/auth/sessions"),
  revokeSession: (id: string) => authed<void>("DELETE", `/auth/sessions/${id}`),
  totpStatus: () => authed<{ enabled: boolean }>("GET", "/auth/totp"),
  totpSetup: () => authed<{ secret: string; otpauth_url: string }>("POST", "/auth/totp/setup"),
  totpEnable: (code: string) => authed<{ recovery_codes: string[] }>("POST", "/auth/totp/enable", { code }),
  totpDisable: (code: string) => authed<void>("POST", "/auth/totp/disable", { code }),

  // ── Compte ──
  me: () => authed<UserProfile>("GET", "/users/me"),
  myAudit: (limit = 100) => authed<AuditEntry[]>("GET", `/users/me/audit?limit=${limit}`),
  settings: () => authed<UserSettings | null>("GET", "/users/me/settings"),
  putSettings: (blob: string, base_revision: number | null) => authed<UserSettings>("PUT", "/users/me/settings", { blob, base_revision }),
  lookup: async (email: string): Promise<UserLookupResponse | null> => {
    try {
      return await authed<UserLookupResponse>("GET", `/users/lookup?email=${q(email)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  sync: () => authed<SyncResponse>("GET", "/sync"),

  // ── Vaults ──
  createVault: (req: { id: string; name_enc: string; wrapped_vault_key: string }) => authed<Vault>("POST", "/vaults", req),
  vault: (id: string) => authed<Vault>("GET", `/vaults/${id}`),
  renameVault: (id: string, name_enc: string) => authed<Vault>("PATCH", `/vaults/${id}`, { name_enc }),
  deleteVault: (id: string) => authed<void>("DELETE", `/vaults/${id}`),
  leaveVault: (id: string) => authed<void>("POST", `/vaults/${id}/leave`),
  rotateVaultKey: (id: string, req: { name_enc: string; members: { user_id: string; wrapped_vault_key: string }[]; items: { id: string; ciphertext: string }[]; base_revision: number }) =>
    authed<Vault>("POST", `/vaults/${id}/rotate-key`, req),
  vaultAudit: (id: string, limit = 100) => authed<AuditEntry[]>("GET", `/vaults/${id}/audit?limit=${limit}`),

  // ── Membres ──
  members: (vault: string) => authed<VaultMember[]>("GET", `/vaults/${vault}/members`),
  updateMember: (vault: string, user: string, role: Role) => authed<void>("PATCH", `/vaults/${vault}/members/${user}`, { role }),
  removeMember: (vault: string, user: string) => authed<void>("DELETE", `/vaults/${vault}/members/${user}`),
  transferOwnership: (vault: string, user: string) => authed<void>("POST", `/vaults/${vault}/members/${user}/transfer`),

  // ── Invitations ──
  invite: (vault: string, req: { email: string; role: Role; wrapped_vault_key?: string }) => authed<Invitation>("POST", `/vaults/${vault}/invitations`, req),
  vaultInvitations: (vault: string) => authed<Invitation[]>("GET", `/vaults/${vault}/invitations`),
  myInvitations: () => authed<Invitation[]>("GET", "/invitations"),
  revokeInvitation: (id: string) => authed<void>("DELETE", `/invitations/${id}`),
  acceptInvitation: (id: string) => authed<Invitation>("POST", `/invitations/${id}/accept`),
  declineInvitation: (id: string) => authed<void>("POST", `/invitations/${id}/decline`),
  completeInvitation: (id: string, wrapped_vault_key: string) => authed<Invitation>("POST", `/invitations/${id}/complete`, { wrapped_vault_key }),

  // ── Items ──
  items: (vault: string, since?: number) => authed<ItemsPage>("GET", `/vaults/${vault}/items${since === undefined ? "" : `?since=${since}`}`),
  putItem: (vault: string, id: string, req: { item_type: string; ciphertext: string; base_revision?: number }) => authed<Item>("PUT", `/vaults/${vault}/items/${id}`, req),
  deleteItem: (vault: string, id: string) => authed<void>("DELETE", `/vaults/${vault}/items/${id}`),
};

/** Le flux d'événements. `EventSource` ne sait pas envoyer d'en-tête
 * `Authorization`, d'où un `fetch` en streaming et un découpage SSE à la
 * main. Se reconnecte tout seul ; `stop()` pour arrêter. */
export function subscribeEvents(onEvent: (e: ServerEvent) => void): { stop: () => void } {
  const ctrl = new AbortController();
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      try {
        if (!tokens) throw new Error("no session");
        const res = await fetch(`${BASE}/events`, { headers: { authorization: `Bearer ${tokens.access}`, accept: "text/event-stream" }, signal: ctrl.signal });
        if (res.status === 401) {
          await refreshTokens();
          continue;
        }
        if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            try {
              onEvent(JSON.parse(data) as ServerEvent);
            } catch {
              // Un événement inconnu ou mal formé : on l'ignore, le flux continue.
            }
          }
        }
      } catch {
        if (stopped) return;
      }
      // Coupure (proxy, veille…) : on attend un peu avant de se rebrancher.
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  void run();

  return {
    stop: () => {
      stopped = true;
      ctrl.abort();
    },
  };
}
