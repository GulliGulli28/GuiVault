import type { ReactNode } from "react";
import { navigate, type Route } from "../lib/route";
import { IconChevronRight } from "./ui-icons";

/** Le gabarit d'une page (`docs/DESIGN.md`) : un titre, un sous-titre d'une
 * ligne au plus — pas de paragraphe d'explication —, les actions à droite,
 * puis le contenu dans une colonne de largeur bornée. `back` : le lien vers
 * la page d'où l'on vient (un vault, depuis ses réglages). */
export function Page({ title, sub, actions, back, children, width = "max-w-[1000px]" }: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; route: Route };
  children: ReactNode;
  width?: string;
}) {
  return (
    <div className="sidebar-scroll h-full min-h-0 overflow-y-auto">
      <div className={`mx-auto flex min-w-0 flex-col gap-7 px-10 pb-12 pt-8 max-md:gap-5 max-md:px-4 max-md:pt-14 ${width}`}>
        <header className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-3">
          <div className="min-w-[220px] flex-1">
            {back && (
              <button onClick={() => navigate(back.route)} className="mb-2 flex max-w-full items-center gap-1 text-[13px] text-[var(--c-text-muted)] hover:text-[var(--c-text)]">
                <IconChevronRight size={12} className="shrink-0 rotate-180" />
                <span className="truncate">{back.label}</span>
              </button>
            )}
            <h1 className="page-title truncate">{title}</h1>
            {sub && <p className="page-sub">{sub}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
        {children}
      </div>
    </div>
  );
}

/** Une section titrée d'une page. */
export function PageSection({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-w-0 flex-col gap-3 ${className}`}>
      {(title || aside) && (
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          {title && <h2 className="section-title">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}
