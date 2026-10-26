import type { ReactNode } from "react";
import { Logo } from "./Logo";
import { IconFolder, IconHosts, IconMonitor } from "./ui-icons";
import { t } from "../lib/i18n";

/** La mise en page des écrans d'entrée (maquette « Connexion ») : le logo en
 * haut à gauche, un grand titre et le formulaire au centre, un pied d'une
 * ligne ; à droite, ce que voit qui, en schéma — le serveur, ou le dossier
 * d'un coffre local. Partagée par `LoginScreen` et l'accueil de l'app. */
export function AuthShell({ title, sub, footer, store = "server", children }: {
  title: ReactNode;
  sub: ReactNode;
  footer?: ReactNode;
  store?: "server" | "local";
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-wrap bg-[var(--c-bg2)]">
      <section className="flex min-h-[100dvh] min-w-0 flex-[1_1_480px] flex-col px-8 py-7 max-sm:px-5">
        <div className="flex items-center gap-2.5 max-md:hidden">
          {/* Gris tant qu'on n'est pas connecté — comme l'icône de l'extension. */}
          <Logo size={28} locked />
          <span className="text-[16px] font-semibold">{t("GuiVault")}</span>
        </div>

        <div className="flex flex-1 items-center justify-center py-10 max-md:items-start max-md:pb-6 max-md:pt-[calc(2.5rem+var(--inset-top))]">
          <div className="flex w-full max-w-[380px] flex-col gap-5 max-md:gap-6">
            {/* Mobile (maquette `MConnexion`) : le logo en grand, centré. */}
            <div className="min-w-0 max-md:flex max-md:flex-col max-md:items-center max-md:gap-3.5 max-md:text-center">
              <span className="md:hidden"><Logo size={72} locked /></span>
              <h1 className="break-words text-[30px] font-semibold leading-tight tracking-[-0.025em] max-md:text-[28px]">{title}</h1>
              <p className="page-sub">{sub}</p>
            </div>
            {children}
          </div>
        </div>

        {footer && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-[var(--c-text-muted)] max-md:pb-[var(--inset-bottom)] max-md:text-[14px]">{footer}</div>}
      </section>

      {/* La vitrine : un fond animé (aurores, grille), un titre, et ce que
          voit qui — en cartes de verre qui flottent. */}
      <section aria-label={store === "server" ? t("Ce que voit le serveur") : t("Ce que garde le disque")} className="auth-hero max-[1000px]:hidden">
        <div className="aurora" aria-hidden="true"><span /><span /><span /></div>
        <div className="auth-grid" aria-hidden="true" />
        <div className="relative z-[1] flex w-full max-w-[520px] flex-col gap-9">
          <div className="flex flex-col gap-4">
            <span className="glass-chip"><span className="pulse-dot" /> {t("Zero-knowledge · chiffré de bout en bout")}</span>
            <h2 className="auth-title">{t("Vos secrets se chiffrent ici. Ailleurs, ce n'est que du bruit.")}</h2>
          </div>
          <div className="relative h-[300px]">
            <div className="glass-card float-a left-0 top-0 w-[300px]">
              <div className="flex items-center gap-3">
                <span className="tile" style={{ "--tile-size": "38px", "--tile-h": 28 } as React.CSSProperties}>{t("G")}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold">{t("GitHub")}</span>
                  <span className="text-[12.5px] text-[var(--c-text-muted)]">{t("alice · github.com")}</span>
                </span>
              </div>
              <div className="mt-3.5 flex items-center justify-between gap-3 rounded-[10px] bg-[var(--c-hover)] px-3 py-2 font-mono text-[13px]">
                <span className="truncate">{t("Tr0ub4dor&3xyz!")}</span>
                <span className="text-[11px] font-sans text-[var(--c-ok-text)]">{t("très fort")}</span>
              </div>
            </div>
            <div className="glass-card float-b right-0 top-6 w-[190px]">
              <span className="text-[12px] text-[var(--c-text-muted)]">{t("Code 2FA")}</span>
              <div className="mt-1.5 flex items-center gap-2.5">
                <span className="font-mono text-[24px] font-medium tracking-[0.06em]">346 067</span>
                <svg width="22" height="22" viewBox="0 0 22 22" className="ring-spin" aria-hidden="true"><circle cx="11" cy="11" r="8.5" fill="none" stroke="var(--c-border-strong)" strokeWidth="2.5" /><circle cx="11" cy="11" r="8.5" fill="none" stroke="var(--c-accent)" strokeWidth="2.5" strokeDasharray="32 53.4" strokeLinecap="round" transform="rotate(-90 11 11)" /></svg>
              </div>
            </div>
            <div className="glass-card float-c bottom-0 left-12 right-4">
              <span className="flex items-center gap-2 text-[12px] text-[var(--c-text-muted)]">
                {store === "server" ? <><IconHosts size={14} /> {t("Ce que voit le serveur")}</> : <><IconFolder size={14} /> {t("Ce que garde le dossier")}</>}
              </span>
              <p className="cipher mt-2 font-mono text-[12px] leading-relaxed">{t("AQ8f3c1e9b47a0d2ef55c9a1b7e04f8d6c3a2b9e7f10d4c6a8b2e5f7a9c1d3e5f70b2d4f6a8c0e2f4b6d8a0c2e4f6a8b0d2c4e6f8a1b3d5f7e9c1a3b5d7f9e2c4a6b8d0f1e3c5a7b9d2f4e6a8c0b2d4f6e8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8")}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="glass-chip"><IconMonitor size={14} /> {t("Déchiffré sur cet appareil")}</span>
            <span className="glass-chip font-mono">{t("XChaCha20-Poly1305")}</span>
            <span className="glass-chip font-mono">{t("Argon2id")}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
