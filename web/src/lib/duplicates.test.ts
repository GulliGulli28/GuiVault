import { describe, expect, it } from "vitest";
import { copiesFor, duplicateOf, findDuplicates, mergeLogins } from "./duplicates";
import type { HealthEntry } from "./health";
import { emptyCard, emptyLogin } from "./items";
import type { Login, Payload } from "./types";

const vault = { id: "v1", name: "Perso", role: "owner" as const };
const entry = (payload: Payload, v = vault): HealthEntry => ({ vault: v, item: { id: (payload.kind === "login" ? payload.login.id : payload.kind === "card" ? payload.card.id : "x"), revision: 1, updatedAt: "2026-01-01T00:00:00Z", ok: true, payload } }) as HealthEntry;
const login = (id: string, l: Partial<Login>): Payload => ({ kind: "login", login: { ...emptyLogin(), id, name: id, ...l } });

describe("doublons", () => {
  it("même site et même utilisateur, sans casse ni sous-domaine ; vault par vault", () => {
    const a = entry(login("a", { username: "Alice", uris: [{ uri: "https://www.github.com/login", match: null }] }));
    const b = entry(login("b", { username: "alice", uris: [{ uri: "github.com", match: null }] }));
    const c = entry(login("c", { username: "bob", uris: [{ uri: "https://github.com", match: null }] }));
    const d = entry(login("d", { username: "alice", uris: [{ uri: "https://gitlab.com", match: null }] }));
    const elsewhere = entry(login("e", { username: "alice", uris: [{ uri: "https://github.com", match: null }] }), { id: "v2", name: "Équipe", role: "owner" });
    const groups = findDuplicates([a, b, c, d, elsewhere]);
    expect(groups.map((g) => g.map((e) => e.item.id))).toEqual([["a", "b"]]);
  });

  it("sans utilisateur, le mot de passe ; une adresse commune suffit ; les cartes par numéro", () => {
    const a = entry(login("a", { password: "p1", uris: [{ uri: "https://box.local", match: null }] }));
    const b = entry(login("b", { password: "p1", uris: [{ uri: "https://router.example", match: null }, { uri: "box.local", match: null }] }));
    const c = entry(login("c", { password: "p2", uris: [{ uri: "https://box.local", match: null }] }));
    const k1 = entry({ kind: "card", card: { ...emptyCard(), id: "k1", name: "Visa", number: "4111 1111 1111 1111" } });
    const k2 = entry({ kind: "card", card: { ...emptyCard(), id: "k2", name: "Visa pro", number: "4111-1111-1111-1111" } });
    const groups = findDuplicates([a, b, c, k1, k2]).map((g) => g.map((e) => e.item.id).sort());
    expect(groups).toEqual([["a", "b"], ["k1", "k2"]]);
  });

  it("la fusion ne perd rien", () => {
    const keep = (login("k", { username: "alice", password: "neuf", uris: [{ uri: "https://a.io", match: null }], tags: ["perso"], notes: "garder", passwordHistory: [{ password: "vieux", changedAt: "2025-01-01T00:00:00Z" }], attachments: [{ id: "f1", name: "a.pdf", size: 1, key: "k" }] }) as { kind: "login"; login: Login }).login;
    const drop = (login("d", { username: "alice", password: "ancien", uris: [{ uri: "https://a.io", match: null }, { uri: "https://app.a.io", match: null }], totp: "SECRET", tags: ["perso", "travail"], notes: "aussi", favorite: true, reprompt: true, fields: [{ name: "PIN", value: "1", type: "hidden" }], attachments: [{ id: "f2", name: "b.pdf", size: 2, key: "k" }] }) as { kind: "login"; login: Login }).login;
    const m = mergeLogins(keep, drop, new Date("2026-10-25T00:00:00Z"));
    expect(m.id).toBe("k");
    expect(m.password).toBe("neuf");
    expect(m.passwordHistory.map((h) => h.password)).toEqual(["vieux", "ancien"]);
    expect(m.uris.map((u) => u.uri)).toEqual(["https://a.io", "https://app.a.io"]);
    expect(m.totp).toBe("SECRET");
    expect(m.tags).toEqual(["perso", "travail"]);
    expect(m.notes).toBe("garder\n\naussi");
    expect(m.fields).toEqual([{ name: "PIN", value: "1", type: "hidden" }]);
    expect(m.attachments?.map((a) => a.id)).toEqual(["f1", "f2"]);
    expect(m.favorite).toBe(true);
    expect(m.reprompt).toBe(true);
  });

  it("dupliquer : un autre élément, sans pièces jointes ni passkeys ni historique", () => {
    const p = login("orig", { name: "Banque", password: "x", attachments: [{ id: "f", name: "a", size: 1, key: "k" }], passwordHistory: [{ password: "y", changedAt: "2025-01-01T00:00:00Z" }] });
    const copy = duplicateOf(p) as { kind: "login"; login: Login };
    expect(copy.login.id).not.toBe("orig");
    expect(copy.login.name).toBe("Banque (copie)");
    expect(copy.login.password).toBe("x");
    expect(copy.login.attachments).toBeUndefined();
    expect(copy.login.passwordHistory).toEqual([]);
    // L'original n'est pas touché.
    expect((p as { kind: "login"; login: Login }).login.attachments).toHaveLength(1);
  });

  it("copier vers un autre vault : ids neufs, liens internes suivis, liens externes coupés", () => {
    const folder: Payload = { kind: "group", group: { id: "f", name: "Prod", parentId: "ailleurs" } };
    const account: Payload = { kind: "account", account: { id: "a", name: "LDAP", groupId: "f", tags: [], username: "u", password: "p", passwordHistory: [] } };
    const linked: Payload = { kind: "login", login: { ...emptyLogin("f"), id: "l", name: "Wiki", username: "u", password: "p", accountId: "a" } };
    const outside: Payload = { kind: "login", login: { ...emptyLogin("x"), id: "o", name: "Jira", username: "u", password: "p", accountId: "z" } };
    const [g, a, l, o] = copiesFor([account, linked, folder, outside]);
    expect(g.kind === "group" && [g.group.id !== "f", g.group.parentId, g.group.name]).toEqual([true, null, "Prod"]);
    const gid = g.kind === "group" ? g.group.id : "";
    expect(a.kind === "account" && [a.account.id !== "a", a.account.groupId === gid, a.account.name]).toEqual([true, true, "LDAP"]);
    expect(l.kind === "login" && a.kind === "account" && [l.login.accountId === a.account.id, l.login.groupId === gid, l.login.name]).toEqual([true, true, "Wiki"]);
    expect(o.kind === "login" && ["accountId" in o.login, o.login.groupId, o.login.password]).toEqual([false, null, "p"]);
  });
});
