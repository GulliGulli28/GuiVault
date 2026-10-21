/** Paramètres › Application › Mise à jour : la version installée, vérifier
 * sur GitHub, installer et redémarrer (`platform.ts` › `UpdaterBridge`).
 * L'installeur téléchargé n'est installé que si sa signature correspond à la
 * clé publique de l'application. */
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/api";
import { updaterBridge, type AvailableUpdate } from "../lib/platform";
import { Eyebrow } from "./ui";

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate"; advertised: string | null }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "installing"; done: number; total: number | null }
  | { kind: "error"; message: string };

function megabytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

export function AppUpdates() {
  const bridge = updaterBridge();
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  useEffect(() => {
    bridge?.version().then(setVersion).catch(() => setVersion(null));
  }, [bridge]);
  if (!bridge) return null;

  const check = async () => {
    setStatus({ kind: "checking" });
    try {
      const { update, advertised } = await bridge.check();
      setStatus(update ? { kind: "available", update } : { kind: "upToDate", advertised });
    } catch (e) {
      setStatus({ kind: "error", message: errorMessage(e) });
    }
  };
  const install = async () => {
    setStatus({ kind: "installing", done: 0, total: null });
    try {
      await bridge.install((done, total) => setStatus({ kind: "installing", done, total }));
    } catch (e) {
      setStatus({ kind: "error", message: errorMessage(e) });
    }
  };

  return (
    <section className="max-w-2xl space-y-1.5">
      <Eyebrow>Mise à jour</Eyebrow>
      <div className="card space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">GuiVault {version ? <span className="font-mono">{version}</span> : "…"}</p>
          <button onClick={() => void check()} disabled={status.kind === "checking" || status.kind === "installing"} className="btn btn-secondary btn-sm">
            {status.kind === "checking" ? "Recherche…" : "Vérifier les mises à jour"}
          </button>
        </div>
        {status.kind === "upToDate" && (
          <p className="text-[12px] text-[var(--c-text-secondary)]">
            {status.advertised && version && status.advertised !== version
              ? `À jour pour ce qu'annonce GitHub (${status.advertised}) — une publication toute récente peut ne pas y être encore visible.`
              : "À jour : c'est la dernière version publiée."}
          </p>
        )}
        {status.kind === "available" && (
          <div className="space-y-2">
            <p className="text-[12.5px] text-[var(--c-text)]">
              Version <span className="font-mono">{status.update.version}</span> disponible{status.update.date ? ` (publiée le ${new Date(status.update.date).toLocaleDateString("fr-FR")})` : ""}.
            </p>
            {status.update.notes && <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-[var(--c-bg3)] p-2 text-[11.5px] text-[var(--c-text-secondary)]">{status.update.notes}</pre>}
            <button onClick={() => void install()} className="btn btn-primary btn-sm">Installer et redémarrer</button>
          </div>
        )}
        {status.kind === "installing" && (
          <p className="text-[12px] text-[var(--c-text-secondary)]">
            Téléchargement{status.done ? ` : ${megabytes(status.done)}${status.total ? ` sur ${megabytes(status.total)}` : ""}` : "…"} — vérification de la signature, puis installation et redémarrage.
          </p>
        )}
        {status.kind === "error" && <p className="callout callout-danger">Mise à jour : {status.message}</p>}
      </div>
      <p className="help-text">Publiées sur GitHub · installées seulement si signées par GuiVault.</p>
    </section>
  );
}
