/** Connexion face à un serveur qui dicte des paramètres Argon2id trop
 * faibles au prelogin : la clé d'auth ne doit jamais partir. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { login } from "./session";

afterEach(() => vi.unstubAllGlobals());

describe("login", () => {
  it("n'envoie rien quand le prelogin impose une dérivation trop faible", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ kdf: { m_cost: 8, t_cost: 1, p_cost: 1 }, kdf_salt: "AAAAAAAAAAAAAAAAAAAAAA==" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await expect(login("alice@example.com", "pw")).rejects.toThrowError(/refusés/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/auth\/prelogin$/);
  });
});
