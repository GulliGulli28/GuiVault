/** Connexion face à un serveur qui dicte des paramètres Argon2id trop
 * faibles au prelogin : la clé d'auth ne doit jamais partir. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "./bytes";
import * as c from "./crypto";
import { kdfWeakerThan, pinKdf, pinnedKdf } from "./kdfPins";
import { acceptRollback, invitationKeyFrom, login, refresh, type SessionState } from "./session";
import { observeRevisions } from "./vaultRevisions";

/** Un `localStorage` en mémoire (Node n'en a pas) et un `navigator` pour
 * le nom d'appareil. */
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("navigator", { userAgent: "vitest" });
});
afterEach(() => vi.unstubAllGlobals());

/** Un faux serveur : `routes` associe la fin de l'URL à la réponse JSON
 * (200), ou à `[statut, corps]`. */
function fakeServer(routes: Record<string, unknown>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const route = Object.keys(routes).find((r) => url.endsWith(r));
    const [status, body] = !route ? [404, { code: "not_found", message: url }] : Array.isArray(routes[route]) ? (routes[route] as [number, unknown]) : [200, routes[route]];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const SALT = "AAAAAAAAAAAAAAAAAAAAAA==";

describe("login", () => {
  it("n'envoie rien quand le prelogin impose une dérivation hors bornes", async () => {
    const calls = fakeServer({ "/auth/prelogin": { kdf: { m_cost: 8, t_cost: 1, p_cost: 1 }, kdf_salt: SALT } });
    await expect(login("alice@example.com", "pw")).rejects.toThrowError(/refusés/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/auth\/prelogin$/);
  });

  it("épingle les paramètres d'une connexion réussie et refuse ensuite qu'ils baissent", async () => {
    const { material } = await c.createAccount("pw");
    const user = { id: "u-1", email: "alice@example.com", public_key: toBase64(material.publicKey), created_at: "2026-01-01T00:00:00Z" };
    fakeServer({
      "/auth/prelogin": { kdf: material.kdf, kdf_salt: toBase64(material.kdfSalt) },
      "/auth/login": {
        access_token: "a",
        refresh_token: "r",
        access_expires_in: 900,
        user,
        protected_user_key: toBase64(material.protectedUserKey),
        protected_private_key: toBase64(material.protectedPrivateKey),
      },
      "/sync": { user, vaults: [], invitations: [], server_time: "2026-01-01T00:00:00Z" },
    });
    const out = await login("Alice@Example.com", "pw");
    expect(out.kind).toBe("ok");
    expect(pinnedKdf("alice@example.com")).toEqual(material.kdf);

    // Le même serveur, compromis depuis : dans les bornes, mais plus faible.
    const calls = fakeServer({ "/auth/prelogin": { kdf: { m_cost: 19_456, t_cost: 2, p_cost: 1 }, kdf_salt: SALT } });
    await expect(login("alice@example.com", "pw")).rejects.toThrowError(/plus faible/);
    expect(calls).toHaveLength(1);
  }, 60_000);

  it("n'épingle rien quand le mot de passe est faux", async () => {
    fakeServer({
      "/auth/prelogin": { kdf: c.DEFAULT_KDF, kdf_salt: SALT },
      "/auth/login": [401, { code: "invalid_credentials", message: "Identifiants invalides" }],
    });
    await expect(login("bob@example.com", "pw")).rejects.toThrowError(/Identifiants invalides/);
    expect(pinnedKdf("bob@example.com")).toBeNull();
  }, 60_000);
});

describe("kdfPins", () => {
  it("compare comme `KdfParams::weaker_than`", () => {
    const pinned = c.DEFAULT_KDF;
    expect(kdfWeakerThan(pinned, pinned)).toBe(false);
    expect(kdfWeakerThan({ m_cost: 19_456, t_cost: 2, p_cost: 1 }, pinned)).toBe(true);
    expect(kdfWeakerThan({ ...pinned, t_cost: 2 }, pinned)).toBe(true);
    expect(kdfWeakerThan({ ...pinned, p_cost: 4 }, pinned)).toBe(false);
    expect(kdfWeakerThan(pinned, { m_cost: 19_456, t_cost: 2, p_cost: 1 })).toBe(false);
  });

  it("sépare les comptes et ignore la casse de l'e-mail", () => {
    pinKdf("Alice@Example.com", c.DEFAULT_KDF);
    expect(pinnedKdf("alice@example.com")).toEqual(c.DEFAULT_KDF);
    expect(pinnedKdf("bob@example.com")).toBeNull();
  });
});

describe("retour en arrière d'un vault", () => {
  it("alerte quand /sync annonce une révision plus basse que celle déjà vue, jusqu'à ce qu'on en prenne acte", async () => {
    const { material, account } = await c.createAccount("pw");
    const user = { id: "u-rb", email: "carol@example.com", public_key: toBase64(material.publicKey), created_at: "2026-01-01T00:00:00Z" };
    const vaultKey = new Uint8Array(32).fill(9);
    const vault = (revision: number) => ({
      id: "v-1",
      kind: "personal",
      name_enc: toBase64(c.sealVaultName(vaultKey, "v-1", "Personnel")),
      role: "owner",
      wrapped_vault_key: toBase64(c.wrapVaultKey(account.keypair, material.publicKey, "v-1", vaultKey)),
      revision,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const serve = (revision: number) => ({ user, vaults: [vault(revision)], invitations: [], server_time: "2026-01-01T00:00:00Z" });
    fakeServer({
      "/auth/prelogin": { kdf: material.kdf, kdf_salt: toBase64(material.kdfSalt) },
      "/auth/login": {
        access_token: "a",
        refresh_token: "r",
        access_expires_in: 900,
        user,
        protected_user_key: toBase64(material.protectedUserKey),
        protected_private_key: toBase64(material.protectedPrivateKey),
      },
      "/sync": serve(42),
    });
    const out = await login(user.email, "pw");
    if (out.kind !== "ok") throw new Error("connexion attendue");
    const state: SessionState = out.session;
    expect(state.rollbacks).toEqual([]);

    // La base a été restaurée (ou le serveur ment) : 42 → 37.
    fakeServer({ "/sync": serve(37) });
    await refresh(state);
    expect(state.rollbacks).toEqual([{ vaultId: "v-1", name: "Personnel", known: 42, seen: 37 }]);
    // Toujours là au /sync suivant : rien n'a changé la référence.
    await refresh(state);
    expect(state.rollbacks).toHaveLength(1);

    // Pris acte : 37 devient la référence, et le vault repart de là.
    acceptRollback(state, "v-1");
    expect(state.rollbacks).toEqual([]);
    await refresh(state);
    expect(state.rollbacks).toEqual([]);
    fakeServer({ "/sync": serve(38) });
    await refresh(state);
    expect(state.rollbacks).toEqual([]);
    fakeServer({ "/sync": serve(37) });
    await refresh(state);
    expect(state.rollbacks).toEqual([{ vaultId: "v-1", name: "Personnel", known: 38, seen: 37 }]);
  }, 60_000);

  it("sépare les comptes et les vaults", () => {
    expect(observeRevisions("u-a", [{ id: "v-1", name: "A", revision: 10 }])).toEqual([]);
    // Un autre compte (ou un autre vault) n'a rien vu : pas d'alerte.
    expect(observeRevisions("u-b", [{ id: "v-1", name: "A", revision: 3 }])).toEqual([]);
    expect(observeRevisions("u-a", [{ id: "v-2", name: "B", revision: 1 }])).toEqual([]);
    expect(observeRevisions("u-a", [{ id: "v-1", name: "A", revision: 9 }])).toEqual([{ vaultId: "v-1", name: "A", known: 10, seen: 9 }]);
  });
});

describe("provenance de la clé d'un vault", () => {
  it("dit qui a remis chaque clé : soi-même, un membre (son empreinte), ou personne (ancien format)", async () => {
    const { material, account } = await c.createAccount("pw");
    const user = { id: "u-kf", email: "dan@example.com", public_key: toBase64(material.publicKey), created_at: "2026-01-01T00:00:00Z" };
    const teammate = c.generateKeyPair();
    const vault = (id: string, wrapped: Uint8Array, key: Uint8Array) => ({
      id,
      kind: "shared",
      name_enc: toBase64(c.sealVaultName(key, id, id)),
      role: "writer",
      wrapped_vault_key: toBase64(wrapped),
      revision: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const k = new Uint8Array(32).fill(4);
    fakeServer({
      "/auth/prelogin": { kdf: material.kdf, kdf_salt: toBase64(material.kdfSalt) },
      "/auth/login": {
        access_token: "a",
        refresh_token: "r",
        access_expires_in: 900,
        user,
        protected_user_key: toBase64(material.protectedUserKey),
        protected_private_key: toBase64(material.protectedPrivateKey),
      },
      "/sync": {
        user,
        vaults: [
          vault("v-mine", c.wrapVaultKey(account.keypair, material.publicKey, "v-mine", k), k),
          vault("v-team", c.wrapVaultKey(teammate, material.publicKey, "v-team", k), k),
          vault("v-old", c.sealFor(material.publicKey, k), k),
          // Une enveloppe de v-team reposée par le serveur sur un autre vault.
          vault("v-moved", c.wrapVaultKey(teammate, material.publicKey, "v-team", k), k),
        ],
        invitations: [],
        server_time: "2026-01-01T00:00:00Z",
      },
    });
    const out = await login(user.email, "pw");
    if (out.kind !== "ok") throw new Error("connexion attendue");
    const from = Object.fromEntries(out.session.vaults.map((v) => [v.id, v.keyFrom]));
    expect(from["v-mine"]).toEqual({ kind: "self" });
    expect(from["v-team"]).toEqual({ kind: "member", fingerprint: c.fingerprint(teammate.publicKey) });
    expect(from["v-old"]).toEqual({ kind: "anonymous" });
    // Liée à son vault : reposée ailleurs, elle ne s'ouvre pas — le vault est écarté.
    expect(from["v-moved"]).toBeUndefined();
  }, 60_000);
});

describe("enveloppe jointe à une invitation", () => {
  it("dit qui remet la clé avant d'accepter, et refuse une enveloppe d'un autre vault", () => {
    const me = c.generateKeyPair();
    const alice = c.generateKeyPair();
    const state = { account: { userKey: new Uint8Array(32), keypair: me }, fingerprint: c.fingerprint(me.publicKey) } as unknown as SessionState;
    const k = new Uint8Array(32).fill(8);
    const inv = (wrapped: Uint8Array | null) => ({
      id: "i-1", vault_id: "v-1", inviter_email: "alice@example.com", invitee_email: "me@example.com", invitee_public_key: null,
      invitee_fingerprint: null, role: "reader" as const, status: "pending" as const, has_key: wrapped !== null,
      wrapped_vault_key: wrapped && toBase64(wrapped), created_at: "", expires_at: "",
    });
    expect(invitationKeyFrom(state, inv(c.wrapVaultKey(alice, me.publicKey, "v-1", k)))).toEqual({ kind: "member", fingerprint: c.fingerprint(alice.publicKey) });
    expect(invitationKeyFrom(state, inv(c.sealFor(me.publicKey, k)))).toEqual({ kind: "anonymous" });
    // Le serveur joint l'enveloppe d'un autre vault : elle ne s'ouvre pas.
    expect(invitationKeyFrom(state, inv(c.wrapVaultKey(alice, me.publicKey, "v-2", k)))).toEqual({ kind: "unreadable" });
    expect(invitationKeyFrom(state, inv(null))).toBeNull();
  });
});
