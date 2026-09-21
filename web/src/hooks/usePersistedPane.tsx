import { useEffect } from "react";
import { useResizablePane, type UseResizablePaneOptions, type UseResizablePaneResult } from "./useResizablePane";

const KEY = "guivault.layout";

function loadLayout(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** `useResizablePane` de Guiterm, dont la valeur est retenue d'une visite à
 * l'autre (`localStorage`, une clé par panneau) : une page web se recharge,
 * la barre latérale qu'on a élargie doit rester élargie. */
export function usePersistedPane(name: string, options: UseResizablePaneOptions): UseResizablePaneResult {
  const stored = loadLayout()[name];
  const initial = typeof stored === "number" && stored >= options.min && stored <= options.max ? stored : options.initial;
  const pane = useResizablePane({ ...options, initial });
  useEffect(() => {
    if (pane.isDragging) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...loadLayout(), [name]: pane.value }));
    } catch {
      // Pas de stockage : la taille vaut pour la session.
    }
  }, [name, pane.value, pane.isDragging]);
  return pane;
}

/** La poignée entre deux panneaux, telle que dans Guiterm : un trait d'un
 * pixel qui s'épaissit et prend l'accent au survol. */
export function PaneHandle({ onMouseDown, className = "" }: { onMouseDown: (e: React.MouseEvent) => void; className?: string }) {
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      className={`group relative z-10 -mx-0.5 hidden w-1.5 shrink-0 cursor-col-resize items-center justify-center md:flex ${className}`}
    >
      <div className="h-full w-px bg-[var(--c-border)] transition-colors group-hover:w-0.5 group-hover:bg-[var(--c-accent)]" />
    </div>
  );
}
