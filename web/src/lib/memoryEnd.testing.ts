/** Un serveur (ou un coffre local) en mémoire, qui suit les règles du vrai
 * (historique, corbeille, import, pièces jointes) mais ne fait aucune crypto :
 * partagé par `transfer.test.ts` et `coffreSync.test.ts`. */
import { ApiError, type Transport } from "./api";
import { fromBase64, toBase64, utf8, uuid, randomBytes } from "./bytes";
import * as c from "./crypto";
import type { LocalHost, LocalOp, NewCoffre } from "./localHost";
import type { TransferVault } from "./transfer";
import type { SessionState } from "./session";
import type { ImportItemsRequest, Item, ItemVersion, ServerAttachment, TrashedItem, Vault, VaultManifest } from "./types";

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
export function memoryEnd(publicKey = "") {
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
export async function populated(password: string) {
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

export function openNote(key: Uint8Array, vaultId: string, itemId: string, ct: string) {
  return new TextDecoder().decode(c.openItem(key, vaultId, itemId, "note", unb64(ct)));
}


/** Un hôte de coffre local au-dessus d'une extrémité en mémoire. */
export function memoryHost() {
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
        case "putItem": return e.putItem(args.vault, args.id, args.req);
        case "deleteItem": return e.deleteItem(args.vault, args.id, args.req);
        case "vaultVersions": return e.vaultVersions(args.vault);
        case "trash": return e.trash(args.vault);
        case "attachmentChunk": return b64((await e.attachmentChunk(args.vault, args.id, args.index)) as Uint8Array);
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

export function sessionOf(src: Awaited<ReturnType<typeof populated>>): SessionState {
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

