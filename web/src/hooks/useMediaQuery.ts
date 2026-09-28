import { useSyncExternalStore } from "react";

/** Une media query, suivie : vraie tant qu'elle correspond. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** L'écran étroit, où la barre latérale devient un tiroir (`md` de Tailwind). */
export const NARROW = "(max-width: 767px)";
/** Un doigt plutôt qu'une souris : pas de raccourcis clavier à montrer. */
export const TOUCH = "(pointer: coarse)";
