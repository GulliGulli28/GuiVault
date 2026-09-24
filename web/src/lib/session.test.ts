/** Connexion face à un serveur qui dicte des paramètres Argon2id trop
 * faibles au prelogin : la clé d'auth ne doit jamais partir. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "./bytes";
import * as c from "./crypto";
import { kdfWeakerThan, pinKdf, pinnedKdf } from "./kdfPins";
import { login } from "./session";

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
