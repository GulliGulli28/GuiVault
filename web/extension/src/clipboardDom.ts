/** Lire et vider le presse-papiers depuis une page d'extension qui n'a pas
 * le focus — le document hors écran de Chrome (`offscreen.ts`), la page
 * d'arrière-plan de Firefox. `navigator.clipboard` y exige le focus ;
 * `execCommand` non, avec les permissions `clipboardRead` et
 * `clipboardWrite`. */
import { clipboardHash } from "../../src/lib/clipboard";

function readClipboard(): string | null {
  const area = document.createElement("textarea");
  document.body.appendChild(area);
  area.focus();
  try {
    return document.execCommand("paste") ? area.value : null;
  } finally {
    area.remove();
  }
}

function emptyClipboard(): boolean {
  // Pas de sélection à copier : c'est l'événement qui dit quoi écrire.
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", "");
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  try {
    return document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}

/** Vide le presse-papiers s'il contient encore ce qui a pour empreinte
 * `hash` ; sinon (autre chose copié depuis, ou illisible), n'y touche pas. */
export function clearClipboardIfUnchanged(hash: string): boolean {
  const current = readClipboard();
  if (current === null || clipboardHash(current) !== hash) return false;
  return emptyClipboard();
}
