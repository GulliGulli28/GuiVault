/** Les raccourcis à une touche (`j`, `e`, `/`…) ne valent que hors d'un
 * champ de saisie et hors d'une fenêtre ouverte : sinon on tape une lettre,
 * on ne commande rien. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Une fenêtre (`useModalSurface`) est ouverte : ses touches sont les siennes. */
export function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** Une touche seule (sans Ctrl, Alt ni Méta), hors saisie et hors fenêtre. */
export function plainShortcut(e: KeyboardEvent): boolean {
  return !e.ctrlKey && !e.altKey && !e.metaKey && !e.defaultPrevented && !isTypingTarget(e.target) && !modalOpen();
}
