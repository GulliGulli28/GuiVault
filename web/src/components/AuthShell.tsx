import type { ReactNode } from "react";
import { Logo } from "./Logo";
import { IconFolder, IconHosts, IconMonitor } from "./ui-icons";

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
          <span className="text-[16px] font-semibold">GuiVault</span>
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

      {/* Ce que voit qui : l'explication, en schéma. */}
      <section aria-label={store === "server" ? "Ce que voit le serveur" : "Ce que garde le disque"} className="flex min-w-0 flex-[1_1_480px] items-center justify-center border-l border-[var(--c-border)] bg-[var(--c-bg)] px-8 py-12 [background-image:radial-gradient(var(--c-border)_1px,transparent_1px)] [background-size:20px_20px] max-[1000px]:hidden">
        <div className="flex w-full max-w-[500px] flex-col gap-3.5">
          <div className="card flex flex-col gap-3 border-[var(--c-border-strong)] p-5">
            <span className="flex items-center gap-2 text-[13px] text-[var(--c-text-muted)]"><IconMonitor size={15} /> Cet appareil</span>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px]">
              <span className="text-[var(--c-text-muted)]">Site</span><span className="truncate font-mono">github.com</span>
              <span className="text-[var(--c-text-muted)]">Utilisateur</span><span className="truncate font-mono">alice</span>
              <span className="text-[var(--c-text-muted)]">Mot de passe</span><span className="truncate font-mono">Tr0ub4dor&amp;3xyz!</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-[12.5px] text-[var(--c-text-muted)]">
            <svg width="14" height="34" viewBox="0 0 14 34" aria-hidden="true"><path d="M7 0v28M2 23l5 6 5-6" fill="none" stroke="var(--c-accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="font-mono text-[var(--c-accent-text)]">XChaCha20-Poly1305</span><span>clé dérivée du mot de passe maître</span>
          </div>
          <div className="flex flex-col gap-3 rounded-[14px] border border-dashed border-[var(--c-border-strong)] bg-[var(--c-bg2)] p-5">
            <span className="flex items-center gap-2 text-[13px] text-[var(--c-text-muted)]">
              {store === "server" ? <><IconHosts size={15} /> Le serveur</> : <><IconFolder size={15} /> Le dossier du coffre</>}
            </span>
            <p className="break-all font-mono text-[12.5px] leading-relaxed text-[var(--c-text-faint)]">AQ8f3c1e9b47a0d2ef55c9a1b7e04f8d6c3a2b9e7f10d4c6a8b2e5f7a9c1d3e5f70b2d4f6a8c0e2f4b6d8a0c2e4f6a8b0d2c4e6f8a1b3d5f7e9c1a3b5d7f9e2c4</p>
            <span className="text-[13px] text-[var(--c-text-secondary)]">Ne garde que ceci : ni mot de passe, ni clé.</span>
          </div>
        </div>
      </section>
    </div>
  );
}
