import { describe, expect, it } from "vitest";
import { canLink, linkState, linkedItems, withAccount, withoutAccount } from "./accounts";
import type { DecodedItem } from "./session";
import type { Account, Payload } from "./types";

const ldap: Account = { id: "a1", name: "LDAP", groupId: null, tags: [], username: "jdupont", password: "s3cret", passwordHistory: [] };
const login = (extra: Record<string, unknown> = {}): Payload =>
  ({ kind: "login", login: { id: "l1", name: "Wiki", groupId: null, tags: [], username: "", password: "", uris: [], totp: null, passkeys: [], passwordHistory: [], ...extra } }) as unknown as Payload;
const host = (auth: unknown = "password", extra: Record<string, unknown> = {}): Payload =>
  ({ kind: "host", host: { id: "h1", label: "srv", address: "srv", port: 22, username: "root", auth, groupId: null, jumpVia: [], tags: [], startupSnippets: [], envVars: [], source: "ssh-config", ...extra }, secrets: { env: { TOKEN: "t" } } }) as unknown as Payload;

describe("comptes enregistrés", () => {
  it("un identifiant prend la copie du compte, et rien à écrire s'il l'a déjà", () => {
    const p = withAccount(login(), ldap);
    expect(p?.kind === "login" && [p.login.accountId, p.login.username, p.login.password]).toEqual(["a1", "jdupont", "s3cret"]);
    expect(withAccount(p!, ldap)).toBeNull();
    expect(withAccount(p!, { ...ldap, password: "n0uveau" })).not.toBeNull();
  });

  it("un compte protégé protège ce qui le reprend", () => {
    const p = withAccount(login(), { ...ldap, reprompt: true });
    expect(p?.kind === "login" && p.login.reprompt).toBe(true);
    // L'inverse ne retire rien : la protection de l'identifiant reste la sienne.
    const q = withAccount(login({ reprompt: true }), ldap);
    expect(q?.kind === "login" && q.login.reprompt).toBe(true);
  });

  it("un hôte : l'utilisateur, le mot de passe s'il s'en sert, le reste intact", () => {
    const p = withAccount(host(), ldap);
    expect(p?.kind === "host" && [p.host.username, p.secrets?.password, p.secrets?.env, p.host.source]).toEqual(["jdupont", "s3cret", { TOKEN: "t" }, "ssh-config"]);
    const agent = withAccount(host("agent"), ldap);
    expect(agent?.kind === "host" && [agent.host.username, agent.secrets?.password]).toEqual(["jdupont", undefined]);
    expect(canLink(host())).toBe(true);
    expect(canLink(host("password", { kind: "k8sExec" }))).toBe(false);
  });

  it("détacher garde la dernière copie", () => {
    const p = withoutAccount(withAccount(login(), ldap)!);
    expect(p.kind === "login" && ["accountId" in p.login, p.login.username, p.login.password]).toEqual([false, "jdupont", "s3cret"]);
  });

  it("état du lien : à jour, en retard, compte disparu", () => {
    const p = withAccount(login(), ldap)!;
    expect(linkState(login(), [ldap])).toEqual({ kind: "none" });
    expect(linkState(p, [ldap])).toEqual({ kind: "linked", account: ldap, stale: false });
    expect(linkState(p, new Map([["a1", { ...ldap, password: "autre" }]]))).toMatchObject({ kind: "linked", stale: true });
    expect(linkState(p, [])).toEqual({ kind: "missing" });
    const items = [p, login(), withAccount(host(), ldap)!].map((payload, i) => ({ id: `i${i}`, revision: 1, ok: true, payload }) as DecodedItem);
    expect(linkedItems(items, "a1").map((i) => i.id)).toEqual(["i0", "i2"]);
  });
});
