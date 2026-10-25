/** Le transport du coffre local : la façade `api`, le contrat avec l'hôte
 * (`crates/guivault-local/ops.json`), et une session créée puis rouverte
 * de bout en bout — la vraie crypto, un hôte en mémoire. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, isHttpTransport, setTransport, supports } from "./api";
import { emptyPayload } from "./items";
import { localAccount, localChangePassword, localTransport, type LocalHost, type LocalOp, type NewCoffre } from "./localHost";
import { changeItem, changePassword, closeLocal, createLocal, loadItems, openLocal, payloadEntity, putPayload } from "./session";
import type { Item, Vault } from "./types";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("navigator", { userAgent: "vitest" });
});
afterEach(async () => {
  await closeLocal();
  vi.unstubAllGlobals();
});

/** Un hôte qui enregistre les appels et rend `reply`. */
function recordingHost(reply: (op: LocalOp, args: Record<string, unknown>) => unknown = () => null) {
  const calls: { op: LocalOp; args: Record<string, unknown> }[] = [];
  const host: LocalHost = {
    create: async () => {},
    open: async () => {},
    close: async () => {},
    call: async (op, args) => {
      calls.push({ op, args });
      return reply(op, args);
    },
  };
  return { host, calls };
}

describe("la façade api", () => {
  it("délègue au transport actif, et répond 501 pour ce qu'il n'a pas", async () => {
    expect(isHttpTransport()).toBe(true);
    expect(supports("members")).toBe(true);
    const { host, calls } = recordingHost(() => ({ id: "i" }));
    setTransport(localTransport(host));
    expect(isHttpTransport()).toBe(false);
    expect(supports("putItem")).toBe(true);
    expect(supports("members")).toBe(false);
    expect(supports("emergency")).toBe(false);

    await api.putItem("v", "i", { item_type: "note", ciphertext: "QUJD", base_revision: 3 });
    expect(calls).toEqual([{ op: "putItem", args: { vault: "v", id: "i", req: { item_type: "note", ciphertext: "QUJD", base_revision: 3 } } }]);

    const err = await api.members("v").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.code]).toEqual([501, "local_unsupported"]);

    setTransport(null);
    expect(isHttpTransport()).toBe(true);
  });

  it("rend les erreurs de l'hôte comme celles du serveur", async () => {
    const host: LocalHost = {
      ...recordingHost().host,
      call: async () => {
        throw { status: 409, code: "revision_mismatch", message: "modifié", current: { id: "i", revision: 4 } };
      },
    };
    setTransport(localTransport(host));
    const err = await api.putItem("v", "i", { item_type: "note", ciphertext: "QUJD" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.code, err.message]).toEqual([409, "revision_mismatch", "modifié"]);
    expect(err.extra.current).toEqual({ id: "i", revision: 4 });
    setTransport(null);
  });

  it("fait voyager les octets des pièces jointes en base64", async () => {
    const { host, calls } = recordingHost((op) => (op === "attachmentChunk" ? "AQID" : null));
    setTransport(localTransport(host));
    await api.putAttachmentChunk("v", "a", 0, new Uint8Array([4, 5, 6]));
    expect(calls[0].args.bytes).toBe("BAUG");
    expect(await api.attachmentChunk("v", "a", 1)).toEqual(new Uint8Array([1, 2, 3]));
    setTransport(null);
  });
});

describe("le contrat avec l'hôte", () => {
  it("emploie exactement les opérations de crates/guivault-local/ops.json", async () => {
    const shared: string[] = JSON.parse(readFileSync(fileURLToPath(new URL("../../../crates/guivault-local/ops.json", import.meta.url)), "utf8"));
    const { host, calls } = recordingHost((op) => (op === "attachmentChunk" ? "" : null));
    const transport = localTransport(host);
    for (const f of Object.values(transport)) await (f as (...a: unknown[]) => Promise<unknown>)("v", "i", { item_type: "note", ciphertext: "" }, new Uint8Array());
    await localAccount(host);
    await localChangePassword(host, { kdf: { m_cost: 0, t_cost: 0, p_cost: 0 }, kdf_salt: "", protected_user_key: "" });
    expect(new Set(calls.map((c) => c.op))).toEqual(new Set(shared));
    expect(calls).toHaveLength(shared.length);
  });
});

/** Un hôte en mémoire : juste assez du coffre pour ouvrir une session, lire
 * et écrire un item. Les règles elles-mêmes sont testées côté Rust
 * (`crates/guivault-local/tests/local.rs`). */
function memoryHost() {
  let coffre: (NewCoffre & { items: Item[]; revision: number }) | null = null;
  let opened = false;
  const closes = { count: 0 };
  const vault = (): Vault => ({
    id: coffre!.personal.id,
    kind: "personal",
    role: "owner",
    name_enc: coffre!.personal.name_enc,
    wrapped_vault_key: coffre!.personal.wrapped_vault_key,
    revision: coffre!.revision,
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
  });
  const host: LocalHost = {
    create: async (_path, c) => {
      coffre = { ...c, items: [], revision: 0 };
      opened = true;
    },
    open: async () => {
      if (!coffre) throw { status: 404, code: "local_not_found", message: "aucun coffre" };
      opened = true;
    },
    close: async () => {
      opened = false;
      closes.count++;
    },
    call: async (op, args) => {
      if (!opened || !coffre) throw { status: 500, code: "local_io", message: "fermé" };
      const user = { id: "coffre-1", email: "", public_key: coffre.account.public_key, created_at: "2026-10-20T00:00:00Z" };
      switch (op) {
        case "account": return coffre.account;
        case "changePassword": {
          Object.assign(coffre.account, args.req);
          return null;
        }
        case "me": return user;
        case "sync": return { user, vaults: [vault()], invitations: [], server_time: "2026-10-20T00:00:00Z" };
        case "manifest": return null;
        case "items": return { items: coffre.items, revision: coffre.revision };
        case "putItem": {
          const req = args.req as { item_type: string; ciphertext: string; base_revision?: number | null };
          // Le verrou optimiste du serveur : refusé avec la version courante.
          const existing = coffre.items.find((i) => i.id === args.id);
          if (existing && req.base_revision != null && req.base_revision !== existing.revision) {
            throw { status: 409, code: "revision_mismatch", message: "modifié entre-temps", current: existing };
          }
          coffre.revision++;
          const item: Item = { id: args.id as string, vault_id: args.vault as string, item_type: req.item_type, revision: coffre.revision, ciphertext: req.ciphertext, deleted: false, created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" };
          coffre.items = [...coffre.items.filter((i) => i.id !== item.id), item];
          return item;
        }
        default: throw { status: 501, code: "local_unsupported", message: op };
      }
    },
  };
  return { host, closes, raw: () => coffre };
}

describe("une session sur un coffre local", () => {
  it("se crée, se rouvre avec le mot de passe, et ne garde que des blobs", async () => {
    const { host, closes, raw } = memoryHost();
    const created = await createLocal(host, "/tmp/Mon coffre.guivault", "mot de passe maître");
    expect(created.local).toEqual({ path: "/tmp/Mon coffre.guivault" });
    expect(created.emergency).toBeNull();
    expect(created.vaults.map((v) => [v.name, v.role, v.keyFrom.kind])).toEqual([["Personnel", "owner", "self"]]);
    expect(isHttpTransport()).toBe(false);

    const payload = emptyPayload("note");
    if (payload.kind !== "note") throw new Error("note attendue");
    payload.note.name = "Code de la porte";
    await putPayload(created.vaults[0], payload);
    const stored = JSON.stringify(raw());
    expect(stored).not.toContain("Code de la porte");
    expect(stored).not.toContain("Personnel");

    await closeLocal();
    expect(isHttpTransport()).toBe(true);
    expect(closes.count).toBe(1);

    const reopened = await openLocal(host, "/tmp/Mon coffre.guivault", "mot de passe maître");
    const { items } = await loadItems(reopened.vaults[0]);
    expect(items).toHaveLength(1);
    expect(items[0].ok && items[0].payload.kind === "note" && items[0].payload.note.name).toBe("Code de la porte");
  }, 60_000);

  it("une petite écriture se rejoue sur la version d'un autre appareil", async () => {
    const { host } = memoryHost();
    const s = await createLocal(host, "/tmp/Conflit.guivault", "mot de passe maître");
    const v = s.vaults[0];
    const payload = emptyPayload("note");
    if (payload.kind !== "note") throw new Error("note attendue");
    payload.note.name = "Avant";
    const first = await putPayload(v, payload);
    // Un autre appareil la renomme pendant qu'on la regarde.
    await putPayload(v, { kind: "note", note: { ...payload.note, name: "Renommée ailleurs" } }, first.revision);
    // D'ici, on l'épingle d'après la version vue : rejoué, rien de perdu.
    const pin = (p: typeof payload) => (p.kind === "note" ? { ...p, note: { ...p.note, favorite: true } } : null);
    const written = await changeItem(v, { revision: first.revision, payload }, pin);
    expect(written && payloadEntity(written).name).toBe("Renommée ailleurs");
    const { items } = await loadItems(v);
    const it0 = items[0];
    expect(it0.ok && it0.payload.kind === "note" && [it0.payload.note.name, it0.payload.note.favorite]).toEqual(["Renommée ailleurs", true]);
  }, 60_000);

  it("rend lisibles les erreurs de l'hôte à la création et à l'ouverture", async () => {
    const { host } = memoryHost();
    await expect(openLocal(host, "/tmp/absent", "pw")).rejects.toThrowError("aucun coffre");
    const refusing: LocalHost = { ...host, create: async () => { throw { status: 409, code: "local_exists", message: "il y a déjà un coffre dans /tmp/c" }; } };
    const err = await createLocal(refusing, "/tmp/c", "pw").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect([err.code, err.message]).toEqual(["local_exists", "il y a déjà un coffre dans /tmp/c"]);
    expect(isHttpTransport()).toBe(true);
  }, 60_000);

  it("refuse un mauvais mot de passe, referme le coffre et rend api au serveur", async () => {
    const { host, closes } = memoryHost();
    await createLocal(host, "/tmp/c", "le bon");
    await closeLocal();
    await expect(openLocal(host, "/tmp/c", "pas le bon")).rejects.toThrowError("Mot de passe maître incorrect.");
    expect(closes.count).toBe(2);
    expect(isHttpTransport()).toBe(true);
  }, 60_000);

  it("change le mot de passe en exigeant l'ancien", async () => {
    const { host } = memoryHost();
    const state = await createLocal(host, "/tmp/c", "ancien");
    await expect(changePassword(state, "faux", "nouveau")).rejects.toThrowError("Mot de passe actuel incorrect.");
    await changePassword(state, "ancien", "nouveau");
    await closeLocal();
    await expect(openLocal(host, "/tmp/c", "ancien")).rejects.toThrowError("Mot de passe maître incorrect.");
    await openLocal(host, "/tmp/c", "nouveau");
  }, 120_000);
});
