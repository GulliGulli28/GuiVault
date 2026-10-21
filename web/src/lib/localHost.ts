/** Le coffre local de l'app (`docs/APP.md`) vu de l'interface : un transport
 * qui remplace HTTP (`api.setTransport`), adossé à un **hôte** — la commande
 * Tauri de l'app, qui ouvre le dossier avec le crate `guivault-local`.
 *
 * Le contrat avec l'hôte : une opération par méthode d'`api` (liste dans
 * `crates/guivault-local/ops.json`, vérifiée des deux côtés), avec **les
 * mêmes corps JSON que l'API HTTP**. L'hôte ne voit que des blobs : la
 * crypto reste dans `session.ts`, comme face au serveur. Ses erreurs ont la
 * forme de celles du serveur (`{ status, code, message, …extra }`) et
 * redeviennent des `ApiError` : un conflit se fusionne pareil. */
import { ApiError, type Transport } from "./api";
import { fromBase64, toBase64 } from "./bytes";
import type { KdfParams } from "./crypto";

/** Ce que l'hôte garde du compte : comme `AccountBlobs`, plus la clé
 * publique. Pas de clé d'authentification — personne à qui la présenter. */
export interface LocalAccount {
  kdf: KdfParams;
  kdf_salt: string;
  protected_user_key: string;
  public_key: string;
  protected_private_key: string;
}

/** Le contenu d'un coffre neuf : le compte, et le vault personnel. */
export interface NewCoffre {
  account: LocalAccount;
  personal: { id: string; name_enc: string; wrapped_vault_key: string };
}

export type LocalOp =
  | "health" | "account" | "changePassword" | "me" | "sync" | "settings" | "putSettings"
  | "vault" | "createVault" | "renameVault" | "deleteVault"
  | "items" | "putItem" | "deleteItem" | "manifest" | "putManifest" | "importItems"
  | "itemVersions" | "vaultVersions" | "trash" | "purgeTrashItem" | "emptyTrash"
  | "attachments" | "createAttachment" | "putAttachmentChunk" | "completeAttachment" | "attachmentChunk" | "deleteAttachment" | "moveAttachment";

/** L'hôte : Tauri dans l'app, un faux en mémoire dans les tests. Un coffre
 * ouvert à la fois. */
export interface LocalHost {
  create(path: string, coffre: NewCoffre): Promise<void>;
  open(path: string): Promise<void>;
  close(): Promise<void>;
  /** Rejette avec `{ status, code, message, …extra }`. */
  call(op: LocalOp, args: Record<string, unknown>): Promise<unknown>;
}

/** Une erreur de l'hôte, rendue comme celle du serveur. */
export function toApiError(e: unknown): unknown {
  if (e instanceof ApiError || typeof e !== "object" || e === null) return e;
  const { status, code, message, ...extra } = e as Record<string, unknown>;
  if (typeof status !== "number" || typeof code !== "string") return e;
  return new ApiError(status, code, typeof message === "string" ? message : code, extra);
}

/** Le transport local : les méthodes d'`api` qui ont un sens sans serveur.
 * Les autres manquent, et `api` répond `501 local_unsupported`. */
export function localTransport(host: LocalHost): Partial<Transport> {
  const call = async <T>(op: LocalOp, args: Record<string, unknown> = {}): Promise<T> => {
    try {
      return (await host.call(op, args)) as T;
    } catch (e) {
      throw toApiError(e);
    }
  };
  return {
    // Ce que le coffre offre (`HealthResponse`) : la taille des pièces
    // jointes, et ni liens, ni relais du rapport de santé, ni passkeys.
    health: () => call("health"),
    me: () => call("me"),
    sync: () => call("sync"),
    settings: () => call("settings"),
    putSettings: (blob, base_revision) => call("putSettings", { req: { blob, base_revision } }),

    vault: (vault) => call("vault", { vault }),
    createVault: (req) => call("createVault", { req }),
    renameVault: (vault, name_enc) => call("renameVault", { vault, req: { name_enc } }),
    deleteVault: (vault) => call("deleteVault", { vault }),

    items: (vault, since) => call("items", { vault, since }),
    putItem: (vault, id, req) => call("putItem", { vault, id, req }),
    deleteItem: (vault, id, opts = {}) => call("deleteItem", { vault, id, moved: opts.moved ?? false, req: opts.manifest ? { manifest: opts.manifest } : undefined }),
    manifest: (vault) => call("manifest", { vault }),
    putManifest: (vault, req) => call("putManifest", { vault, req }),
    importItems: (vault, req) => call("importItems", { vault, req }),
    itemVersions: (vault, id) => call("itemVersions", { vault, id }),
    vaultVersions: (vault) => call("vaultVersions", { vault }),
    trash: (vault) => call("trash", { vault }),
    purgeTrashItem: (vault, id) => call("purgeTrashItem", { vault, id }),
    emptyTrash: (vault) => call("emptyTrash", { vault }),

    attachments: (vault, item) => call("attachments", { vault, item }),
    createAttachment: (vault, req) => call("createAttachment", { vault, req }),
    putAttachmentChunk: async (vault, id, index, bytes) => {
      await call("putAttachmentChunk", { vault, id, index, bytes: toBase64(bytes) });
      return new Uint8Array();
    },
    completeAttachment: (vault, id) => call("completeAttachment", { vault, id }),
    attachmentChunk: async (vault, id, index) => fromBase64(await call<string>("attachmentChunk", { vault, id, index })),
    deleteAttachment: (vault, id) => call("deleteAttachment", { vault, id }),
    moveAttachment: (vault, id, req) => call("moveAttachment", { vault, id, req }),
  };
}

/** Le nom d'un coffre : son dossier, sans `.guivault`, quel que soit le
 * séparateur (Windows ou non). */
export function coffreName(path: string): string {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  return name.replace(/\.guivault$/i, "") || path;
}

/** Créer, ouvrir : les erreurs de l'hôte (`local_exists`,
 * `local_not_found`…) redeviennent des `ApiError`, avec leur message. */
export async function localCreate(host: LocalHost, path: string, coffre: NewCoffre): Promise<void> {
  try {
    await host.create(path, coffre);
  } catch (e) {
    throw toApiError(e);
  }
}

export async function localOpen(host: LocalHost, path: string): Promise<void> {
  try {
    await host.open(path);
  } catch (e) {
    throw toApiError(e);
  }
}

/** Les opérations propres au local (pas des routes du serveur). */
export async function localAccount(host: LocalHost): Promise<LocalAccount> {
  try {
    return (await host.call("account", {})) as LocalAccount;
  } catch (e) {
    throw toApiError(e);
  }
}

export async function localChangePassword(host: LocalHost, req: { kdf: KdfParams; kdf_salt: string; protected_user_key: string }): Promise<void> {
  try {
    await host.call("changePassword", { req });
  } catch (e) {
    throw toApiError(e);
  }
}
