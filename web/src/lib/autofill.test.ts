import { describe, expect, it } from "vitest";
import { buildAutofillIndex } from "./autofill";
import type { VaultItem } from "./allItems";
import type { SessionState, VaultView } from "./session";

const vault = { id: "v1", name: "Personnel" } as VaultView;
const at = "2026-10-24T00:00:00Z";

function login(id: string, fields: Record<string, unknown>): VaultItem {
  const base = { id, name: id, groupId: null, tags: [], username: "", password: "", uris: [], totp: null, passkeys: [], passwordHistory: [] };
  return { vault, item: { id, revision: 1, updatedAt: at, ok: true, payload: { kind: "login", login: { ...base, ...fields } } } } as unknown as VaultItem;
}

describe("buildAutofillIndex", () => {
  const session = { user: { email: "moi@exemple.fr" } } as unknown as SessionState;

  it("garde les identifiants, sans les adresses « jamais »", () => {
    const index = buildAutofillIndex(session, [
      login("github", { username: "moi", password: "s3cret", uris: [{ uri: " https://github.com ", match: null }, { uri: "https://gist.github.com", match: "never" }, { uri: "androidapp://com.github.android" }] }),
    ]);
    expect(index.label).toBe("moi@exemple.fr");
    expect(index.entries).toEqual([
      { id: "github", name: "github", vault: "Personnel", username: "moi", password: "s3cret", uris: [{ uri: "https://github.com", match: null }, { uri: "androidapp://com.github.android", match: null }] },
    ]);
  });

  it("laisse les autres secrets et les identifiants vides", () => {
    const note = { vault, item: { id: "n", revision: 1, updatedAt: at, ok: true, payload: { kind: "note", note: { id: "n", name: "Note" } } } } as unknown as VaultItem;
    const index = buildAutofillIndex(session, [note, login("vide", {})]);
    expect(index.entries).toEqual([]);
  });

  it("ne confie rien d'un identifiant protégé (reprompt)", () => {
    const index = buildAutofillIndex(session, [login("banque", { username: "moi", password: "p", reprompt: true }), login("forum", { username: "moi", password: "p" })]);
    expect(index.entries.map((e) => e.id)).toEqual(["forum"]);
  });

  it("nomme un coffre local par son dossier", () => {
    const local = { user: { email: "local" }, local: { path: "/data/coffres/Mon coffre.guivault" } } as unknown as SessionState;
    expect(buildAutofillIndex(local, []).label).toBe("Mon coffre");
  });

  it("confie le TOTP normalisé, pour le copier après avoir rempli", () => {
    const index = buildAutofillIndex(session, [
      login("a", { username: "moi", password: "p", totp: "otpauth://totp/X:moi?secret=jbswy3dpehpk3pxp&algorithm=SHA256&digits=8&period=60" }),
      login("b", { username: "moi", password: "p", totp: "JBSW Y3DP EHPK 3PXP" }),
      login("c", { username: "moi", password: "p", totp: "0189" }),
    ]);
    expect(index.entries.map((e) => e.totp)).toEqual([
      { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA256", digits: 8, period: 60 },
      { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 },
      undefined,
    ]);
  });
});
