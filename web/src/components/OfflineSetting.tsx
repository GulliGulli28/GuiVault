/** La copie hors ligne (`lib/offline.ts`), à activer par appareil — la
 * même ligne dans Paramètres › Sécurité et dans les réglages du popup. */
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/api";
import { disableOffline, enableOffline, loadOfflineCopy, refreshOfflineCopy, type OfflineCopy } from "../lib/offline";
import type { SessionState } from "../lib/session";
import { ConfirmDialog } from "./ConfirmDialog";
import { InfoTip } from "./ui";

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
    <div className={compact ? "flex flex-wrap items-center gap-2" : "setting-row"}>
      <div className="min-w-0 flex-[1_1_260px]">
        <div className="setting-title flex flex-wrap items-center gap-1.5">
          Copie hors ligne {compact ? "dans ce navigateur" : ""}
          {copy !== undefined && <span className={`tag ${copy ? "tag-ok" : ""}`}>{copy ? "Activée" : "Désactivée"}</span>}
          <InfoTip label="Ce que garde la copie" items={[
            { text: "Chiffrée, comme sur le serveur", tone: "ok" },
            { text: "S'ouvre avec le mot de passe maître, en lecture seule", tone: "ok" },
            { text: "Sur le disque de cet appareil : à éviter sur un poste partagé", tone: "warn" },
          ]} />
        </div>
        <div className="setting-desc">
          {copy
            ? `Mise à jour le ${new Date(copy.savedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} · ${count} élément${count > 1 ? "s" : ""}`
            : "Ouvrir vos coffres en lecture quand le serveur ne répond pas."}
        </div>
      </div>
      {session.offline ? (
        <span className="text-[12.5px] text-[var(--c-text-muted)]">Session hors ligne</span>
      ) : copy ? (
        <div className="flex gap-2">
          <button onClick={() => void act(() => refreshOfflineCopy(session), "Copie hors ligne mise à jour.")} disabled={busy} className="btn btn-secondary">Mettre à jour</button>
          <button onClick={() => setConfirmOff(true)} disabled={busy} className="btn btn-ghost">Désactiver</button>
        </div>
      ) : (
        copy === null && <button onClick={() => void act(() => enableOffline(session), "Copie hors ligne activée.")} disabled={busy} className="btn btn-secondary">{busy ? "Copie…" : "Activer"}</button>
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
