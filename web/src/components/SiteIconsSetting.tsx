/** Le réglage « Icônes des sites » (`lib/siteIcon.ts`) : Paramètres ›
 * Application dans l'application de bureau, réglages du popup dans
 * l'extension. Seulement là où l'on sait contacter un site. */
import { useState } from "react";
import type { PageContext } from "../App";
import { plural, t } from "../lib/i18n";
import { siteFetchBridge } from "../lib/platform";
import { loadItems } from "../lib/session";
import { fetchSiteIcon, fillMissingIcons, localSiteIcons, renderIcon, writableTargets } from "../lib/siteIcon";

export function SiteIconsSetting({ enabled, onChange, onFetchNow, mobile }: {
  enabled: boolean;
  /** Le menu mobile (`MobileMenu`) : ses lignes `m-set`. */
  mobile?: boolean;
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
  if (mobile) {
    return (
      <>
        <div className="m-set">
          <span className="flex min-w-0 flex-1 flex-col">
            <span>{t("Récupérer l'icône du site de chaque identifiant")}</span>
            <span className="text-[13px] text-[var(--c-text-muted)]">{said ?? t("Demandée directement à chaque site, qui voit l'adresse IP de cet appareil ; rien ne passe par le serveur GuiVault. Rangée chiffrée dans l'identifiant, elle s'affiche ensuite partout.")}</span>
          </span>
          <button type="button" role="switch" aria-checked={enabled} aria-label={t("Récupérer l'icône du site de chaque identifiant")} onClick={() => onChange(!enabled)} className="switch" />
        </div>
        {enabled && <button onClick={() => void now()} disabled={busy} className="m-set w-full text-left"><span className="flex-1">{busy ? t("Récupération…") : t("Récupérer maintenant")}</span></button>}
      </>
    );
  }
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

/** Le réglage dans l'application (bureau et Android) : sur cet appareil,
 * et une passe sur tous les vaults où l'on écrit. */
export function AppSiteIcons({ ctx, mobile }: { ctx: PageContext; mobile?: boolean }) {
  const [enabled, setEnabled] = useState(localSiteIcons.enabled);
  const bridge = siteFetchBridge();
  return (
    <SiteIconsSetting
      mobile={mobile}
      enabled={enabled}
      onChange={(on) => { localSiteIcons.setEnabled(on); setEnabled(on); }}
      onFetchNow={async () => {
        if (!bridge) return 0;
        localSiteIcons.forget();
        const targets = await writableTargets(ctx.session.vaults, loadItems);
        const n = await fillMissingIcons(targets, (site) => fetchSiteIcon(site, bridge.fetch, renderIcon), localSiteIcons.tried, 1000);
        if (n) await ctx.reload();
        return n;
      }}
    />
  );
}
