/** L'historique d'un élément : ses versions précédentes, gardées chiffrées
 * par le serveur (`routes::history`) — chacune s'ouvre avec la clé du vault
 * et se restaure en la renvoyant telle quelle. */
import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { VaultIndex } from "../lib/entities";
import { decodeVersion, payloadName, restoreVersion, RevisionConflict, type DecodedItem, type VaultView } from "../lib/session";
import type { ItemVersion } from "../lib/types";
import { useModalSurface } from "../hooks/useModalSurface";
import { ItemView } from "./ItemView";
import { formatWhen, Loading } from "./ui";

export function ItemHistory({ vault, item, index, writable, onClose, onRestored }: {
  vault: VaultView;
  /** L'élément tel qu'il est : sa révision sert de verrou à la restauration. */
  item: DecodedItem;
  index: VaultIndex;
  writable: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: "Historique" });
  const [versions, setVersions] = useState<{ v: ItemVersion; decoded: DecodedItem }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .itemVersions(vault.id, item.id)
      .then((list) => setVersions(list.map((v) => ({ v, decoded: decodeVersion(vault, v, v.written_at) }))))
      .catch((e) => setError(errorMessage(e)));
  }, [vault, item.id]);

  const current = versions?.[chosen] ?? null;
  const restore = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await restoreVersion(vault, current.v, item.revision);
      onRestored();
    } catch (e) {
      setError(e instanceof RevisionConflict ? "L'élément a été modifié entre-temps : fermez et rouvrez l'historique." : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div ref={ref} {...dialogProps} className="modal fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(56rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--c-text)]">Historique de « {item.ok ? payloadName(item.payload) : item.id.slice(0, 8)} »</h2>
          <button onClick={onClose} className="btn btn-ghost btn-sm">Fermer</button>
        </header>
        {error && <p className="callout callout-danger m-3 mb-0">{error}</p>}
        {versions === null ? (
          !error && <div className="p-6"><Loading /></div>
        ) : versions.length === 0 ? (
          <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Aucune version précédente : cet élément n'a pas été modifié depuis que le serveur garde l'historique.</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <ul className="sidebar-scroll shrink-0 overflow-y-auto border-[var(--c-border)] p-2 max-md:max-h-40 max-md:border-b md:w-60 md:border-r" aria-label="Versions">
              {versions.map(({ v, decoded }, i) => (
                <li key={v.revision}>
                  <button onClick={() => setChosen(i)} data-active={i === chosen ? "true" : undefined} className="list-row w-full flex-col items-start py-1.5 text-left">
                    <span className="text-[12.5px] text-[var(--c-text)]">{formatWhen(v.written_at)}</span>
                    <span className="text-[11px] text-[var(--c-text-muted)]">
                      {decoded.ok ? payloadName(decoded.payload) : "illisible"} · remplacée {v.replaced_by ? `par ${v.replaced_by} ` : ""}le {formatWhen(v.replaced_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-4">
              {current && (current.decoded.ok ? (
                <>
                  {writable && (
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="help-text">L'élément actuel passe à son tour dans l'historique.</p>
                      <button onClick={() => void restore()} disabled={busy} className="btn btn-primary btn-sm">Restaurer cette version</button>
                    </div>
                  )}
                  <ItemView payload={current.decoded.payload} index={index} />
                </>
              ) : (
                <p className="callout callout-danger">Cette version ne s'ouvre pas avec la clé actuelle du vault : {current.decoded.error}.</p>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
