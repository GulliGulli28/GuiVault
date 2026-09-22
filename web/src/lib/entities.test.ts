import { describe, expect, it } from "vitest";
import { filterEntities } from "./entities";
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
