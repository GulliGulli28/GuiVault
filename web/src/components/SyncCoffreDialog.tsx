/** « Synchroniser avec une copie » (Paramètres › Compte, l'application) :
 * la session et une copie du même coffre — sur Nextcloud, Syncthing, une clé
 * USB — redeviennent une (`lib/coffreSync.ts`, `docs/TRANSFERT.md`). */
import { useCallback, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { syncWithCopy, type SyncReport } from "../lib/coffreSync";
import { coffreName } from "../lib/localHost";
import { coffreBridge } from "../lib/platform";
import { Modal, PasswordInput } from "./ui";

function summary(r: SyncReport): string {
  if (r.error) return r.error;
  if (r.copied === "here") return "Copié ici depuis la copie";
  if (r.copied === "there") return "Copié dans la copie";
  if (r.here === 0 && r.there === 0) return "Déjà identiques";
  const parts = [];
  if (r.here > 0) parts.push(`${r.here} reçu${r.here > 1 ? "s" : ""} ici`);
  if (r.there > 0) parts.push(`${r.there} envoyé${r.there > 1 ? "s" : ""} à la copie`);
  return parts.join(", ");
}

export function SyncCoffreDialog({ ctx, onClose }: { ctx: PageContext; onClose: () => void }) {
  const bridge = coffreBridge();
  const [path, setPath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<SyncReport[] | null>(null);
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  const pick = async () => {
    const p = await bridge?.pickExisting().catch(() => null);
    if (p) setPath(p);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!bridge?.peer || !path || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await syncWithCopy(ctx.session, api, bridge.peer, path, password);
      setReports(res);
      await ctx.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (reports) {
    const conflicts = reports.reduce((n, r) => n + r.conflicts, 0);
    return (
      <Modal title="Synchronisation terminée" onClose={close}>
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1.5">
            {reports.map((r) => (
              <li key={r.id} className="card px-3 py-2 text-[13px]">
                <span className="font-medium">{r.name}</span>
                <p className={`text-[12px] ${r.error ? "text-[var(--c-danger)]" : "text-[var(--c-text-muted)]"}`}>{summary(r)}</p>
              </li>
            ))}
          </ul>
          {conflicts > 0 && (
            <p className="callout callout-warn">
              {conflicts} élément{conflicts > 1 ? "s" : ""} modifié{conflicts > 1 ? "s" : ""} des deux côtés : la version la plus récente l'emporte, l'autre reste dans l'historique de l'élément.
            </p>
          )}
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="btn btn-primary">Fermer</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Synchroniser avec une copie" onClose={close}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={() => void pick()} className="btn btn-secondary shrink-0">Choisir la copie…</button>
          <span className="min-w-0 truncate text-[13px] text-[var(--c-text-muted)]" title={path ?? undefined}>{path ? coffreName(path) : "Aucune copie choisie"}</span>
        </div>
        <div>
          <label className="block">
            <span className="field-label">Mot de passe maître de la copie</span>
            <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
          </label>
          <p className="help-text">Le même, s'il n'a pas changé depuis la copie.</p>
        </div>
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} disabled={busy} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={!path || !password || busy} className="btn btn-primary">{busy ? "Synchronisation…" : "Synchroniser"}</button>
        </div>
      </form>
    </Modal>
  );
}
