/** Synchroniser deux copies d'un coffre (`coffreSync.ts`) : le plan de
 * fusion seul, puis deux coffres en mémoire qui ont divergé — la vraie
 * crypto, les règles du serveur (`memoryEnd.testing.ts`). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64, toBase64, utf8, uuid } from "./bytes";
import * as c from "./crypto";
import { planMerge, syncWithCopy } from "./coffreSync";
import { memoryHost, openNote, populated, sessionOf } from "./memoryEnd.testing";
import { copyToNewCoffre } from "./transfer";
import type { Item, ItemVersion } from "./types";

beforeEach(() => {
  vi.stubGlobal("navigator", { userAgent: "vitest" });
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

const b64 = toBase64;
const unb64 = fromBase64;
const pause = () => new Promise((r) => setTimeout(r, 5));

describe("le plan de fusion", () => {
  const at = (n: number) => `2026-01-0${n}T00:00:00Z`;
  const item = (id: string, ct: string, revision: number, day: number, deleted = false): Item => ({ id, vault_id: "v", item_type: "note", revision, ciphertext: deleted ? "" : ct, deleted, created_at: at(1), updated_at: at(day) });
  const ver = (item_id: string, ciphertext: string): ItemVersion => ({ item_id, revision: 1, item_type: "note", ciphertext, written_at: at(1), replaced_at: at(2), replaced_by: "x" });

  it("avance le côté resté en arrière, sans conflit", () => {
    const plan = planMerge({ items: [item("a", "A2", 2, 2)], versions: [ver("a", "A1")] }, { items: [item("a", "A1", 1, 3)], versions: [] });
    // Même plus ancien en date, « ici » a dépassé l'état de la copie.
    expect(plan).toEqual({ here: [], there: [{ kind: "put", id: "a", itemType: "note", ciphertext: "A2", baseRevision: 1 }], conflicts: [] });
  });

  it("deux modifications : la plus récente gagne, et c'est un conflit", () => {
    const plan = planMerge({ items: [item("a", "ICI", 2, 2)], versions: [ver("a", "A1")] }, { items: [item("a", "LA", 2, 3)], versions: [ver("a", "A1")] });
    expect(plan.conflicts).toEqual(["a"]);
    expect(plan.here).toEqual([{ kind: "put", id: "a", itemType: "note", ciphertext: "LA", baseRevision: 2 }]);
    expect(plan.there).toEqual([]);
  });

  it("une suppression de l'état connu passe ; une suppression d'un état inconnu est un conflit", () => {
    const known = planMerge({ items: [item("a", "", 3, 2, true)], versions: [ver("a", "A1")] }, { items: [item("a", "A1", 1, 3)], versions: [] });
    expect(known).toEqual({ here: [], there: [{ kind: "delete", id: "a" }], conflicts: [] });
    // La copie l'a modifié après : il revient ici.
    const later = planMerge({ items: [item("a", "", 3, 2, true)], versions: [ver("a", "A1")] }, { items: [item("a", "A2", 2, 3)], versions: [ver("a", "A1")] });
    expect(later.conflicts).toEqual(["a"]);
    expect(later.here).toEqual([{ kind: "put", id: "a", itemType: "note", ciphertext: "A2", baseRevision: 3 }]);
  });

  it("ce qui n'est que d'un côté passe de l'autre ; une pierre tombale seule, non", () => {
    const plan = planMerge({ items: [item("a", "A", 1, 1), item("t", "", 2, 1, true)], versions: [] }, { items: [item("b", "B", 1, 1)], versions: [] });
    expect(plan.there).toEqual([{ kind: "put", id: "a", itemType: "note", ciphertext: "A", baseRevision: undefined }]);
    expect(plan.here).toEqual([{ kind: "put", id: "b", itemType: "note", ciphertext: "B", baseRevision: undefined }]);
  });
});

describe("deux copies d'un coffre", () => {
  it("redeviennent une : avances, conflit, suppression, ajouts et vault nouveau", async () => {
    const src = await populated("le mot de passe");
    const personal = await src.add("Personnel", "personal");
    const [n1, n2, n3] = [uuid(), uuid(), uuid()];
    for (const id of [n1, n2, n3]) await src.put(personal, id, `${id} v1`);
    const state = sessionOf(src);
    const h = memoryHost();
    await copyToNewCoffre(state, src.mem.end, h.host, "/x/Copie.guivault", "le mot de passe", src.vaults);
    const copy = h.mem().end;
    const seal = (id: string, text: string) => b64(c.sealItem(personal.key, personal.id, id, "note", utf8.encode(text)));
    const rev = async (end: typeof copy, id: string) => (await end.items!(personal.id, 0)).items.find((i) => i.id === id)!.revision;

    // Ici : n1 avance. Les deux : n2 (la copie d'abord, ici ensuite).
    await src.put(personal, n1, "n1 v2");
    await copy.putItem!(personal.id, n2, { item_type: "note", ciphertext: seal(n2, "n2 copie"), base_revision: await rev(copy, n2) });
    await pause();
    await src.put(personal, n2, "n2 ici");
    // La copie : supprime n3, ajoute n5 et un vault ; ici : ajoute n4.
    await copy.deleteItem!(personal.id, n3);
    const n4 = uuid();
    const n5 = uuid();
    await src.put(personal, n4, "n4");
    await copy.putItem!(personal.id, n5, { item_type: "note", ciphertext: seal(n5, "n5") });
    const teamId = uuid();
    const teamKey = crypto.getRandomValues(new Uint8Array(c.KEY_LEN));
    await copy.createVault!({ id: teamId, name_enc: b64(c.sealVaultName(teamKey, teamId, "Équipe")), wrapped_vault_key: b64(c.wrapVaultKey(src.account.keypair, src.material.publicKey, teamId, teamKey)) });
    const t1 = uuid();
    await copy.putItem!(teamId, t1, { item_type: "note", ciphertext: b64(c.sealItem(teamKey, teamId, t1, "note", utf8.encode("de l'équipe"))) });

    await expect(syncWithCopy(state, src.mem.end, h.host, "/x/Copie.guivault", "faux")).rejects.toThrow("Mot de passe maître incorrect.");
    const reports = await syncWithCopy(state, src.mem.end, h.host, "/x/Copie.guivault", "le mot de passe");
    expect(h.isOpen()).toBe(false);
    expect(reports).toEqual([
      expect.objectContaining({ id: personal.id, here: 2, there: 3, conflicts: 1 }),
      expect.objectContaining({ id: teamId, name: "Équipe", copied: "here" }),
    ]);
    expect(reports.map((r) => r.error)).toEqual([undefined, undefined]);

    // Les deux côtés : les mêmes éléments vivants, les mêmes chiffrés.
    const live = async (end: typeof copy) => Object.fromEntries((await end.items!(personal.id, 0)).items.filter((i) => !i.deleted).map((i) => [i.id, openNote(personal.key, personal.id, i.id, i.ciphertext)]));
    const here = await live(src.mem.end);
    expect(here).toEqual(await live(copy));
    expect(here).toEqual({ [n1]: "n1 v2", [n2]: "n2 ici", [n4]: "n4", [n5]: "n5" });
    // La version perdante du conflit reste dans l'historique de la copie.
    const history = (await copy.vaultVersions!(personal.id)).filter((v) => v.item_id === n2).map((v) => openNote(personal.key, personal.id, n2, v.ciphertext));
    expect(history).toContain("n2 copie");
    // Le vault de la copie est arrivé ici, ouvrable avec le compte d'ici.
    const team = (await src.mem.end.sync!()).vaults.find((v) => v.id === teamId)!;
    const key = c.unwrapVaultKey(src.account, teamId, unb64(team.wrapped_vault_key)).key;
    const [t] = (await src.mem.end.items!(teamId, 0)).items;
    expect(openNote(key, teamId, t1, t.ciphertext)).toBe("de l'équipe");

    // Une seconde fois : plus rien à faire.
    const again = await syncWithCopy({ ...state, vaults: [...state.vaults, { ...state.vaults[0], id: teamId, kind: "shared", name: "Équipe", key }] }, src.mem.end, h.host, "/x/Copie.guivault", "le mot de passe");
    expect(again.map((r) => [r.here, r.there, r.conflicts, r.copied])).toEqual([[0, 0, 0, undefined], [0, 0, 0, undefined]]);
  }, 60_000);

  it("refuse un coffre qui n'est pas une copie", async () => {
    const a = await populated("pw");
    await a.add("Personnel", "personal");
    const b = await populated("pw");
    await b.add("Personnel", "personal");
    const h = memoryHost();
    await copyToNewCoffre(sessionOf(b), b.mem.end, h.host, "/x/Autre.guivault", "pw", b.vaults);
    await expect(syncWithCopy(sessionOf(a), a.mem.end, h.host, "/x/Autre.guivault", "pw")).rejects.toThrow("n'est pas une copie");
    expect(h.isOpen()).toBe(false);
  }, 60_000);
});
