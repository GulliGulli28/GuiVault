import { describe, expect, it } from "vitest";
import { parseTags, rangeBetween, runBulk, subtreeIds, topOfSelection, withFavorite, withTags } from "./bulk";
import type { Payload } from "./types";

const login = (extra: Record<string, unknown> = {}): Payload =>
  ({ kind: "login", login: { id: "l1", name: "Site", groupId: null, tags: ["Perso"], username: "", password: "", uris: [], totp: null, passkeys: [], passwordHistory: [], ...extra } }) as unknown as Payload;
const host = (): Payload =>
  ({ kind: "host", host: { id: "h1", label: "srv", address: "srv", port: 22, username: "root", auth: "agent", groupId: null, jumpVia: [], tags: [], startupSnippets: [], envVars: [] }, secrets: { password: "x" } }) as unknown as Payload;

describe("actions de masse", () => {
  it("épingler : les secrets seulement, et seulement si ça change", () => {
    const p = withFavorite(login(), true);
    expect(p?.kind === "login" && p.login.favorite).toBe(true);
    expect(withFavorite(login({ favorite: true }), true)).toBeNull();
    const off = withFavorite(login({ favorite: true }), false);
    expect(off?.kind === "login" && off.login.favorite).toBeUndefined();
    expect(withFavorite(host(), true)).toBeNull();
  });

  it("étiquettes : ajout sans doublon (casse comprise), retrait, le reste intact", () => {
    const p = withTags(login(), ["Travail", "perso"], []);
    expect(p?.kind === "login" && p.login.tags).toEqual(["Perso", "Travail"]);
    const q = withTags(login(), [], ["PERSO"]);
    expect(q?.kind === "login" && q.login.tags).toEqual([]);
    expect(withTags(login(), ["Perso"], [])).toBeNull();
    const h = withTags(host(), ["prod"], []);
    expect(h?.kind === "host" && h.host.tags).toEqual(["prod"]);
    expect(h?.kind === "host" && h.secrets).toEqual({ password: "x" });
  });

  it("étiquettes tapées", () => {
    expect(parseTags(" a, b ,, a,c ")).toEqual(["a", "b", "c"]);
  });

  it("Maj+clic : la plage, dans les deux sens", () => {
    const ids = ["a", "b", "c", "d"];
    expect(rangeBetween(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(ids, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(ids, null, "c")).toEqual(["c"]);
    expect(rangeBetween(ids, "zz", "c")).toEqual(["c"]);
  });

  it("un dossier coché : tout son contenu, sous-dossiers compris ; ranger ne touche que le haut", () => {
    const e = [
      { id: "prod", parentId: null }, { id: "db", parentId: "prod" }, { id: "pg", parentId: "db" },
      { id: "web", parentId: "prod" }, { id: "perso", parentId: null },
      { id: "boucle", parentId: "boucle" },
    ];
    expect(subtreeIds(e, "prod")).toEqual(["prod", "db", "pg", "web"]);
    expect(subtreeIds(e, "boucle")).toEqual(["boucle"]);
    const picked = new Set(["prod", "db", "pg", "perso"]);
    expect(topOfSelection(e.filter((x) => picked.has(x.id)), picked).map((x) => x.id)).toEqual(["prod", "perso"]);
  });

  it("une erreur n'arrête pas les suivantes", async () => {
    const seen: number[] = [];
    const r = await runBulk([1, 2, 3, 4], (n) => `n${n}`, async (n) => {
      if (n === 2) throw new Error("refusé");
      return n !== 3;
    }, (i) => seen.push(i));
    expect(r).toEqual({ done: 2, skipped: 1, failed: [{ name: "n2", error: "refusé" }] });
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});
