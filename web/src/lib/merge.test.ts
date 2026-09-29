import { describe, expect, it } from "vitest";
import { emptyLogin } from "./items";
import { buildMerge, planMerge } from "./merge";
import type { Payload } from "./types";

const login = (over: Record<string, unknown> = {}): Payload => ({ kind: "login", login: { ...emptyLogin(), id: "L", name: "GitHub", username: "alice", password: "p0", uris: [{ uri: "https://github.com" }], ...over } as never });
const paths = (fs: { path: string }[]) => fs.map((f) => f.path).sort();

describe("fusion champ par champ", () => {
  it("reprend ce qui n'a changé que d'un côté, et garde les champs inconnus du serveur", () => {
    const base = login();
    const mine = login({ username: "alice2", notes: "à moi" });
    const theirs = login({ uris: [{ uri: "https://github.com" }, { uri: "https://gist.github.com" }], fromGuiterm: 42 });
    const plan = planMerge(base, mine, theirs);
    expect(paths(plan.fromMine)).toEqual(["login.notes", "login.username"]);
    expect(paths(plan.fromTheirs)).toEqual(["login.fromGuiterm", "login.uris"]);
    expect(plan.conflicts).toEqual([]);
    const merged = buildMerge(mine, theirs, plan);
    expect(merged).toMatchObject({ login: { username: "alice2", notes: "à moi", fromGuiterm: 42 } });
    expect(merged.kind === "login" && merged.login.uris).toHaveLength(2);
  });

  it("demande de choisir quand les deux côtés ont changé le même champ, pas quand ils ont fait pareil", () => {
    const base = login({ tags: ["a"] });
    const mine = login({ name: "GitHub perso", tags: ["b", "a"] });
    const theirs = login({ name: "GitHub pro", tags: ["b", "a"] });
    const plan = planMerge(base, mine, theirs);
    expect(paths(plan.conflicts)).toEqual(["login.name"]);
    expect(plan.conflicts[0]).toMatchObject({ label: "Nom", base: "GitHub", mine: "GitHub perso", theirs: "GitHub pro", secret: false });
    expect(buildMerge(mine, theirs, plan)).toMatchObject({ login: { name: "GitHub perso" } });
    expect(buildMerge(mine, theirs, plan, { "login.name": "theirs" })).toMatchObject({ login: { name: "GitHub pro" } });
  });

  it("un champ vidé d'un côté est retiré ; l'ordre des clés ne compte pas", () => {
    const base = login({ notes: "vieille note", totp: null });
    const mine = { kind: "login", login: Object.fromEntries(Object.entries((login({ notes: "vieille note" }) as { login: object }).login).reverse()) } as Payload;
    const theirs = login({ notes: undefined, totp: null });
    const plan = planMerge(base, mine, theirs);
    expect(paths(plan.fromTheirs)).toEqual(["login.notes"]);
    expect(plan.fromMine).toEqual([]);
    expect("notes" in (buildMerge(mine, theirs, plan) as { login: object }).login).toBe(false);
  });

  it("l'historique des mots de passe s'unit, et le mot de passe écarté y entre", () => {
    const base = login({ password: "p0" });
    const mine = login({ password: "p-mine", passwordHistory: [{ password: "p0", changedAt: "2026-09-29T10:00:00Z" }] });
    const theirs = login({ password: "p-theirs", passwordHistory: [{ password: "p0", changedAt: "2026-09-29T09:00:00Z" }, { password: "older", changedAt: "2026-01-01T00:00:00Z" }] });
    const plan = planMerge(base, mine, theirs);
    expect(plan.conflicts.map((f) => [f.path, f.secret])).toEqual([["login.password", true]]);
    const merged = buildMerge(mine, theirs, plan, { "login.password": "mine" }, new Date("2026-09-29T12:00:00Z"));
    if (merged.kind !== "login") throw new Error();
    expect(merged.login.password).toBe("p-mine");
    expect(merged.login.passwordHistory).toEqual([
      { password: "p-theirs", changedAt: "2026-09-29T12:00:00.000Z" },
      { password: "p0", changedAt: "2026-09-29T10:00:00Z" },
      { password: "older", changedAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("les secrets hors entité (hôte) se fusionnent aussi, masqués", () => {
    const host = (over: Record<string, unknown>, secrets: Record<string, unknown>): Payload => ({ kind: "host", host: { id: "H", label: "db", hostname: "10.0.0.1", ...over }, secrets } as never);
    const plan = planMerge(host({}, { password: "a" }), host({ port: 2222 }, { password: "b" }), host({}, { password: "c" }));
    expect(paths(plan.fromMine)).toEqual(["host.port"]);
    expect(plan.conflicts.map((f) => [f.path, f.label, f.secret])).toEqual([["secrets.password", "Mot de passe", true]]);
    expect(buildMerge(host({ port: 2222 }, { password: "b" }), host({}, { password: "c" }), plan, { "secrets.password": "theirs" })).toMatchObject({ host: { port: 2222 }, secrets: { password: "c" } });
  });
});
