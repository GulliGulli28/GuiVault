/** Ce que seule l'application sait faire (`web/app`, `docs/APP.md`), offert
 * à l'interface commune sans qu'elle importe quoi que ce soit de Tauri :
 * l'application le pose au démarrage (`setAutoTypeBridge`), le web le laisse
 * vide et les composants n'en montrent rien. */
import type { LockReason } from "./appSettings";
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

/** Le presse-papiers natif de l'application (Windows) : hors de
 * l'historique (Win+V) et du presse-papiers cloud, effacé à l'échéance
 * s'il n'a pas changé — sans focus ni relecture (`app-tauri/src/clipboard.rs`). */
export interface ClipboardBridge {
  copySecret(text: string, clearAfterMs: number): Promise<void>;
}

let clipboard: ClipboardBridge | null = null;

export function setClipboardBridge(b: ClipboardBridge | null) {
  clipboard = b;
}

export function clipboardBridge(): ClipboardBridge | null {
  return clipboard;
}

/** Ce que le système dit à l'application : quand verrouiller, et depuis
 * combien de temps l'ordinateur est inactif (`app-tauri/src/system.rs`). */
export interface SystemBridge {
  /** Le système prévient du verrouillage de session et de la veille, et dit
   * son inactivité (Windows) ; sinon seule la réduction est suivie. */
  systemEvents: boolean;
  /** Une icône dans la zone de notification (Windows). */
  tray: boolean;
  /** Fermer la fenêtre la range dans la zone de notification. */
  setCloseToTray(enabled: boolean): Promise<void>;
  /** Démarrer avec la session (dans la zone de notification) : `enabled` le
   * pose ou le retire ; rend l'état. */
  autostart(enabled?: boolean): Promise<boolean>;
  /** Relier l'extension de navigateur aux coffres locaux (inscrire l'hôte
   * natif auprès des navigateurs) : `enabled` le pose ou le retire ; rend
   * l'état. */
  browserIntegration(enabled?: boolean): Promise<boolean>;
  /** Appelé quand il faut verrouiller (selon les réglages de
   * `appSettings.ts`, déjà appliqués) ; rend de quoi se désabonner. */
  onLock(handler: (reason: LockReason) => void): () => void;
  /** Inactivité de tout l'ordinateur (ms) ; `null` si inconnue. */
  idleMs(): Promise<number | null>;
}

let system: SystemBridge | null = null;

export function setSystemBridge(b: SystemBridge | null) {
  system = b;
}

export function systemBridge(): SystemBridge | null {
  return system;
}

/** Une sauvegarde d'un coffre local (`guivault_local::BackupInfo`). */
export interface LocalBackup {
  name: string;
  taken_at: string;
  size: number;
}

/** Les sauvegardes d'un coffre local (`crates/guivault-local/src/backup.rs`) :
 * les lister, en faire une copie ouvrable — jamais écraser le coffre. */
export interface BackupBridge {
  list(path: string): Promise<LocalBackup[]>;
  /** Demande où ranger la copie ; rend son chemin, ou `null` si on annule.
   * La copie rejoint les coffres récents. */
  restoreCopy(path: string, name: string): Promise<string | null>;
}

let backups: BackupBridge | null = null;

export function setBackupBridge(b: BackupBridge | null) {
  backups = b;
}

export function backupBridge(): BackupBridge | null {
  return backups;
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
