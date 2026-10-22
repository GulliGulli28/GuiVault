/** Ce que seule l'application sait faire (`web/app`, `docs/APP.md`), offert
 * à l'interface commune sans qu'elle importe quoi que ce soit de Tauri :
 * l'application le pose au démarrage (`setAutoTypeBridge`), le web le laisse
 * vide et les composants n'en montrent rien. */
import type { LockReason } from "./appSettings";
import type { AutoTypeAction } from "./autotype";
import type { LocalHost } from "./localHost";

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

/** Les coffres locaux vus d'une autre session (`transfer.ts`) : copier un
 * compte dans un coffre, un coffre vers un serveur. */
export interface CoffreBridge {
  /** L'hôte des coffres, libre tant que la session n'est pas un coffre local. */
  host: LocalHost;
  pickNew(): Promise<string | null>;
  pickExisting(): Promise<string | null>;
  /** Le coffre rejoint les coffres récents de l'accueil. */
  remember(path: string): void;
  /** Le dernier serveur ouvert depuis l'accueil, ou `""`. */
  lastServer(): string;
}

let coffres: CoffreBridge | null = null;

export function setCoffreBridge(b: CoffreBridge | null) {
  coffres = b;
}

export function coffreBridge(): CoffreBridge | null {
  return coffres;
}

/** Une mise à jour de l'application, annoncée par la release GitHub. */
export interface AvailableUpdate {
  version: string;
  notes: string | null;
  date: string | null;
}

/** Les mises à jour de l'application (`tauri-plugin-updater`, comme
 * Guiterm) : installeurs signés, vérifiés contre la clé publique de
 * `app-tauri/tauri.conf.json` avant d'être installés. */
export interface UpdaterBridge {
  /** La version installée. */
  version(): Promise<string>;
  /** Une version plus récente, ou `null` ; avec `null`, `advertised` dit
   * ce que la release annonce (égale à l'installée : à jour ; plus ancienne :
   * la dernière publication n'y est pas encore visible). */
  check(): Promise<{ update: AvailableUpdate | null; advertised: string | null }>;
  /** Télécharge, vérifie la signature, installe et relance. */
  install(onProgress?: (done: number, total: number | null) => void): Promise<void>;
}

let updater: UpdaterBridge | null = null;

export function setUpdaterBridge(b: UpdaterBridge | null) {
  updater = b;
}

export function updaterBridge(): UpdaterBridge | null {
  return updater;
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

/** La bulle flottante de l'application Android (`docs/ANDROID.md`) :
 * GuiVault réduit à une bulle par-dessus les autres applications. */
export interface BubbleBridge {
  /** Réduit l'application en bulle. `false` : la permission « Afficher
   * par-dessus d'autres applis » manque — l'écran d'Android qui la donne
   * vient d'être ouvert. */
  show(): Promise<boolean>;
  /** La bulle grise quand le coffre est verrouillé : elle ne montre jamais
   * rien d'autre que le logo. */
  setLocked(locked: boolean): Promise<void>;
  /** Se réduire en bulle en quittant l'application : le réglage (le pose si
   * `enabled` est donné), et si la permission est donnée. */
  auto(enabled?: boolean): Promise<{ enabled: boolean; allowed: boolean }>;
  /** Ouvre l'écran d'Android qui donne la permission. */
  ask(): Promise<void>;
}

let bubble: BubbleBridge | null = null;

export function setBubbleBridge(b: BubbleBridge | null) {
  bubble = b;
}

/** `null` : pas de bulle ici (tout sauf l'application Android). */
export function bubbleBridge(): BubbleBridge | null {
  return bubble;
}
