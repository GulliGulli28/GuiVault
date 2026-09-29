/** Les pièces jointes d'un secret, sous sa fiche (page du vault) : les
 * télécharger, en ajouter, en retirer. Chaque ajout ou retrait est une
 * écriture de l'item à lui seul (`lib/attachments.ts`), hors du formulaire
 * de modification. */
import { useCallback, useEffect, useRef, useState } from "react";
import { attachFile, attachmentLimit, attachmentsOf, downloadAttachment, formatSize, removeAttachment, saveBlob } from "../lib/attachments";
import { errorMessage } from "../lib/api";
import { attachmentSealedSize } from "../lib/crypto";
import type { DecodedItem, VaultView } from "../lib/session";
import type { FileAttachment } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconPaperclip } from "./secret-icons";
import { Eyebrow } from "./ui";
import { IconDownload, IconPlus, IconTrash } from "./ui-icons";

export function AttachmentsPanel({ vault, item, writable, onChanged, notify, error }: {
  vault: VaultView;
  item: DecodedItem & { ok: true };
  writable: boolean;
  onChanged: () => void;
  notify: (m: string) => void;
  error: (m: string) => void;
}) {
  const attachments = attachmentsOf(item.payload);
  const [limit, setLimit] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FileAttachment | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Stable : `useModalSurface` rend le focus à l'ouvreur quand `onClose` change.
  const cancelRemove = useCallback(() => setRemoving(null), []);
  useEffect(() => {
    void attachmentLimit().then(setLimit);
  }, []);
  const canAdd = writable && !vault.emergency && (limit ?? 0) > 0;
  if (attachments.length === 0 && !canAdd) return null;

  const progress = (verb: string, name: string) => (done: number, total: number) =>
    setBusy(total > 1 ? `${verb} « ${name} »… ${Math.round((done / total) * 100)} %` : `${verb} « ${name} »…`);

  const add = async (file: File) => {
    if (limit && attachmentSealedSize(file.size) > limit) {
      error(`« ${file.name} » dépasse la taille permise sur ce serveur (${formatSize(limit)}).`);
      return;
    }
    setBusy(`Envoi de « ${file.name} »…`);
    try {
      await attachFile(vault, item, file, progress("Envoi de", file.name));
      notify(`« ${file.name} » joint.`);
      onChanged();
    } catch (e) {
      error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const download = async (a: FileAttachment) => {
    setBusy(`Téléchargement de « ${a.name} »…`);
    try {
      saveBlob(await downloadAttachment(vault, a, progress("Téléchargement de", a.name)), a.name);
    } catch (e) {
      error(`« ${a.name} » : ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const a = removing;
    setRemoving(null);
    if (!a) return;
    setBusy(`Suppression de « ${a.name} »…`);
    try {
      await removeAttachment(vault, item, a.id);
      notify(`« ${a.name} » retiré.`);
      onChanged();
    } catch (e) {
      error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-5">
      <div className="mb-1 flex items-center gap-2">
        <Eyebrow>Pièces jointes</Eyebrow>
        {canAdd && (
          <>
            <button type="button" onClick={() => input.current?.click()} disabled={busy !== null} className="btn btn-ghost btn-sm ml-auto">
              <IconPlus size={11} /> Joindre un fichier
            </button>
            <input
              ref={input}
              type="file"
              className="hidden"
              aria-label="Fichier à joindre"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void add(f);
              }}
            />
          </>
        )}
      </div>
      {attachments.length === 0 ? (
        <p className="text-[12px] text-[var(--c-text-muted)]">
          Aucune. Un fichier est chiffré ici, sous une clé qui lui est propre, avant d'être envoyé{limit ? ` (${formatSize(limit)} au plus)` : ""}.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--c-border)]">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
              <IconPaperclip size={13} className="shrink-0 text-[var(--c-text-muted)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--c-text)]" title={a.name}>{a.name}</span>
              <span className="shrink-0 text-[11px] text-[var(--c-text-faint)]">{formatSize(a.size)}</span>
              <button type="button" onClick={() => void download(a)} disabled={busy !== null} className="btn btn-ghost btn-sm btn-icon" title="Télécharger" aria-label={`Télécharger ${a.name}`}>
                <IconDownload size={12} />
              </button>
              {writable && !vault.emergency && (
                <button type="button" onClick={() => setRemoving(a)} disabled={busy !== null} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Retirer" aria-label={`Retirer ${a.name}`}>
                  <IconTrash size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {busy && <p role="status" className="mt-1 text-[11.5px] text-[var(--c-text-muted)]">{busy}</p>}
      {removing && (
        <ConfirmDialog
          title={`Retirer « ${removing.name} » ?`}
          message="Le fichier est effacé du serveur : une version précédente de l'élément qui le mentionne ne pourra plus l'ouvrir."
          confirmLabel="Retirer"
          danger
          onConfirm={() => void remove()}
          onCancel={cancelRemove}
        />
      )}
    </section>
  );
}
