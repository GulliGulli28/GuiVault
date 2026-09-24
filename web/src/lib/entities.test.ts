import { describe, expect, it } from "vitest";
import { filterEntities, matchesQuery, sortedFlat } from "./entities";
import { primarySecret, primaryUser } from "./items";
import type { GuiVaultEntity } from "./types";

const e = (id: string, kind: GuiVaultEntity["kind"], parentId: string | null): GuiVaultEntity => ({ id, kind, name: id, path: "", parentId });

describe("filterEntities", () => {
  const all = [
    e("prod", "group", null),
    e("bases", "group", "prod"),
    e("vide", "group", null),
    e("web", "host", "prod"),
    e("pg", "sql-connection", "bases"),
    e("gh", "login", "bases"),
  ];

  it("garde les dossiers qui mènent à une entité retenue, pas les autres", () => {
    const ids = filterEntities(all, (x) => x.kind === "login").map((x) => x.id);
    expect(ids).toEqual(["prod", "bases", "gh"]);
  });

  it("un type absent d'un dossier le fait disparaître", () => {
    const ids = filterEntities(all, (x) => x.kind === "host").map((x) => x.id);
    expect(ids).toEqual(["prod", "web"]);
  });

  it("ne boucle pas sur un cycle de parentId", () => {
    const cyclic = [e("a", "group", "b"), e("b", "group", "a"), e("x", "login", "a")];
    expect(filterEntities(cyclic, (x) => x.kind === "login").map((x) => x.id)).toEqual(["a", "b", "x"]);
  });
});

describe("tri à plat et recherche", () => {
  const dated = (id: string, updatedAt: string, createdAt: string, extra: Partial<GuiVaultEntity> = {}): GuiVaultEntity => ({ ...e(id, "login", null), updatedAt, createdAt, ...extra });
  const all = [
    e("dossier", "group", null),
    dated("ancien", "2026-01-03T00:00:00Z", "2026-01-01T00:00:00Z", { search: "alice github.com" }),
    dated("récent", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z", { tags: ["prod"] }),
  ];

  it("trie par date, le plus récent en tête, sans les dossiers", () => {
    expect(sortedFlat(all, "", "updated").map((x) => x.id)).toEqual(["ancien", "récent"]);
    expect(sortedFlat(all, "", "created").map((x) => x.id)).toEqual(["récent", "ancien"]);
  });

  it("cherche mot à mot dans le nom, l'utilisateur, le site, les tags — et ce qu'on ajoute", () => {
    expect(sortedFlat(all, "alice github", "updated").map((x) => x.id)).toEqual(["ancien"]);
    expect(sortedFlat(all, "prod", "updated").map((x) => x.id)).toEqual(["récent"]);
    expect(matchesQuery(all[1], "équipe", "Équipe infra")).toBe(true);
    expect(matchesQuery(all[1], "alice gitlab")).toBe(false);
  });
});

describe("ce que « c » et « u » copient", () => {
  it("le mot de passe et l'utilisateur d'un identifiant, le secret d'une clé d'API", () => {
    const login = { kind: "login", login: { id: "l", name: "GitHub", groupId: null, tags: [], username: "alice", password: "s3cret", uris: [], totp: "", passkeys: [], passwordHistory: [] } } as never;
    expect(primarySecret(login)).toEqual({ label: "Mot de passe", value: "s3cret" });
    expect(primaryUser(login)).toEqual({ label: "Utilisateur", value: "alice" });
    const apiKey = { kind: "api-key", apiKey: { id: "k", name: "Stripe", groupId: null, tags: [], service: "", url: "", keyId: "pk_1", secret: "sk_1", scopes: "", expiresAt: "" } } as never;
    expect(primarySecret(apiKey)).toEqual({ label: "Secret", value: "sk_1" });
    expect(primaryUser(apiKey)).toEqual({ label: "Identifiant de clé", value: "pk_1" });
    // Rien à copier : rien, plutôt qu'une chaîne vide.
    expect(primarySecret({ kind: "login", login: { ...(login as { login: object }).login, password: "" } } as never)).toBeNull();
  });
});
