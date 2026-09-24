/** La copie hors ligne (`lib/offline.ts`), à activer par appareil — la
 * même ligne dans Paramètres › Sécurité et dans les réglages du popup. */
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/api";
import { disableOffline, enableOffline, loadOfflineCopy, refreshOfflineCopy, type OfflineCopy } from "../lib/offline";
import type { SessionState } from "../lib/session";
import { ConfirmDialog } from "./ConfirmDialog";

/** La copie hors ligne (`lib/offline.ts`) : par appareil, désactivée par
 * défaut — sur le disque, elle vaut une copie de la base : inexploitable
 * sans le mot de passe maître, mais attaquable hors ligne. */
export function OfflineSetting({ session, notify, error, compact = false }: { session: SessionState; notify: (m: string) => void; error: (m: string) => void; compact?: boolean }) {
  const [copy, setCopy] = useState<OfflineCopy | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  useEffect(() => { void loadOfflineCopy(session.user.email).then(setCopy); }, [session.user.email]);
  const act = async (f: () => Promise<OfflineCopy | null>, done: string) => {
    setBusy(true);
    try {
      setCopy(await f());
      notify(done);
    } catch (e) {
      error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const count = copy ? Object.values(copy.items).reduce((n, v) => n + v.items.length, 0) : 0;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "" : "p-3"}`}>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] text-[var(--c-text)]">
          Copie hors ligne {compact ? "dans ce navigateur" : "sur cet appareil"} {copy !== undefined && <span className={`tag ml-1 ${copy ? "tag-accent" : ""}`}>{copy ? "activée" : "désactivée"}</span>}
        </p>
        <p className="help-text">
          {copy
            ? `Mise à jour le ${new Date(copy.savedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} — ${count} élément(s) dans ${copy.vaults.length} vault(s). `
            : ""}
          Pour ouvrir le coffre quand le serveur ne répond pas, en lecture seule. C'est ce que le serveur garde — chiffré, et qui s'ouvre avec le mot de passe maître —, mais sur le disque de cet appareil : ne l'activez pas sur un ordinateur partagé.
        </p>
      </div>
      {session.offline ? (
        <span className="text-[11.5px] text-[var(--c-text-muted)]">Session hors ligne</span>
      ) : copy ? (
        <>
          <button onClick={() => void act(() => refreshOfflineCopy(session), "Copie hors ligne mise à jour.")} disabled={busy} className="btn btn-secondary btn-sm">Mettre à jour</button>
          <button onClick={() => setConfirmOff(true)} disabled={busy} className="btn btn-ghost btn-sm">Désactiver</button>
        </>
      ) : (
        copy === null && <button onClick={() => void act(() => enableOffline(session), "Copie hors ligne activée.")} disabled={busy} className="btn btn-secondary btn-sm">{busy ? "Copie…" : "Activer la copie"}</button>
      )}
      {confirmOff && (
        <ConfirmDialog
          title="Désactiver la copie hors ligne ?"
          message="La copie chiffrée de ce compte est effacée de cet appareil. Sans le serveur, le coffre ne s'ouvrira plus ici."
          confirmLabel="Désactiver"
          onConfirm={() => { setConfirmOff(false); void act(async () => { await disableOffline(session.user.email); return null; }, "Copie hors ligne effacée."); }}
          onCancel={() => setConfirmOff(false)}
        />
      )}
    </div>
  );
}
