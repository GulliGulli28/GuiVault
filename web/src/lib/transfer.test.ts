/** Le transfert (`transfer.ts`) entre deux extrémités en mémoire qui suivent
 * les règles du serveur (historique, corbeille, import, pièces jointes) — la
 * vraie crypto : ce qui arrive doit s'ouvrir avec le compte d'arrivée. Les
 * règles elles-mêmes sont testées contre le vrai serveur (`tests/api.rs`,
 * `vault_import_keeps_history_trash_and_dates`) et le vrai coffre local. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Transport } from "./api";
import { fromBase64, toBase64, utf8, uuid, randomBytes } from "./bytes";
import * as c from "./crypto";
import type { LocalHost, LocalOp, NewCoffre } from "./localHost";
import { batches, copyToCoffre, copyToNewCoffre, copyVaults, importPlan, type TransferVault } from "./transfer";
import type { SessionState } from "./session";
import type { ImportItemsRequest, Item, ItemVersion, ServerAttachment, TrashedItem, Vault, VaultManifest } from "./types";

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
const HISTORY = 3;

interface MemVault {
  vault: Vault;
  items: Item[];
  versions: (ItemVersion & { deleted?: boolean })[];
  deletedAt: Map<string, string>;
  attachments: ServerAttachment[];
  chunks: Map<string, Uint8Array>;
  manifest?: VaultManifest;
}

/** Un serveur (ou un coffre local) en mémoire : ses règles, pas sa crypto. */
function memoryEnd(publicKey = "") {
  const vaults = new Map<string, MemVault>();
  let settings: { blob: string; revision: number } | null = null;
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const now = () => new Date((clock += 1000)).toISOString();
  const err = (status: number, code: string) => new ApiError(status, code, code);
  const get = (id: string) => {
    const v = vaults.get(id);
    if (!v) throw err(404, "not_found");
    return v;
  };
  const bump = (v: MemVault) => ++v.vault.revision;
  const keep = (v: MemVault, it: Item) => {
    v.versions.push({ item_id: it.id, revision: it.revision, item_type: it.item_type, ciphertext: it.ciphertext, written_at: it.updated_at, replaced_at: now(), replaced_by: null });
    const mine = v.versions.filter((x) => x.item_id === it.id).sort((a, b) => b.revision - a.revision);
    const drop = new Set(mine.slice(HISTORY));
    v.versions = v.versions.filter((x) => !drop.has(x));
  };
  const end: Partial<Transport> = {
    sync: async () => ({ user: { id: "u", email: "", public_key: publicKey, created_at: "" }, vaults: [...vaults.values()].map((v) => v.vault), invitations: [], server_time: now() }) as never,
    settings: async () => (settings ? ({ blob: settings.blob, revision: settings.revision, updated_at: now() } as never) : null),
    putSettings: async (blob) => {
      settings = { blob, revision: (settings?.revision ?? 0) + 1 };
      return { blob, revision: settings.revision, updated_at: now() } as never;
    },
    createVault: async (req) => {
      if (vaults.has(req.id)) throw err(409, "vault_exists");
      const t = now();
      const vault: Vault = { id: req.id, kind: vaults.size === 0 ? "personal" : "shared", role: "owner", name_enc: req.name_enc, wrapped_vault_key: req.wrapped_vault_key, revision: 0, created_at: t, updated_at: t };
      vaults.set(req.id, { vault, items: [], versions: [], deletedAt: new Map(), attachments: [], chunks: new Map() });
      return vault;
    },
    items: async (id, since) => {
      const v = get(id);
      return { items: v.items.filter((i) => since !== undefined || !i.deleted), revision: v.vault.revision, manifest: v.manifest };
    },
    putItem: async (id, itemId, req) => {
      const v = get(id);
      const cur = v.items.find((i) => i.id === itemId && !i.deleted);
      if (cur) keep(v, cur);
      const t = now();
      const item: Item = { id: itemId, vault_id: id, item_type: req.item_type, revision: bump(v), ciphertext: req.ciphertext, deleted: false, created_at: cur?.created_at ?? t, updated_at: t };
      v.items = [...v.items.filter((i) => i.id !== itemId), item];
      return item;
    },
    deleteItem: async (id, itemId) => {
      const v = get(id);
      const cur = v.items.find((i) => i.id === itemId && !i.deleted)!;
      keep(v, cur);
      const t = now();
      v.deletedAt.set(itemId, t);
      Object.assign(cur, { deleted: true, ciphertext: "", revision: bump(v), updated_at: t });
    },
    vaultVersions: async (id) => get(id).versions.map((x) => ({ ...x })),
    trash: async (id) => {
      const v = get(id);
      return v.items
        .filter((i) => i.deleted && v.deletedAt.has(i.id))
        .flatMap((i): TrashedItem[] => {
          const last = v.versions.filter((x) => x.item_id === i.id).sort((a, b) => b.revision - a.revision)[0];
          return last ? [{ item_id: i.id, item_type: last.item_type, revision: last.revision, ciphertext: last.ciphertext, deleted_at: v.deletedAt.get(i.id)!, deleted_by: null, expires_at: "" }] : [];
        });
    },
    importItems: async (id, req: ImportItemsRequest) => {
      const v = get(id);
      if (v.manifest) throw err(409, "import_closed");
      if (req.items.some((it) => v.items.some((i) => i.id === it.id))) throw err(409, "item_exists");
      for (const it of req.items) {
        for (const ver of it.versions.slice(-HISTORY)) {
          v.versions.push({ item_id: it.id, revision: bump(v), item_type: ver.item_type, ciphertext: ver.ciphertext, written_at: ver.written_at, replaced_at: ver.replaced_at, replaced_by: null });
        }
        v.items.push({ id: it.id, vault_id: id, item_type: it.item_type, revision: bump(v), ciphertext: it.ciphertext, deleted: !!it.deleted_at, created_at: it.created_at, updated_at: it.updated_at });
        if (it.deleted_at) v.deletedAt.set(it.id, it.deleted_at);
      }
      if (req.manifest) v.manifest = req.manifest;
      return { revision: v.vault.revision, imported: req.items.length };
    },
    attachments: async (id) => get(id).attachments.map((a) => ({ ...a })),
    createAttachment: async (id, req) => {
      const v = get(id);
      if (!v.items.some((i) => i.id === req.item_id && !i.deleted)) throw err(404, "not_found");
      const a: ServerAttachment = { id: req.id, vault_id: id, item_id: req.item_id, size: req.size, chunks: req.chunks, complete: false, created_at: now() };
      v.attachments.push(a);
      return a;
    },
    putAttachmentChunk: async (id, aid, index, bytes) => {
      get(id).chunks.set(`${aid}/${index}`, bytes.slice());
      return new Uint8Array();
    },
    completeAttachment: async (id, aid) => {
      const a = get(id).attachments.find((x) => x.id === aid)!;
      a.complete = true;
      return a;
    },
    attachmentChunk: async (id, aid, index) => get(id).chunks.get(`${aid}/${index}`)!,
    deleteAttachment: async (id, aid) => {
      const v = get(id);
      v.attachments = v.attachments.filter((a) => a.id !== aid);
    },
  };
  return { end, vaults, settings: () => settings };
}

/** Un coffre (ou un compte) avec ses vaults, écrit comme l'écrirait l'app. */
async function populated(password: string) {
  const { material, account } = await c.createAccount(password);
  const mem = memoryEnd(b64(material.publicKey));
  const vaults: TransferVault[] = [];
  const add = async (name: string, kind: Vault["kind"]) => {
    const id = uuid();
    const key = randomBytes(c.KEY_LEN);
    await mem.end.createVault!({ id, name_enc: b64(c.sealVaultName(key, id, name)), wrapped_vault_key: b64(c.wrapVaultKey(account.keypair, material.publicKey, id, key)) });
    vaults.push({ id, kind, name, key });
    return { id, key };
  };
  const put = (v: { id: string; key: Uint8Array }, itemId: string, text: string) =>
    mem.end.putItem!(v.id, itemId, { item_type: "note", ciphertext: b64(c.sealItem(v.key, v.id, itemId, "note", utf8.encode(text))) });
  return { material, account, mem, vaults, add, put };
}

function openNote(key: Uint8Array, vaultId: string, itemId: string, ct: string) {
  return new TextDecoder().decode(c.openItem(key, vaultId, itemId, "note", unb64(ct)));
}

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

/** Un hôte de coffre local au-dessus d'une extrémité en mémoire. */
function memoryHost() {
  let mem: ReturnType<typeof memoryEnd> | null = null;
  let account: NewCoffre["account"] | null = null;
  let opened = false;
  const host: LocalHost = {
    create: async (_path, coffre) => {
      mem = memoryEnd(coffre.account.public_key);
      account = coffre.account;
      await mem.end.createVault!(coffre.personal);
      opened = true;
    },
    open: async () => {
      if (!mem) throw { status: 404, code: "local_not_found", message: "aucun coffre" };
      opened = true;
    },
    close: async () => {
      opened = false;
    },
    call: async (op: LocalOp, args: Record<string, unknown>) => {
      if (!opened || !mem) throw { status: 500, code: "local_io", message: "fermé" };
      const e = mem.end as Record<string, (...a: unknown[]) => unknown>;
      switch (op) {
        case "account": return account;
        case "sync": return e.sync();
        case "createVault": return e.createVault(args.req);
        case "items": return e.items(args.vault, args.since);
        case "importItems": return e.importItems(args.vault, args.req);
        case "attachments": return e.attachments(args.vault);
        case "createAttachment": return e.createAttachment(args.vault, args.req);
        case "putAttachmentChunk": return e.putAttachmentChunk(args.vault, args.id, args.index, unb64(args.bytes as string));
        case "completeAttachment": return e.completeAttachment(args.vault, args.id);
        case "deleteAttachment": return e.deleteAttachment(args.vault, args.id);
        case "putSettings": return e.putSettings((args.req as { blob: string }).blob, null);
        default: throw { status: 501, code: "local_unsupported", message: op };
      }
    },
  };
  return { host, mem: () => mem!, account: () => account!, isOpen: () => opened };
}

function sessionOf(src: Awaited<ReturnType<typeof populated>>): SessionState {
  return {
    user: { id: "u", email: "alice@example.org", public_key: b64(src.material.publicKey), created_at: "" },
    account: src.account,
    fingerprint: "",
    vaults: src.vaults.map((v) => ({ ...v, role: "owner", keyFrom: { kind: "self" }, revision: 0, updatedAt: "" })),
    invitations: [],
    emergency: null,
    emergencyVaults: [],
    rollbacks: [],
    blobs: { kdf: src.material.kdf, kdf_salt: b64(src.material.kdfSalt), protected_user_key: b64(src.material.protectedUserKey), protected_private_key: b64(src.material.protectedPrivateKey) },
  } as SessionState;
}

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
