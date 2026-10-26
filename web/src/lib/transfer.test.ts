/** Le transfert (`transfer.ts`) entre deux extrémités en mémoire qui suivent
 * les règles du serveur (historique, corbeille, import, pièces jointes) — la
 * vraie crypto : ce qui arrive doit s'ouvrir avec le compte d'arrivée. Les
 * règles elles-mêmes sont testées contre le vrai serveur (`tests/api.rs`,
 * `vault_import_keeps_history_trash_and_dates`) et le vrai coffre local. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Transport } from "./api";
import { fromBase64, toBase64, utf8, uuid, randomBytes } from "./bytes";
import * as c from "./crypto";
import { batches, copyToCoffre, copyToNewCoffre, copyVaults, importPlan } from "./transfer";
import { memoryHost, openNote, populated, sessionOf } from "./memoryEnd.testing";
import type { Item, ItemVersion, TrashedItem } from "./types";

const b64 = toBase64;
const unb64 = fromBase64;

beforeEach(() => {
  vi.stubGlobal("navigator", { userAgent: "vitest" });
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("le plan d'import", () => {
  it("garde l'historique dans l'ordre, la corbeille avec sa date, et saute le reste", () => {
    const at = (n: number) => `2026-01-0${n}T00:00:00Z`;
    const item = (id: string, deleted: boolean): Item => ({ id, vault_id: "v", item_type: "note", revision: 9, ciphertext: deleted ? "" : "QUJD", deleted, created_at: at(1), updated_at: at(2) });
    const ver = (item_id: string, revision: number): ItemVersion => ({ item_id, revision, item_type: "note", ciphertext: `v${revision}`, written_at: at(1), replaced_at: at(2), replaced_by: "x" });
    const trash: TrashedItem[] = [{ item_id: "t", item_type: "note", revision: 5, ciphertext: "v5", deleted_at: at(3), deleted_by: null, expires_at: at(9) }];
    const plan = importPlan(
      [item("a", false), item("t", true), item("gone", true), item("there", false)],
      trash,
      [ver("a", 4), ver("a", 2), ver("t", 5), ver("gone", 1)],
      new Set(["there"]),
    );
    expect(plan.map((p) => p.id)).toEqual(["a", "t"]);
    expect(plan[0].versions.map((v) => v.ciphertext)).toEqual(["v2", "v4"]);
    expect(plan[1]).toMatchObject({ ciphertext: "", deleted_at: at(3) });
  });

  it("découpe en lots d'au plus 1000 items, un gros item seul", () => {
    const small = (id: string) => ({ id, item_type: "note", ciphertext: "x", created_at: "", updated_at: "", versions: [] });
    expect(batches(Array.from({ length: 2500 }, (_, i) => small(String(i)))).map((b) => b.length)).toEqual([1000, 1000, 500]);
    const big = { ...small("big"), ciphertext: "x".repeat(5 * 1024 * 1024) };
    expect(batches([small("a"), big, small("b")]).map((b) => b.map((i) => i.id))).toEqual([["a"], ["big"], ["b"]]);
  });
});

describe("copier des vaults", () => {
  it("vers un compte existant : clés ré-enveloppées, historique, corbeille, pièces jointes, manifeste — et reprise", async () => {
    const src = await populated("source");
    const personal = await src.add("Personnel", "personal");
    const work = await src.add("Travail", "shared");
    const a = uuid();
    for (const n of [1, 2, 3, 4, 5]) await src.put(personal, a, `a${n}`);
    const gone = uuid();
    await src.put(personal, gone, "g1");
    await src.put(personal, gone, "g2");
    const w = uuid();
    await src.put(work, w, "w1");
    // Une pièce jointe sur un item vivant, une sur un item ensuite supprimé.
    for (const [id, item] of [["f1", w], ["f2", gone]] as const) {
      const vid = item === w ? work.id : personal.id;
      await src.mem.end.createAttachment!(vid, { id, item_id: item, size: 6, chunks: 2 });
      await src.mem.end.putAttachmentChunk!(vid, id, 0, utf8.encode("abc"));
      await src.mem.end.putAttachmentChunk!(vid, id, 1, utf8.encode("def"));
      await src.mem.end.completeAttachment!(vid, id);
    }
    await src.mem.end.deleteItem!(personal.id, gone);
    src.mem.vaults.get(work.id)!.manifest = { ciphertext: "bWFuaWZlc3Rl", revision: 7 };

    // L'arrivée : un autre compte, qui a déjà son vault personnel.
    const dst = await populated("arrivée");
    await dst.add("Personnel", "personal");
    let failOnce = true;
    const flaky: Partial<Transport> = {
      ...dst.mem.end,
      importItems: async (id, req) => {
        if (id === work.id && failOnce) {
          failOnce = false;
          throw new ApiError(503, "unavailable", "coupure");
        }
        return dst.mem.end.importItems!(id, req);
      },
    };
    const dest = { api: flaky, account: dst.account, personalName: "Personnel (Mon coffre)" };
    const first = await copyVaults(src.mem.end, dest, src.vaults);
    expect(first[0]).toMatchObject({ name: "Personnel (Mon coffre)", items: 2, trashed: 1, versions: 3 + 2, skippedAttachments: 1, resumed: false });
    expect(first[1].error).toBe("coupure");

    // Reprise : seul ce qui manque part.
    const second = await copyVaults(src.mem.end, dest, src.vaults);
    expect(second[0]).toMatchObject({ items: 0, resumed: true });
    expect(second[1]).toMatchObject({ items: 1, attachments: 1, resumed: true });
    expect(second[1].error).toBeUndefined();

    // Tout s'ouvre avec le compte d'arrivée.
    const there = dst.mem.vaults.get(personal.id)!;
    const key = c.unwrapVaultKey(dst.account, personal.id, unb64(there.vault.wrapped_vault_key)).key;
    expect(c.openVaultName(key, personal.id, unb64(there.vault.name_enc))).toBe("Personnel (Mon coffre)");
    const live = there.items.find((i) => i.id === a)!;
    expect(openNote(key, personal.id, a, live.ciphertext)).toBe("a5");
    const src0 = src.mem.vaults.get(personal.id)!.items.find((i) => i.id === a)!;
    expect(live.created_at).toBe(src0.created_at);
    const hist = there.versions.filter((x) => x.item_id === a).sort((x, y) => x.revision - y.revision);
    expect(hist.map((x) => openNote(key, personal.id, a, x.ciphertext))).toEqual(["a2", "a3", "a4"]);
    const trash = await dst.mem.end.trash!(personal.id);
    expect(trash.map((t) => openNote(key, personal.id, gone, t.ciphertext))).toEqual(["g2"]);
    expect(trash[0].deleted_at).toBe((await src.mem.end.trash!(personal.id))[0].deleted_at);

    const workThere = dst.mem.vaults.get(work.id)!;
    expect(workThere.manifest).toEqual({ ciphertext: "bWFuaWZlc3Rl", revision: 7 });
    expect(new TextDecoder().decode(workThere.chunks.get("f1/1"))).toBe("def");
    expect(workThere.attachments.map((x) => [x.id, x.complete])).toEqual([["f1", true]]);
  }, 60_000);

  it("refuse un id de vault déjà pris par quelqu'un d'autre, sans arrêter les autres", async () => {
    const src = await populated("source");
    const v1 = await src.add("Un", "shared");
    await src.add("Deux", "shared");
    const dst = await populated("arrivée");
    const api: Partial<Transport> = {
      ...dst.mem.end,
      // Le vault existe sur le serveur, mais pas dans nos vaults à nous.
      createVault: async (req) => {
        if (req.id === v1.id) throw new ApiError(409, "vault_exists", "existe");
        return dst.mem.end.createVault!(req);
      },
    };
    const res = await copyVaults(src.mem.end, { api, account: dst.account }, src.vaults);
    expect(res[0].error).toMatch(/existe déjà/);
    expect(res[1].error).toBeUndefined();
  }, 60_000);
});

describe("vers un coffre local", () => {
  it("un coffre neuf reprend le compte tel quel : même mot de passe, même vault personnel, réglages compris", async () => {
    const src = await populated("le mot de passe");
    const personal = await src.add("Personnel", "personal");
    const id = uuid();
    await src.put(personal, id, "secret");
    await src.mem.end.putSettings!("cmVnbGFnZXM=", null);
    const state = sessionOf(src);
    const h = memoryHost();

    await expect(copyToNewCoffre(state, src.mem.end, h.host, "/x/Copie.guivault", "faux", src.vaults)).rejects.toThrow("Mot de passe maître incorrect.");
    const res = await copyToNewCoffre(state, src.mem.end, h.host, "/x/Copie.guivault", "le mot de passe", src.vaults);
    expect(res).toEqual([expect.objectContaining({ id: personal.id, items: 1, resumed: false })]);
    expect(h.isOpen()).toBe(false);

    // Le compte du coffre est celui de la session : il s'ouvre avec le même mot de passe.
    const a = h.account();
    expect(a.protected_user_key).toBe(state.blobs!.protected_user_key);
    const master = await c.deriveMasterKey("le mot de passe", unb64(a.kdf_salt), a.kdf);
    const account = c.unlockAccount(master.stretchedKey, unb64(a.protected_user_key), unb64(a.protected_private_key));
    const v = h.mem().vaults.get(personal.id)!;
    expect(v.vault.kind).toBe("personal");
    const key = c.unwrapVaultKey(account, personal.id, unb64(v.vault.wrapped_vault_key)).key;
    expect(openNote(key, personal.id, id, v.items[0].ciphertext)).toBe("secret");
    expect(h.mem().settings()?.blob).toBe("cmVnbGFnZXM=");
  }, 60_000);

  it("un coffre existant s'ouvre avec son mot de passe, et le vault personnel y devient ordinaire", async () => {
    const src = await populated("compte");
    const personal = await src.add("Personnel", "personal");
    const id = uuid();
    await src.put(personal, id, "du compte");

    // Le coffre d'arrivée, avec son propre compte.
    const other = await c.createAccount("coffre");
    const h = memoryHost();
    const pid = uuid();
    const pkey = randomBytes(c.KEY_LEN);
    await h.host.create("/x/Autre.guivault", {
      account: { kdf: other.material.kdf, kdf_salt: b64(other.material.kdfSalt), protected_user_key: b64(other.material.protectedUserKey), public_key: b64(other.material.publicKey), protected_private_key: b64(other.material.protectedPrivateKey) },
      personal: { id: pid, name_enc: b64(c.sealVaultName(pkey, pid, "Personnel")), wrapped_vault_key: b64(c.wrapVaultKey(other.account.keypair, other.material.publicKey, pid, pkey)) },
    });
    await h.host.close();

    await expect(copyToCoffre(src.mem.end, h.host, "/x/Autre.guivault", "compte", "Personnel (alice)", src.vaults)).rejects.toThrow("Mot de passe maître incorrect.");
    const res = await copyToCoffre(src.mem.end, h.host, "/x/Autre.guivault", "coffre", "Personnel (alice)", src.vaults);
    expect(res[0]).toMatchObject({ name: "Personnel (alice)", items: 1, resumed: false });
    const v = h.mem().vaults.get(personal.id)!;
    expect(v.vault.kind).toBe("shared");
    const key = c.unwrapVaultKey(other.account, personal.id, unb64(v.vault.wrapped_vault_key)).key;
    expect(openNote(key, personal.id, id, v.items[0].ciphertext)).toBe("du compte");
  }, 60_000);
});
