import { useCallback, useMemo, useState } from "react";
import type { PageContext } from "../App";
import { parseTags, runBulk, withFavorite, withTags, type BulkResult } from "../lib/bulk";
import { groupPath, withParent, type VaultIndex } from "../lib/entities";
import { plural, t } from "../lib/i18n";
import { isProtected, markUnlocked, needsReprompt } from "../lib/reprompt";
import { changeItem, deleteItem, moveItem, payloadEntity, payloadName, type DecodedItem, type VaultView } from "../lib/session";
import type { Payload } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { useReprompt } from "./Reprompt";
import { IconDots, IconStar } from "./secret-icons";
import { ExportSection } from "./ToolsPage";
import { IconClose, IconDownload, IconFolder, IconTrash } from "./ui-icons";
import { Dropdown, Field, Modal } from "./ui";

type Dialog = "delete" | "move" | "tags" | "export" | null;

/** La barre de la multisélection, au-dessus de la liste d'un vault : combien
 * d'éléments sont cochés, et ce qu'on peut leur faire d'un coup — supprimer
 * (vers la corbeille), déplacer (dossier ou autre vault), épingler,
 * étiquettes, exporter. Une écriture par élément, l'une après l'autre
 * (`runBulk`) ; un vault en lecture seule n'offre que l'export. */
export function BulkBar({ ctx, vault, index, picked, visibleCount, writable, otherVaults, onAll, onClear, onChanged }: {
  ctx: PageContext;
  vault: VaultView;
  index: VaultIndex;
  /** Les éléments cochés, lisibles ou non. */
  picked: DecodedItem[];
  /** Combien d'éléments la liste montre (pour « tout cocher »). */
  visibleCount: number;
  writable: boolean;
  otherVaults: VaultView[];
  onAll: () => void;
  onClear: () => void;
  /** Après une action : recharger, et vider la sélection. */
  onChanged: () => Promise<void>;
}) {
  const ask = useReprompt();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = useCallback(() => setDialog(null), []);
  const [progress, setProgress] = useState<{ label: string; n: number; of: number } | null>(null);
  const readable = useMemo(() => picked.filter((i): i is DecodedItem & { ok: true } => i.ok), [picked]);
  const n = picked.length;

  /** Une action sur toute la sélection, puis le compte rendu. */
  const run = async <T,>(label: string, targets: T[], name: (t: T) => string, op: (t: T) => Promise<boolean>, said: (r: BulkResult) => string) => {
    setDialog(null);
    setProgress({ label, n: 0, of: targets.length });
    const r = await runBulk(targets, name, op, (i) => setProgress({ label, n: i, of: targets.length }));
    setProgress(null);
    if (r.done || !r.failed.length) ctx.notify(said(r) + (r.skipped ? " " + plural(r.skipped, "{0} non concerné.", "{0} non concernés.") : ""));
    if (r.failed.length) ctx.error(plural(r.failed.length, "{0} échec : {1}", "{0} échecs, dont : {1}", `${r.failed[0].name} — ${r.failed[0].error}`));
    await onChanged();
  };

  const favorite = (on: boolean) =>
    void run(
      on ? t("Épinglage…") : t("Retrait…"),
      readable,
      (i) => payloadName(i.payload),
      async (i) => !!(await changeItem(vault, i, (p) => withFavorite(p, on))),
      (r) => on ? plural(r.done, "{0} élément épinglé.", "{0} éléments épinglés.") : plural(r.done, "{0} élément retiré des épinglés.", "{0} éléments retirés des épinglés."),
    );

  const remove = () =>
    void run(
      t("Suppression…"),
      picked,
      (i) => (i.ok ? payloadName(i.payload) : i.id.slice(0, 8)),
      async (i) => { await deleteItem(vault, i.id); return true; },
      (r) => plural(r.done, "{0} élément supprimé (dans la corbeille).", "{0} éléments supprimés (dans la corbeille)."),
    );

  /** Exporter montre les secrets : le mot de passe maître d'abord si un
   * élément est protégé — une fois pour toute la sélection. */
  const openExport = async () => {
    const locked = readable.find((i) => needsReprompt(i.payload));
    if (locked && !(await ask(locked.payload))) return;
    for (const i of readable) if (isProtected(i.payload)) markUnlocked(i.id);
    setDialog("export");
  };

  if (progress) {
    return (
      <div className="flex min-h-11 shrink-0 items-center gap-3 border-b border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-2" role="status">
        <span className="text-[13px] text-[var(--c-text-muted)]">{progress.label}</span>
        <span className="text-[13px] tabular-nums">{progress.n} / {progress.of}</span>
      </div>
    );
  }

  return (
    <>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--c-border)] bg-[var(--c-surface)] px-3 py-1.5" role="toolbar" aria-label={t("Sélection")}>
        <input
          type="checkbox"
          checked={n > 0 && n >= visibleCount}
          ref={(el) => { if (el) el.indeterminate = n > 0 && n < visibleCount; }}
          onChange={() => (n >= visibleCount ? onClear() : onAll())}
          aria-label={n >= visibleCount ? t("Tout décocher") : t("Tout cocher")}
          title={n >= visibleCount ? t("Tout décocher") : t("Tout cocher")}
          className="ml-1"
        />
        <span className="min-w-0 flex-1 truncate pl-1 text-[13px] font-medium" aria-live="polite">{n ? plural(n, "{0} sélectionné", "{0} sélectionnés") : t("Cochez des éléments")}</span>
        {writable && (
          <>
            <button onClick={() => setDialog("move")} disabled={!n} className="btn btn-ghost btn-sm" title={t("Déplacer vers un dossier ou un autre vault")}><IconFolder size={13} /> <span className="max-sm:hidden">{t("Déplacer")}</span></button>
            <button onClick={() => setDialog("delete")} disabled={!n} className="btn btn-ghost btn-sm text-[var(--c-danger-text)]" title={t("Supprimer (vers la corbeille)")}><IconTrash size={13} /> <span className="max-sm:hidden">{t("Supprimer")}</span></button>
          </>
        )}
        <Dropdown
          label={t("Autres actions")}
          className="w-56"
          trigger={({ open, toggle }) => <button onClick={toggle} disabled={!n} aria-expanded={open} aria-haspopup="menu" className="btn btn-ghost btn-sm btn-icon" title={t("Autres actions")} aria-label={t("Autres actions")}><IconDots size={15} /></button>}
        >
          {(closeMenu) => (
            <>
              {writable && <button role="menuitem" className="menu-item" onClick={() => { closeMenu(); favorite(true); }}><IconStar size={14} /> {t("Épingler")}</button>}
              {writable && <button role="menuitem" className="menu-item" onClick={() => { closeMenu(); favorite(false); }}><IconStar size={14} filled /> {t("Retirer des épinglés")}</button>}
              {writable && <button role="menuitem" className="menu-item" onClick={() => { closeMenu(); setDialog("tags"); }}><span aria-hidden="true" className="w-[14px] text-center">#</span> {t("Étiquettes…")}</button>}
              <button role="menuitem" className="menu-item" onClick={() => { closeMenu(); void openExport(); }}><IconDownload size={14} /> {t("Exporter…")}</button>
            </>
          )}
        </Dropdown>
        <button onClick={onClear} className="btn btn-ghost btn-sm btn-icon" title={t("Quitter la sélection (Échap)")} aria-label={t("Quitter la sélection")}><IconClose size={13} /></button>
      </div>

      {dialog === "delete" && (
        <ConfirmDialog
          title={plural(n, "Supprimer {0} élément ?", "Supprimer {0} éléments ?")}
          message={t("Chaque appareil synchronisé les retire à son tour. Ils restent dans la corbeille du vault, d'où ils peuvent être restaurés.")}
          confirmLabel={t("Supprimer")}
          danger
          onConfirm={remove}
          onCancel={close}
        />
      )}
      {dialog === "move" && <MoveDialog vault={vault} index={index} count={readable.length} otherVaults={otherVaults} onClose={close} onMove={(dest) => {
        if (dest.kind === "folder") {
          const label = dest.folderId ? groupPath(new Map(index.groups.map((g) => [g.id, g])), dest.folderId) : t("la racine");
          void run(t("Rangement…"), readable, (i) => payloadName(i.payload), async (i) => {
            const next = withParent(i.payload, dest.folderId);
            if (!next || (payloadEntity(i.payload).groupId ?? null) === dest.folderId) return false;
            return !!(await changeItem(vault, i, (p) => withParent(p, dest.folderId)));
          }, (r) => plural(r.done, "{0} élément rangé dans « {1} ».", "{0} éléments rangés dans « {1} ».", label));
        } else {
          const to = dest.vault;
          void run(t("Déplacement…"), readable, (i) => payloadName(i.payload), async (i) => {
            // Un dossier ne quitte pas son vault d'ici : son contenu resterait.
            if (i.payload.kind === "group") return false;
            await moveItem(vault, to, i);
            return true;
          }, (r) => plural(r.done, "{0} élément déplacé vers « {1} ».", "{0} éléments déplacés vers « {1} ».", to.name));
        }
      }} />}
      {dialog === "tags" && <TagsDialog items={readable.map((i) => i.payload)} onClose={close} onApply={(add, removeTags) =>
        void run(t("Étiquettes…"), readable, (i) => payloadName(i.payload), async (i) => !!(await changeItem(vault, i, (p) => withTags(p, add, removeTags))),
          (r) => plural(r.done, "{0} élément modifié.", "{0} éléments modifiés."))
      } />}
      {dialog === "export" && (
        <Modal title={plural(readable.length, "Exporter {0} élément", "Exporter {0} éléments")} onClose={close} wide>
          <ExportSection ctx={ctx} vault={vault} items={picked} />
        </Modal>
      )}
    </>
  );
}

type MoveDest = { kind: "folder"; folderId: string | null } | { kind: "vault"; vault: VaultView };

/** Où déplacer la sélection : un dossier de ce vault (ou sa racine), ou un
 * autre vault où l'on peut écrire — re-chiffré sous sa clé. */
function MoveDialog({ vault, index, count, otherVaults, onClose, onMove }: { vault: VaultView; index: VaultIndex; count: number; otherVaults: VaultView[]; onClose: () => void; onMove: (d: MoveDest) => void }) {
  const folders = useMemo(() => {
    const byId = new Map(index.groups.map((g) => [g.id, g]));
    return index.groups.map((g) => ({ id: g.id, path: groupPath(byId, g.id) })).sort((a, b) => a.path.localeCompare(b.path));
  }, [index.groups]);
  const [choice, setChoice] = useState("folder:");
  const dest: MoveDest = choice.startsWith("vault:")
    ? { kind: "vault", vault: otherVaults.find((v) => `vault:${v.id}` === choice)! }
    : { kind: "folder", folderId: choice.slice("folder:".length) || null };
  return (
    <Modal title={plural(count, "Déplacer {0} élément", "Déplacer {0} éléments")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label={t("Destination")}>
          <select value={choice} onChange={(e) => setChoice(e.target.value)} className="input">
            <optgroup label={vault.name}>
              <option value="folder:">{t("Racine du vault")}</option>
              {folders.map((f) => <option key={f.id} value={`folder:${f.id}`}>{f.path}</option>)}
            </optgroup>
            {otherVaults.length > 0 && (
              <optgroup label={t("Autre vault")}>
                {otherVaults.map((v) => <option key={v.id} value={`vault:${v.id}`}>{v.name}</option>)}
              </optgroup>
            )}
          </select>
        </Field>
        {dest.kind === "vault" && (
          <p className="callout callout-warn">
            {t("Re-chiffrés sous la clé de {0} et retirés d'ici, pièces jointes comprises. Ce qu'ils référencent (dossier, clé du trousseau, relais) ne suit pas ; les dossiers restent ici.", dest.vault.name)}
            {dest.vault.kind === "shared" ? " " + t("Tous les membres de ce vault pourront les lire, secrets compris.") : ""}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">{t("Annuler")}</button>
          <button onClick={() => onMove(dest)} className="btn btn-primary">{t("Déplacer")}</button>
        </div>
      </div>
    </Modal>
  );
}

/** Ajouter des étiquettes à toute la sélection, ou retirer celles qu'elle
 * porte déjà. */
function TagsDialog({ items, onClose, onApply }: { items: Payload[]; onClose: () => void; onApply: (add: string[], remove: string[]) => void }) {
  const [text, setText] = useState("");
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const present = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of items) {
      const tags = payloadEntity(p).tags;
      if (Array.isArray(tags)) for (const tag of tags) if (typeof tag === "string" && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [items]);
  const add = parseTags(text);
  const toggle = (tag: string) => setRemoving((prev) => {
    const next = new Set(prev);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    return next;
  });
  return (
    <Modal title={t("Étiquettes de la sélection")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label={t("Ajouter")} hint={t("Séparées par des virgules.")}>
          <input value={text} onChange={(e) => setText(e.target.value)} className="input" placeholder={t("prod, client A")} autoFocus />
        </Field>
        {present.length > 0 && (
          <Field label={t("Retirer")} group>
            <div className="flex flex-wrap gap-1.5">
              {present.map((tag) => (
                <button key={tag} type="button" onClick={() => toggle(tag)} aria-pressed={removing.has(tag)} className={`tag ${removing.has(tag) ? "line-through opacity-60" : ""}`}>{tag}</button>
              ))}
            </div>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-ghost">{t("Annuler")}</button>
          <button onClick={() => onApply(add, [...removing])} disabled={!add.length && !removing.size} className="btn btn-primary">{t("Appliquer")}</button>
        </div>
      </div>
    </Modal>
  );
}
