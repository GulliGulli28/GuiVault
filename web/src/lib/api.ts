/** Le client HTTP de l'API, sans cryptographie — l'équivalent de
 * `core/src/guivault/client.rs` dans Guiterm. Une méthode par route ; les
 * blobs restent en base64, c'est `session.ts` qui chiffre et déchiffre. */
import type { TwoFactorSite } from "./types";
import type { AccountPasskey, AdminOverview, AdminUserInfo, AuditEntry, BackupsStatus, EmergencyGrant, EmergencyOverview, EmergencyVault, HealthResponse, ImportItemsRequest, Invitation, Item, ItemVersion, ItemsPage, KdfParams, ManifestWrite, LoginResponse, PasskeyLoginOptions, PasskeyRegistrationOptions, PreloginResponse, SecondFactorOptions, Role, SendContent, SendInfo, SendPassword, SendSummary, RegistrationInvite, ServerAttachment, ServerEvent, Session, SyncResponse, TokenPair, TotpChallenge, TrashedItem, UserLookupResponse, UserProfile, UserSettings, Vault, VaultManifest, VaultMember } from "./types";

/** Une enveloppe de clé de vault pour un contact d'urgence. */
export interface EmergencyVaultKey {
  vault_id: string;
  wrapped_vault_key: string;
}

/** Une connexion à un serveur : son API et ses jetons. Celle de la session
 * (`main`) ; un transfert vers un autre serveur en ouvre une seconde
 * (`serverConnection`, `transfer.ts`) sans toucher à la première. */
interface Connection {
  base: string;
  tokens: Tokens | null;
  pair: TokenPair | null;
  refreshing: Promise<void> | null;
  /** Le serveur a refusé le jeton et le rafraîchissement a échoué : la
   * session est morte, l'application repasse à l'écran de connexion. */
  onLost: (() => void) | null;
  /** Les jetons ont tourné (connexion, rafraîchissement) : l'extension les
   * re-persiste, l'interface embarquée n'en a pas besoin. */
  onChanged: ((t: TokenPair | null) => void) | null;
}

interface Tokens {
  access: string;
  refresh: string;
}

function connection(base: string): Connection {
  return { base, tokens: null, pair: null, refreshing: null, onLost: null, onChanged: null };
}

/** L'API : relative dans l'interface embarquée (même origine), absolue dans
 * l'extension (`setBaseUrl`). */
const main = connection("/api/v1");

function apiBase(serverUrl: string): string {
  return `${serverUrl.trim().replace(/\/+$/, "")}/api/v1`;
}

export function setBaseUrl(serverUrl: string) {
  main.base = apiBase(serverUrl);
}

export function baseUrl(): string {
  return main.base;
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

function putTokens(conn: Connection, t: TokenPair | null) {
  conn.tokens = t ? { access: t.access_token, refresh: t.refresh_token } : null;
  conn.pair = t;
  conn.onChanged?.(t);
}

export function setTokens(t: TokenPair | null) {
  putTokens(main, t);
}

export function setTokensChangedHandler(f: ((t: TokenPair | null) => void) | null) {
  main.onChanged = f;
}

export function hasSession(): boolean {
  return main.tokens !== null;
}

/** Les jetons en cours, pour qui persiste la session avec eux. */
export function currentTokens(): TokenPair | null {
  return main.pair;
}

export function setSessionLostHandler(f: (() => void) | null) {
  main.onLost = f;
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

function bearer(conn: Connection): Record<string, string> {
  return conn.tokens ? { authorization: `Bearer ${conn.tokens.access}` } : {};
}

async function rawOn<T>(conn: Connection, method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = auth ? bearer(conn) : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(conn.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return parse<T>(res);
}

/** Rafraîchit le jeton d'accès — une seule fois même si plusieurs requêtes
 * échouent en même temps (le jeton de rafraîchissement tourne à chaque usage,
 * le présenter deux fois serait pris pour un rejeu). */
async function refreshTokens(conn: Connection): Promise<void> {
  if (!conn.refreshing) {
    conn.refreshing = (async () => {
      const t = conn.tokens;
      if (!t) throw new ApiError(401, "unauthorized", "Session expirée");
      try {
        const pair = await rawOn<TokenPair>(conn, "POST", "/auth/refresh", { refresh_token: t.refresh }, false);
        putTokens(conn, pair);
      } catch (e) {
        conn.tokens = null;
        conn.pair = null;
        conn.onLost?.();
        throw e;
      } finally {
        conn.refreshing = null;
      }
    })();
  }
  return conn.refreshing;
}

async function authedOn<T>(conn: Connection, method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await rawOn<T>(conn, method, path, body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && conn.tokens) {
      await refreshTokens(conn);
      return rawOn<T>(conn, method, path, body);
    }
    throw e;
  }
}

/** Une réponse en texte (pas du JSON), authentifiée. */
async function authedTextOn(conn: Connection, path: string): Promise<string> {
  const get = () => fetch(conn.base + path, { headers: bearer(conn) });
  let res = await get();
  if (res.status === 401 && conn.tokens) {
    await refreshTokens(conn);
    res = await get();
  }
  if (!res.ok) await parse(res);
  return res.text();
}

/** Des octets bruts (morceaux de pièces jointes), dans un sens ou l'autre. */
async function authedBytesOn(conn: Connection, method: string, path: string, body?: Uint8Array): Promise<Uint8Array> {
  const send = () => fetch(conn.base + path, {
    method,
    headers: { ...bearer(conn), ...(body ? { "content-type": "application/octet-stream" } : {}) },
    body: body as BodyInit | undefined,
  });
  let res = await send();
  if (res.status === 401 && conn.tokens) {
    await refreshTokens(conn);
    res = await send();
  }
  if (!res.ok) await parse(res);
  return new Uint8Array(await res.arrayBuffer());
}

const q = (s: string) => encodeURIComponent(s);

/** Le transport HTTP d'une connexion : une méthode par route du serveur. */
function httpTransport(conn: Connection) {
  const raw = <T,>(method: string, path: string, body?: unknown, auth = true) => rawOn<T>(conn, method, path, body, auth);
  const authed = <T,>(method: string, path: string, body?: unknown) => authedOn<T>(conn, method, path, body);
  const authedText = (path: string) => authedTextOn(conn, path);
  const authedBytes = (method: string, path: string, body?: Uint8Array) => authedBytesOn(conn, method, path, body);
  return {
    health: () => raw<HealthResponse>("GET", "/health", undefined, false),

    // ── Authentification ──
    prelogin: (email: string) => raw<PreloginResponse>("POST", "/auth/prelogin", { email }, false),

    // ── Passkeys du compte (`lib/accountPasskeys.ts`) ──
    passkeys: () => authed<AccountPasskey[]>("GET", "/auth/passkeys"),
    passkeyRegisterStart: () => authed<PasskeyRegistrationOptions>("POST", "/auth/passkeys/register/start"),
    registerPasskey: (req: { challenge_id: string; auth_key: string; name: string; credential_id: string; client_data_json: string; attestation_object: string; protected_user_key?: string }) =>
      authed<AccountPasskey>("POST", "/auth/passkeys", req),
    deletePasskey: (id: string) => authed<void>("DELETE", `/auth/passkeys/${id}`),
    passkeyLoginStart: () => raw<PasskeyLoginOptions>("POST", "/auth/passkeys/login/start", undefined, false),
    passkeyLogin: (req: { challenge_id: string; credential_id: string; client_data_json: string; authenticator_data: string; signature: string; device_name: string }) =>
      raw<LoginResponse & { passkey_user_key: string }>("POST", "/auth/passkeys/login", req, false),
    register: (req: {
      email: string; kdf: KdfParams; kdf_salt: string; auth_key: string; protected_user_key: string; public_key: string;
      protected_private_key: string; personal_vault: { id: string; name_enc: string; wrapped_vault_key: string }; device_name?: string;
    }) => raw<LoginResponse>("POST", "/auth/register", req, false),
    login: async (email: string, auth_key: string, device_name: string): Promise<{ kind: "ok"; login: LoginResponse } | { kind: "totp"; challenge: TotpChallenge }> => {
      const res = await fetch(`${conn.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, auth_key, device_name }) });
      if (res.status === 202) return { kind: "totp", challenge: await parse<TotpChallenge>(res) };
      return { kind: "ok", login: await parse<LoginResponse>(res) };
    },
    totpVerify: (totp_token: string, code: string) => raw<LoginResponse>("POST", "/auth/totp/verify", { totp_token, code }, false),
    travelStatus: () => authed<{ enabled: boolean }>("GET", "/users/me/travel"),
    setTravel: (enabled: boolean, auth_key?: string) => authed<{ enabled: boolean }>("PUT", "/users/me/travel", { enabled, auth_key }),
    setVaultTravel: (vault: string, safe: boolean) => authed<Vault>("PUT", `/vaults/${vault}/travel`, { safe }),
    secondFactorStart: (totp_token: string) => raw<SecondFactorOptions>("POST", "/auth/2fa/webauthn/start", { totp_token }, false),
    secondFactorWebauthn: (req: { totp_token: string; challenge_id: string; credential_id: string; client_data_json: string; authenticator_data: string; signature: string }) =>
      raw<LoginResponse>("POST", "/auth/2fa/webauthn", req, false),
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
    /** Supprime le compte (mot de passe maître prouvé, code du second facteur
     * s'il est actif) ; `409 owns_shared_vaults` avec `vaults` sinon. */
    deleteAccount: (auth_key: string, totp_code?: string) => authed<void>("DELETE", "/users/me", { auth_key, totp_code }),
    adminOverview: () => authed<AdminOverview>("GET", "/admin/overview"),
    adminUsers: () => authed<AdminUserInfo[]>("GET", "/admin/users"),
    adminDisable: (id: string) => authed<AdminUserInfo>("POST", `/admin/users/${id}/disable`),
    adminEnable: (id: string) => authed<AdminUserInfo>("POST", `/admin/users/${id}/enable`),
    adminSetQuota: (id: string, quota_bytes: number | null) => authed<AdminUserInfo>("PUT", `/admin/users/${id}/quota`, { quota_bytes }),
    adminDeleteUser: (id: string) => authed<void>("DELETE", `/admin/users/${id}`),
    adminRegistrations: () => authed<RegistrationInvite[]>("GET", "/admin/registrations"),
    adminOpenRegistration: (email: string, days?: number) => authed<RegistrationInvite>("POST", "/admin/registrations", { email, days }),
    adminCloseRegistration: (email: string) => authed<void>("DELETE", `/admin/registrations/${q(email)}`),
    adminBackups: () => authed<BackupsStatus>("GET", "/admin/backups"),
    adminBackupNow: () => authed<void>("POST", "/admin/backups"),
    adminMailTest: () => authed<void>("POST", "/admin/mail-test"),
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
    rotateVaultKey: (id: string, req: { name_enc: string; members: { user_id: string; wrapped_vault_key: string }[]; items: { id: string; ciphertext: string }[]; versions: { item_id: string; revision: number; ciphertext: string }[]; emergency?: { grant_id: string; wrapped_vault_key: string }[]; manifest?: string; base_revision: number }) =>
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
    putItem: (vault: string, id: string, req: { item_type: string; ciphertext: string; base_revision?: number; manifest?: ManifestWrite }) => authed<Item>("PUT", `/vaults/${vault}/items/${id}`, req),
    /** `moved` : l'item part vers un autre vault, pas dans la corbeille. */
    deleteItem: (vault: string, id: string, opts: { moved?: boolean; manifest?: ManifestWrite } = {}) =>
      authed<void>("DELETE", `/vaults/${vault}/items/${id}${opts.moved ? "?moved=true" : ""}`, opts.manifest ? { manifest: opts.manifest } : undefined),
    manifest: (vault: string) => authed<VaultManifest | null>("GET", `/vaults/${vault}/manifest`),
    // ── Pièces jointes (`lib/attachments.ts`) ──
    attachments: (vault: string, itemId?: string) => authed<ServerAttachment[]>("GET", `/vaults/${vault}/attachments${itemId ? `?item_id=${q(itemId)}` : ""}`),
    createAttachment: (vault: string, req: { id: string; item_id: string; size: number; chunks: number }) => authed<ServerAttachment>("POST", `/vaults/${vault}/attachments`, req),
    putAttachmentChunk: (vault: string, id: string, index: number, bytes: Uint8Array) => authedBytes("PUT", `/vaults/${vault}/attachments/${id}/chunks/${index}`, bytes),
    completeAttachment: (vault: string, id: string) => authed<ServerAttachment>("POST", `/vaults/${vault}/attachments/${id}/complete`),
    attachmentChunk: (vault: string, id: string, index: number) => authedBytes("GET", `/vaults/${vault}/attachments/${id}/chunks/${index}`),
    emergencyAttachmentChunk: (grant: string, vault: string, id: string, index: number) => authedBytes("GET", `/emergency/${grant}/vaults/${vault}/attachments/${id}/chunks/${index}`),
    deleteAttachment: (vault: string, id: string) => authed<void>("DELETE", `/vaults/${vault}/attachments/${id}`),
    moveAttachment: (vault: string, id: string, req: { vault_id: string; item_id: string }) => authed<ServerAttachment>("POST", `/vaults/${vault}/attachments/${id}/move`, req),
    putManifest: (vault: string, req: { ciphertext: string; base_revision: number; vault_revision: number }) => authed<VaultManifest>("PUT", `/vaults/${vault}/manifest`, req),
    importItems: (vault: string, req: ImportItemsRequest) => authed<{ revision: number; imported: number }>("POST", `/vaults/${vault}/import`, req),
    itemVersions: (vault: string, id: string) => authed<ItemVersion[]>("GET", `/vaults/${vault}/items/${id}/versions`),
    vaultVersions: (vault: string) => authed<ItemVersion[]>("GET", `/vaults/${vault}/versions`),
    trash: (vault: string) => authed<TrashedItem[]>("GET", `/vaults/${vault}/trash`),
    purgeTrashItem: (vault: string, id: string) => authed<void>("DELETE", `/vaults/${vault}/trash/${id}`),
    emptyTrash: (vault: string) => authed<void>("DELETE", `/vaults/${vault}/trash`),

    // ── Liens de partage ──
    sends: () => authed<SendSummary[]>("GET", "/sends"),
    createSend: (req: { id: string; ciphertext: string; access_hash: string; owner_blob: string; password?: SendPassword; max_views?: number; expires_in_secs: number; file?: { size: number; chunks: number } }) =>
      authed<SendSummary>("POST", "/sends", req),
    putSendChunk: (id: string, index: number, bytes: Uint8Array) => authedBytes("PUT", `/sends/${id}/file/${index}`, bytes),
    completeSend: (id: string) => authed<SendSummary>("POST", `/sends/${id}/complete`),
    deleteSend: (id: string) => authed<void>("DELETE", `/sends/${id}`),
    /** Sans compte : ce que le destinataire d'un lien appelle. */
    sendInfo: (id: string) => raw<SendInfo>("GET", `/sends/${id}/access`, undefined, false),
    openSend: (id: string, access_key: string) => raw<SendContent>("POST", `/sends/${id}/access`, { access_key }, false),
    /** Un morceau du fichier d'un lien, contre le jeton de son ouverture. */
    sendFileChunk: async (id: string, index: number, token: string): Promise<Uint8Array> => {
      const res = await fetch(`${conn.base}/sends/${id}/file/${index}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      if (!res.ok) await parse(res);
      return new Uint8Array(await res.arrayBuffer());
    },

    // ── Rapport de santé (relais du serveur) ──
    /** Les suffixes HIBP sous un préfixe de 5 caractères du SHA-1. */
    pwnedRange: (prefix: string) => authedText(`/lookups/pwned-passwords/${prefix}`),
    twoFactorDirectory: () => authed<TwoFactorSite[]>("GET", "/lookups/2fa-directory"),

    // ── Accès d'urgence ──
    emergency: () => authed<EmergencyOverview>("GET", "/emergency"),
    createEmergency: (req: { grantee_id: string; wait_days: number; vaults: EmergencyVaultKey[] }) => authed<EmergencyGrant>("POST", "/emergency", req),
    updateEmergency: (id: string, req: { wait_days?: number; vaults?: EmergencyVaultKey[] }) => authed<EmergencyGrant>("PATCH", `/emergency/${id}`, req),
    deleteEmergency: (id: string) => authed<void>("DELETE", `/emergency/${id}`),
    emergencyAction: (id: string, action: "accept" | "request" | "approve" | "reject") => authed<EmergencyGrant>("POST", `/emergency/${id}/${action}`),
    emergencyVaults: (id: string) => authed<EmergencyVault[]>("GET", `/emergency/${id}/vaults`),
    emergencyItems: (id: string, vault: string) => authed<ItemsPage>("GET", `/emergency/${id}/vaults/${vault}/items`),
  };
}

const httpApi = httpTransport(main);

/** Ce qu'offre un transport : les méthodes du transport HTTP. Le coffre
 * local de l'app (`localHost.ts`) n'en implémente qu'une partie. */
export type Transport = ReturnType<typeof httpTransport>;
export type TransportMethod = keyof Transport;

let active: Partial<Transport> = httpApi;

/** Change de transport : celui qu'on donne (le coffre local de l'app), ou
 * `null` pour revenir au serveur. */
export function setTransport(t: Partial<Transport> | null) {
  active = t ?? httpApi;
}

/** Le transport actif sait-il faire ça ? L'interface s'en sert pour ne pas
 * proposer ce qu'un coffre local n'a pas (partage, liens, sessions…). */
export function supports(method: TransportMethod): boolean {
  return typeof active[method] === "function";
}

/** Le serveur, plutôt qu'un coffre local. */
export function isHttpTransport(): boolean {
  return active === httpApi;
}

/** Une seconde connexion, à `serverUrl`, avec ses propres jetons : la
 * cible d'un transfert (`transfer.ts`). La session en cours n'en voit rien. */
export function serverConnection(serverUrl: string): { api: Transport; setTokens: (t: TokenPair | null) => void } {
  const conn = connection(apiBase(serverUrl));
  return { api: httpTransport(conn), setTokens: (t) => putTokens(conn, t) };
}

/** L'API : délègue chaque appel au transport actif. Une méthode qu'il n'a
 * pas répond `501 local_unsupported` — les 29 modules qui importent `api`
 * n'ont pas à savoir d'où viennent les données. */
export const api = Object.fromEntries(
  (Object.keys(httpApi) as TransportMethod[]).map((name) => [
    name,
    (...args: unknown[]) => {
      const f = active[name] as ((...a: unknown[]) => unknown) | undefined;
      if (!f) return Promise.reject(new ApiError(501, "local_unsupported", "Pas disponible dans un coffre local."));
      return f(...args);
    },
  ]),
) as Transport;

/** Le flux d'événements. `EventSource` ne sait pas envoyer d'en-tête
 * `Authorization`, d'où un `fetch` en streaming et un découpage SSE à la
 * main. Se reconnecte tout seul ; `stop()` pour arrêter. */
export function subscribeEvents(onEvent: (e: ServerEvent) => void): { stop: () => void } {
  // Un coffre local n'a qu'un écrivain à la fois dans cette fenêtre : rien à
  // écouter.
  if (!isHttpTransport()) return { stop: () => {} };
  const ctrl = new AbortController();
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      try {
        if (!main.tokens) throw new Error("no session");
        const res = await fetch(`${main.base}/events`, { headers: { ...bearer(main), accept: "text/event-stream" }, signal: ctrl.signal });
        if (res.status === 401) {
          await refreshTokens(main);
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
