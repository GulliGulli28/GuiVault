/** Les pièces jointes d'un secret, sous sa fiche (page du vault, et popup de
 * l'extension en lecture seule — un sélecteur de fichier y ferme le popup) :
 * les télécharger, en ajouter, en retirer. Chaque ajout ou retrait est une
 * écriture de l'item à lui seul (`lib/attachments.ts`), hors du formulaire
 * de modification. Hors ligne (`offline`), la liste seulement : les
 * fichiers ne sont pas dans la copie. */
import { useCallback, useEffect, useRef, useState } from "react";
import { attachFile, attachmentLimit, attachmentsOf, downloadAttachment, formatSize, removeAttachment, saveBlob } from "../lib/attachments";
import { errorMessage, supports } from "../lib/api";
import { attachmentSealedSize } from "../lib/crypto";
import type { DecodedItem, SessionState, VaultView } from "../lib/session";
import type { FileAttachment } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconLink, IconPaperclip } from "./secret-icons";
import { ShareLinkDialog } from "./SendsPage";
import { Eyebrow } from "./ui";
import { IconDownload, IconPlus, IconTrash, IconUpload } from "./ui-icons";
import { t } from "../lib/i18n";

export function AttachmentsPanel({ vault, item, writable, offline = false, session, onChanged, notify, error }: {
  vault: VaultView;
  item: DecodedItem & { ok: true };
  writable: boolean;
  offline?: boolean;
  /** Pour proposer « Partager par lien » (page du vault). */
  session?: SessionState;
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
  const [sharing, setSharing] = useState<File | null>(null);
  const closeSharing = useCallback(() => setSharing(null), []);
  useEffect(() => {
    void attachmentLimit().then(setLimit);
  }, []);
  const canAdd = writable && !offline && !vault.emergency && (limit ?? 0) > 0;
  if (attachments.length === 0 && !canAdd) return null;

  const progress = (verb: string, name: string) => (done: number, total: number) =>
    setBusy(total > 1 ? `${verb} « ${name} »… ${Math.round((done / total) * 100)} %` : `${verb} « ${name} »…`);

  const add = async (file: File) => {
    if (limit && attachmentSealedSize(file.size) > limit) {
      error(t("« {0} » dépasse la taille permise sur ce serveur ({1}).", file.name, formatSize(limit)));
      return;
    }
    setBusy(t("Envoi de « {0} »…", file.name));
    try {
      await attachFile(vault, item, file, progress(t("Envoi de"), file.name));
      notify(t("« {0} » joint.", file.name));
      onChanged();
    } catch (e) {
      error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const download = async (a: FileAttachment) => {
    setBusy(t("Téléchargement de « {0} »…", a.name));
    try {
      saveBlob(await downloadAttachment(vault, a, progress(t("Téléchargement de"), a.name)), a.name);
    } catch (e) {
      error(`« ${a.name} » : ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  /** Un lien de partage avec ce fichier : déchiffré ici, rechiffré sous la
   * clé du lien. */
  const share = async (a: FileAttachment) => {
    setBusy(t("Préparation de « {0} »…", a.name));
    try {
      const blob = await downloadAttachment(vault, a, progress(t("Préparation de"), a.name));
      setSharing(new File([blob], a.name, { type: a.mime || "application/octet-stream" }));
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
    setBusy(t("Suppression de « {0} »…", a.name));
    try {
      await removeAttachment(vault, item, a.id);
      notify(t("« {0} » retiré.", a.name));
      onChanged();
    } catch (e) {
      error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="mb-2 flex min-h-7 items-center gap-2">
        <Eyebrow>{t("Pièces jointes")}</Eyebrow>
        {canAdd && (
          <>
            {attachments.length > 0 && (
              <button type="button" onClick={() => input.current?.click()} disabled={busy !== null} className="btn btn-ghost btn-sm ml-auto">
                <IconPlus size={13} /> {t("Joindre un fichier")}
              </button>
            )}
            <input
              ref={input}
              type="file"
              className="hidden"
              aria-label={t("Fichier à joindre")}
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
        canAdd ? (
          <button type="button" onClick={() => input.current?.click()} disabled={busy !== null} className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-[var(--c-border-strong)] bg-[var(--c-surface)] px-5 py-5 text-center hover:border-[var(--c-accent)]">
            <IconUpload size={18} className="text-[var(--c-text-muted)]" />
            <span className="text-[13.5px] font-medium">{t("Joindre un fichier")}</span>
            <span className="text-[12.5px] text-[var(--c-text-muted)]">{limit ? t("{0} max · ", formatSize(limit)) : ""}{t("chiffré avant l'envoi")}</span>
          </button>
        ) : (
          <p className="text-[13px] text-[var(--c-text-muted)]">{t("Aucune.")}</p>
        )
      ) : (
        <ul className="card divide-y divide-[var(--c-border)]">
          {attachments.map((a) => (
            <li key={a.id} className="flex min-w-0 items-center gap-2.5 px-[18px] py-2.5 text-[13.5px]">
              <IconPaperclip size={15} className="shrink-0 text-[var(--c-text-muted)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--c-text)]" title={a.name}>{a.name}</span>
              <span className="shrink-0 text-[12px] text-[var(--c-text-muted)]">{formatSize(a.size)}</span>
              {session && !offline && supports("createSend") && (
                <button type="button" onClick={() => void share(a)} disabled={busy !== null} className="btn btn-ghost btn-icon" title={t("Partager par lien : une copie chiffrée, qui expire")} aria-label={t("Partager {0} par lien", a.name)}>
                  <IconLink size={14} />
                </button>
              )}
              <button type="button" onClick={() => void download(a)} disabled={busy !== null || offline} className="btn btn-ghost btn-icon" title={offline ? t("Hors ligne : les fichiers ne sont pas dans la copie") : t("Télécharger")} aria-label={t("Télécharger {0}", a.name)}>
                <IconDownload size={14} />
              </button>
              {writable && !offline && !vault.emergency && (
                <button type="button" onClick={() => setRemoving(a)} disabled={busy !== null} className="btn btn-ghost btn-icon hover:text-[var(--c-danger)]" title={t("Retirer")} aria-label={t("Retirer {0}", a.name)}>
                  <IconTrash size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {offline && attachments.length > 0 && <p className="mt-1.5 text-[12.5px] text-[var(--c-text-muted)]">{t("Hors ligne : les fichiers sont sur le serveur, pas dans la copie.")}</p>}
      {busy && <p role="status" className="mt-1.5 text-[12.5px] text-[var(--c-text-muted)]">{busy}</p>}
      {sharing && session && <ShareLinkDialog session={session} file={sharing} onClose={closeSharing} />}
      {removing && (
        <ConfirmDialog
          title={t("Retirer « {0} » ?", removing.name)}
          message={t("Effacé du serveur : les anciennes versions de l'élément ne l'ouvriront plus.")}
          confirmLabel={t("Retirer")}
          danger
          onConfirm={() => void remove()}
          onCancel={cancelRemove}
        />
      )}
    </section>
  );
}
