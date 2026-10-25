import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "./bytes";
import * as c from "./crypto";
import { forgetUnlocked, isProtected, markUnlocked, needsReprompt, REPROMPT_GRACE_MS, verifyMasterPassword } from "./reprompt";
import type { SessionState } from "./session";
import type { Payload } from "./types";

const login = (id: string, reprompt?: boolean): Payload => ({ kind: "login", login: { id, name: id, groupId: null, tags: [], username: "u", password: "p", uris: [], totp: null, passkeys: [], passwordHistory: [], reprompt } });

describe("reprompt", () => {
  afterEach(() => {
    forgetUnlocked();
    vi.useRealTimers();
  });

  it("ne protège que ce qui le demande, et le temps de la grâce", () => {
    vi.useFakeTimers();
    expect(isProtected(login("a"))).toBe(false);
    expect(needsReprompt(login("a"))).toBe(false);
    expect(needsReprompt(login("b", true))).toBe(true);
    markUnlocked("b");
    expect(needsReprompt(login("b", true))).toBe(false);
    // Un autre élément protégé n'en profite pas.
    expect(needsReprompt(login("c", true))).toBe(true);
    vi.advanceTimersByTime(REPROMPT_GRACE_MS + 1);
    expect(needsReprompt(login("b", true))).toBe(true);
    markUnlocked("b");
    forgetUnlocked();
    expect(needsReprompt(login("b", true))).toBe(true);
    expect(isProtected({ kind: "group", group: { id: "g", name: "G", parentId: null } })).toBe(false);
  });

  it("vérifie le mot de passe maître contre le compte de la session, sans serveur", async () => {
    const { material, account } = await c.createAccount("bon mot de passe");
    const blobs = { kdf: material.kdf, kdf_salt: toBase64(material.kdfSalt), protected_user_key: toBase64(material.protectedUserKey), protected_private_key: toBase64(material.protectedPrivateKey) };
    const state = { account, blobs } as unknown as SessionState;
    expect(await verifyMasterPassword(state, "bon mot de passe")).toBe("ok");
    expect(await verifyMasterPassword(state, "mauvais")).toBe("wrong");
    // Le compte enveloppé d'un autre : pas la même user key.
    const other = await c.createAccount("bon mot de passe");
    expect(await verifyMasterPassword({ account: other.account, blobs } as unknown as SessionState, "bon mot de passe")).toBe("wrong");
    // Session ouverte par passkey : rien pour vérifier.
    expect(await verifyMasterPassword({ account } as unknown as SessionState, "bon mot de passe")).toBe("unavailable");
  }, 60_000);
});
