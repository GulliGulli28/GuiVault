/** Les pièces jointes, côté web (`docs/PIECES-JOINTES.md`, crypto dans
 * `crypto.ts` › « Pièces jointes »). Chaque fichier a sa propre clé, tirée
 * ici, gardée dans l'item qui le porte (`SecretBase.attachments`) : le
 * serveur ne reçoit que des morceaux chiffrés, et ne sait ni leur nom ni leur
 * type. Un fichier s'envoie en entier avant d'être rattaché à l'item ; si
 * l'enregistrement de l'item échoue, il est effacé. */
import { api, ApiError } from "./api";
import { fromBase64, randomBytes, toBase64, uuid } from "./bytes";
import * as c from "./crypto";
import { decodeItem, payloadEntity, putPayload, RevisionConflict, type DecodedItem, type VaultView } from "./session";
import type { FileAttachment, Payload } from "./types";

/** La taille maximale annoncée par le serveur (chiffrée) ; `0` : désactivées. */
let limit: Promise<number> | null = null;
export function attachmentLimit(): Promise<number> {
  limit ??= api.health().then((h) => h.max_attachment_bytes ?? 0).catch(() => {
    limit = null;
    return 0;
  });
  return limit;
}

export function attachmentsOf(p: Payload): FileAttachment[] {
  return (payloadEntity(p).attachments as FileAttachment[] | undefined) ?? [];
}

/** Chiffre et envoie un fichier, morceau par morceau. `onProgress` : morceaux
 * envoyés sur le total. Rien n'est rattaché à l'item : voir `attachFile`. */
export async function uploadAttachment(vault: VaultView, itemId: string, file: File, onProgress?: (done: number, total: number) => void): Promise<FileAttachment> {
  const data = new Uint8Array(await file.arrayBuffer());
  const key = randomBytes(c.KEY_LEN);
  const id = uuid();
  const count = c.attachmentChunkCount(data.length);
  await api.createAttachment(vault.id, { id, item_id: itemId, size: c.attachmentSealedSize(data.length), chunks: count });
  try {
    for (let i = 0; i < count; i++) {
      const plain = data.subarray(i * c.ATTACHMENT_CHUNK, Math.min(data.length, (i + 1) * c.ATTACHMENT_CHUNK));
      await api.putAttachmentChunk(vault.id, id, i, c.sealAttachmentChunk(key, id, i, i === count - 1, plain));
      onProgress?.(i + 1, count);
    }
    await api.completeAttachment(vault.id, id);
  } catch (e) {
    void api.deleteAttachment(vault.id, id).catch(() => {});
    throw e;
  }
  return { id, name: file.name || "fichier", size: data.length, mime: file.type || null, key: toBase64(key) };
}

/** Télécharge et déchiffre ; par l'accès d'urgence pour un vault confié. Un
 * morceau manquant, déplacé ou altéré ne s'ouvre pas. */
export async function downloadAttachment(vault: VaultView, a: FileAttachment, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const key = fromBase64(a.key);
  const count = c.attachmentChunkCount(a.size);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const sealed = vault.emergency
      ? await api.emergencyAttachmentChunk(vault.emergency.grantId, vault.id, a.id, i)
      : await api.attachmentChunk(vault.id, a.id, i);
    parts.push(c.openAttachmentChunk(key, a.id, i, i === count - 1, sealed));
    onProgress?.(i + 1, count);
  }
  const size = parts.reduce((n, p) => n + p.length, 0);
  if (size !== a.size) throw new Error(`« ${a.name} » : ${size} octets reçus au lieu de ${a.size}`);
  return new Blob(parts as BlobPart[], { type: a.mime || "application/octet-stream" });
}

/** Propose le fichier à l'enregistrement. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Une petite modification de l'item (ajouter, retirer une pièce jointe) :
 * s'il a changé entre-temps, elle est rejouée sur la version du serveur —
 * elle ne touche qu'un champ, pas besoin de fusion. */
async function changeItem(vault: VaultView, item: DecodedItem & { ok: true }, change: (p: Payload) => void): Promise<void> {
  const edited = (p: Payload): Payload => {
    const copy = JSON.parse(JSON.stringify(p)) as Payload;
    change(copy);
    return copy;
  };
  try {
    await putPayload(vault, edited(item.payload), item.revision);
  } catch (e) {
    const cur = e instanceof RevisionConflict ? e.current : null;
    const theirs = cur && !cur.deleted ? decodeItem(vault, cur) : null;
    if (!theirs?.ok) throw e;
    await putPayload(vault, edited(theirs.payload), theirs.revision);
  }
}

/** Envoie le fichier et le rattache à l'item. */
export async function attachFile(vault: VaultView, item: DecodedItem & { ok: true }, file: File, onProgress?: (done: number, total: number) => void): Promise<FileAttachment> {
  const att = await uploadAttachment(vault, item.id, file, onProgress);
  try {
    await changeItem(vault, item, (p) => {
      const e = payloadEntity(p);
      e.attachments = [...((e.attachments as FileAttachment[] | undefined) ?? []), att];
    });
  } catch (e) {
    void api.deleteAttachment(vault.id, att.id).catch(() => {});
    throw e;
  }
  return att;
}

/** Détache le fichier de l'item, puis l'efface du serveur. */
export async function removeAttachment(vault: VaultView, item: DecodedItem & { ok: true }, attachmentId: string): Promise<void> {
  await changeItem(vault, item, (p) => {
    const e = payloadEntity(p);
    e.attachments = ((e.attachments as FileAttachment[] | undefined) ?? []).filter((a) => a.id !== attachmentId);
  });
  try {
    await api.deleteAttachment(vault.id, attachmentId);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
}

export function formatSize(bytes: number): string {
  const n = (v: number) => v.toLocaleString("fr-FR", { maximumFractionDigits: v < 10 ? 1 : 0 });
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${n(bytes / 1024)} Kio`;
  return `${n(bytes / (1024 * 1024))} Mio`;
}
