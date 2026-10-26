/** Les sauvegardes d'un coffre local (`platform.ts` › `BackupBridge`) : la
 * liste, et en faire une copie ouvrable — jamais écraser le coffre. Dans
 * Paramètres › Compte, et à l'accueil de l'application quand un coffre ne
 * s'ouvre plus. */
import { useEffect, useState } from "react";
import { errorMessage } from "../lib/api";
import { backupBridge, type LocalBackup } from "../lib/platform";
import { formatWhen } from "./ui";
import { t } from "../lib/i18n";

function formatSize(n: number): string {
  return n < 1024 * 1024 ? t("{0} Kio", Math.max(1, Math.round(n / 1024))) : t("{0} Mio", (n / (1024 * 1024)).toFixed(1));
}

export function LocalBackups({ path, onRestored, onError }: { path: string; onRestored: (dest: string) => void; onError: (m: string) => void }) {
  const [list, setList] = useState<LocalBackup[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const bridge = backupBridge();
  useEffect(() => {
    bridge?.list(path).then(setList).catch((e) => { setList([]); onError(errorMessage(e)); });
    // Relu quand le coffre change, pas à chaque rendu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  if (!bridge) return null;

  const restore = async (b: LocalBackup) => {
    setBusy(b.name);
    try {
      const dest = await bridge.restoreCopy(path, b.name);
      if (dest) onRestored(dest);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1.5">
      {list === null ? (
        <p className="text-[12px] text-[var(--c-text-muted)]">{t("Lecture des sauvegardes…")}</p>
      ) : list.length === 0 ? (
        <p className="text-[12px] text-[var(--c-text-muted)]">{t("Pas encore de sauvegarde : la première est faite avant la prochaine modification.")}</p>
      ) : (
        <ul className="card divide-y divide-[var(--c-border)]">
          {list.map((b) => (
            <li key={b.name} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">
                {formatWhen(b.taken_at)} <span className="text-[11px] text-[var(--c-text-faint)]">· {formatSize(b.size)}</span>
              </span>
              <button onClick={() => void restore(b)} disabled={busy !== null} className="btn btn-secondary btn-sm" aria-label={t("Ouvrir une copie de la sauvegarde du {0}", formatWhen(b.taken_at))}>
                {busy === b.name ? t("Copie…") : t("Ouvrir une copie…")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="help-text">{t("Une copie de")} <span className="font-mono">{t("coffre.json")}</span> {t("avant les modifications, au plus une par heure, les dix dernières. Restaurer crée un")} <strong>{t("nouveau coffre")}</strong> {t("à côté — celui-ci n'est pas touché ; la copie s'ouvre avec le mot de passe maître de la date de la sauvegarde.")}</p>
    </div>
  );
}
