/** Exports d'un vault : JSON GuiVault (tout, en clair ou chiffré par un mot
 * de passe) et CSV Bitwarden (identifiants et notes seulement). */
import { randomBytes, toBase64, utf8 } from "./bytes";
import { toBitwardenCsvRows, BITWARDEN_CSV_HEADER } from "./bitwarden";
import { toCsv } from "./csv";
import * as c from "./crypto";
import { groupPath } from "./entities";
import { GUIVAULT_ENCRYPTED_FORMAT, GUIVAULT_FORMAT, type GuiVaultEncryptedExport, type GuiVaultExport } from "./importers";
import type { Group, Payload } from "./types";

export function exportJson(vault: { id: string; name: string }, payloads: Payload[]): string {
  const groups = payloads.flatMap((p) => (p.kind === "group" ? [p.group] : []));
  const doc: GuiVaultExport = { format: GUIVAULT_FORMAT, version: 1, exportedAt: new Date().toISOString(), vault, groups, items: payloads };
  return JSON.stringify(doc, null, 2);
}

export async function exportEncrypted(vault: { id: string; name: string }, payloads: Payload[], password: string): Promise<string> {
  const kdf = c.DEFAULT_KDF;
  const salt = randomBytes(c.SALT_LEN);
  const key = await c.deriveExportKey(password, salt, kdf);
  const blob = c.seal(key, utf8.encode(exportJson(vault, payloads)), c.AAD_EXPORT);
  key.fill(0);
  const doc: GuiVaultEncryptedExport = { format: GUIVAULT_ENCRYPTED_FORMAT, version: 1, kdf, kdf_salt: toBase64(salt), blob: toBase64(blob) };
  return JSON.stringify(doc, null, 2);
}

export function exportCsv(payloads: Payload[]): { csv: string; skipped: number } {
  const groups = new Map(payloads.flatMap((p) => (p.kind === "group" ? [[p.group.id, p.group] as [string, Group]] : [])));
  const items = payloads.filter((p) => p.kind !== "group").map((payload) => {
    const groupId = payload.kind === "login" ? payload.login.groupId : payload.kind === "note" ? payload.note.groupId : null;
    return { payload, folderPath: groupId ? groupPath(groups, groupId).split(" / ") : [] };
  });
  const { rows, skipped } = toBitwardenCsvRows(items);
  return { csv: toCsv(BITWARDEN_CSV_HEADER, rows), skipped };
}

/** Déclenche le téléchargement d'un fichier texte. */
export function download(filename: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
