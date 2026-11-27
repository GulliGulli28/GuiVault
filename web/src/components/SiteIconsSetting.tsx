/** Le réglage « Icônes des sites » (`lib/siteIcon.ts`) : Paramètres ›
 * Application dans l'application de bureau, réglages du popup dans
 * l'extension. Seulement là où l'on sait contacter un site. */
import { useState } from "react";
import { plural, t } from "../lib/i18n";

export function SiteIconsSetting({ enabled, onChange, onFetchNow }: {
  enabled: boolean;
  onChange: (on: boolean) => void;
  /** Récupérer tout de suite ce qui manque ; rend le nombre d'identifiants
   * qui ont reçu une icône. */
  onFetchNow: () => Promise<number>;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const now = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const n = await onFetchNow();
      setSaid(n ? plural(n, "{0} identifiant a reçu son icône.", "{0} identifiants ont reçu leur icône.") : t("Aucune icône de plus trouvée."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="card flex flex-wrap items-center gap-2 p-3">
        <label className="flex min-w-0 flex-1 items-start gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
          <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">{t("Récupérer l'icône du site de chaque identifiant")}</span>
        </label>
        {enabled && <button onClick={() => void now()} disabled={busy} className="btn btn-secondary btn-sm">{busy ? t("Récupération…") : t("Récupérer maintenant")}</button>}
      </div>
      <p className="help-text">{t("Demandée directement à chaque site, qui voit l'adresse IP de cet appareil ; rien ne passe par le serveur GuiVault. Rangée chiffrée dans l'identifiant, elle s'affiche ensuite partout.")}</p>
      {said && <p className="help-text" role="status">{said}</p>}
    </div>
  );
}
