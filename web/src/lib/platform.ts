/** Ce que seule l'application sait faire (`web/app`, `docs/APP.md`), offert
 * à l'interface commune sans qu'elle importe quoi que ce soit de Tauri :
 * l'application le pose au démarrage (`setAutoTypeBridge`), le web le laisse
 * vide et les composants n'en montrent rien. */
import type { AutoTypeAction } from "./autotype";

/** Une demande du raccourci global : la fenêtre qui était au premier plan
 * quand on l'a pressé. `target` est opaque (un handle de fenêtre). */
export interface AutoTypeRequest {
  target: string;
  title: string;
}

export interface AutoTypeBridge {
  /** Tape `actions` dans la fenêtre `target` — ou, sans cible, dans celle
   * qui reprend le premier plan quand GuiVault se réduit (« Saisie
   * automatique » sur une fiche). S'arrête si le focus quitte la fenêtre :
   * rejette alors avec le code `autotype_focus_lost`. */
  type(actions: AutoTypeAction[], target?: string): Promise<void>;
  /** Le raccourci global ; `""` le retire. Rejette s'il est mal écrit ou
   * déjà pris par une autre application. */
  setHotkey(accelerator: string): Promise<void>;
  /** Appelé à chaque pression du raccourci global ; rend de quoi se
   * désabonner. */
  onRequest(handler: (r: AutoTypeRequest) => void): () => void;
  /** Ramène la fenêtre de GuiVault au premier plan (choisir parmi plusieurs
   * identifiants, déverrouiller). */
  focusApp(): Promise<void>;
}

let autoType: AutoTypeBridge | null = null;

export function setAutoTypeBridge(b: AutoTypeBridge | null) {
  autoType = b;
}

/** `null` : pas de saisie automatique ici (le web, l'extension, ou une
 * plateforme que l'application ne sait pas encore piloter). */
export function autoTypeBridge(): AutoTypeBridge | null {
  return autoType;
}
