/** La corbeille d'un vault : les éléments supprimés depuis moins de
 * `GUIVAULT_TRASH_DAYS` jours, avec leur dernière version — gardée chiffrée
 * par le serveur (`routes::history`). Restaurer, c'est la renvoyer telle
 * quelle (l'élément est recréé) ; la supprimer définitivement efface ses
 * versions. */
import { useCallback, useEffect, useState } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { indexItems, type VaultIndex } from "../lib/entities";
import { navigate } from "../lib/route";
import { decodeVersion, loadItems, payloadName, restoreVersion, type DecodedItem, type VaultView } from "../lib/session";
import { canWrite, KIND_LABELS, type ItemKind, type TrashedItem } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { ItemView } from "./ItemView";
import { KIND_ICONS } from "./ItemTree";
import { formatWhen, Loading } from "./ui";

export function TrashPage({ ctx, vaultId }: { ctx: PageContext; vaultId: string }) {
  const vault = ctx.session.vaults.find((v) => v.id === vaultId);
  if (!vault) return <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Ce vault n'existe pas (ou plus).</p>;
  return <Body key={vault.id} ctx={ctx} vault={vault} />;
}

type Entry = { t: TrashedItem; decoded: DecodedItem };
type Confirm = null | { kind: "purge"; entry: Entry } | { kind: "empty" };

function Body({ ctx, vault }: { ctx: PageContext; vault: VaultView }) {
  const writable = canWrite(vault.role);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [index, setIndex] = useState<VaultIndex>(() => indexItems([]));
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const tick = ctx.vaultTicks[vault.id] ?? 0;

  const load = useCallback(async () => {
    try {
      // Le contenu vivant sert aux références (dossier, clé, relais) de la fiche.
      const [trash, live] = await Promise.all([api.trash(vault.id), loadItems(vault)]);
      setEntries(trash.map((t) => ({ t, decoded: decodeVersion(vault, t, t.deleted_at) })));
      setIndex(indexItems(live.items));
    } catch (e) {
      ctx.error(errorMessage(e));
      setEntries([]);
    }
    // `vault` change d'identité à chaque `/sync` : seul son id compte ici.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.id, ctx.error]);
  useEffect(() => { void load(); }, [load, tick]);

  const act = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await f();
      ctx.notify(done);
      setSelected(null);
      await load();
    } catch (e) {
      ctx.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (e: Entry) => (e.decoded.ok ? payloadName(e.decoded.payload) : `élément illisible (${e.t.item_id.slice(0, 8)})`);
  const current = entries?.find((e) => e.t.item_id === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-11">
        <button onClick={() => navigate({ page: "vault", id: vault.id })} className="btn btn-ghost btn-sm">← {vault.name}</button>
        <h1 className="text-[14px] font-semibold text-[var(--c-text)]">Corbeille</h1>
        {entries && entries.length > 0 && <span className="text-[11px] text-[var(--c-text-faint)]">{entries.length} élément(s)</span>}
        {writable && entries && entries.length > 0 && (
          <button onClick={() => setConfirm({ kind: "empty" })} disabled={busy} className="btn btn-danger btn-sm ml-auto">Vider la corbeille</button>
        )}
      </header>

      {entries === null ? (
        <div className="p-6"><Loading /></div>
      ) : entries.length === 0 ? (
        <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">La corbeille est vide. Un élément supprimé y reste un temps, chiffré comme le reste du vault, avant d'être effacé pour de bon.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ul className={`sidebar-scroll shrink-0 overflow-y-auto border-[var(--c-border)] p-2 md:w-80 md:border-r ${current ? "max-md:hidden" : ""}`} aria-label="Éléments supprimés">
            {entries.map((e) => {
              const kind = (e.decoded.ok ? e.decoded.payload.kind : e.t.item_type) as ItemKind;
              const Icon = KIND_ICONS[kind as keyof typeof KIND_ICONS];
              return (
                <li key={e.t.item_id}>
                  <button onClick={() => setSelected(e.t.item_id)} data-active={e.t.item_id === selected ? "true" : undefined} className="list-row w-full py-1.5 text-left">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]">{Icon ? <Icon size={12} /> : null}</span>
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-[12.5px] text-[var(--c-text)]">{nameOf(e)}</span>
                      <span className="truncate text-[11px] text-[var(--c-text-muted)]">
                        {KIND_LABELS[kind] ?? e.t.item_type} · supprimé {e.t.deleted_by ? `par ${e.t.deleted_by} ` : ""}le {formatWhen(e.t.deleted_at)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <section className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-4">
            {!current ? (
              <p className="text-center text-[12.5px] text-[var(--c-text-muted)] md:pt-12">Choisissez un élément pour le voir ou le restaurer.</p>
            ) : (
              <div className="max-w-2xl space-y-3">
                <button onClick={() => setSelected(null)} className="btn btn-ghost btn-sm md:hidden">← Liste</button>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--c-text)]">{nameOf(current)}</h2>
                  {writable && (
                    <>
                      <button onClick={() => void act(() => restoreVersion(vault, current.t, undefined), `« ${nameOf(current)} » restauré.`)} disabled={busy || !current.decoded.ok} className="btn btn-primary btn-sm">Restaurer</button>
                      <button onClick={() => setConfirm({ kind: "purge", entry: current })} disabled={busy} className="btn btn-ghost btn-sm hover:text-[var(--c-danger)]">Supprimer définitivement</button>
                    </>
                  )}
                </div>
                <p className="help-text">Effacé pour de bon le {formatWhen(current.t.expires_at)}. Restauré, il revient là où il était, sur chaque appareil synchronisé.</p>
                {current.decoded.ok ? (
                  <ItemView payload={current.decoded.payload} index={index} />
                ) : (
                  <p className="callout callout-danger">Cette version ne s'ouvre pas avec la clé actuelle du vault : {current.decoded.error}.</p>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {confirm?.kind === "purge" && (
        <ConfirmDialog
          title={`Supprimer définitivement « ${nameOf(confirm.entry)} » ?`}
          message="Sa dernière version et son historique sont effacés du serveur : il ne pourra plus être restauré."
          confirmLabel="Supprimer définitivement"
          danger
          onConfirm={() => { const e = confirm.entry; setConfirm(null); void act(() => api.purgeTrashItem(vault.id, e.t.item_id), "Supprimé définitivement."); }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "empty" && (
        <ConfirmDialog
          title="Vider la corbeille ?"
          message={`Les ${entries?.length ?? 0} élément(s) de la corbeille de « ${vault.name} » sont effacés du serveur, historique compris : ils ne pourront plus être restaurés.`}
          confirmLabel="Vider"
          danger
          onConfirm={() => { setConfirm(null); void act(() => api.emptyTrash(vault.id), "Corbeille vidée."); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
