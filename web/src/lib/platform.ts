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

/** L'écran de l'application (Android) : le cacher aux captures et à
 * l'aperçu des applications récentes (`FLAG_SECURE`, `MainActivity.kt`). */
export interface ScreenBridge {
  setSecure(on: boolean): void;
}

let screen: ScreenBridge | null = null;

export function setScreenBridge(b: ScreenBridge | null) {
  screen = b;
}

export function screenBridge(): ScreenBridge | null {
  return screen;
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

/** Sortir un coffre de l'appareil, en faire entrer un (Android, où les
 * coffres vivent dans le dossier privé de l'app que la désinstallation
 * efface) : une archive `.zip` du dossier du coffre, rangée ou choisie par le
 * sélecteur de documents du système (`docs/ANDROID.md`). */
export interface CoffreFileBridge {
  /** Écrit l'archive du coffre `path` là où l'utilisateur la range ; rend
   * le nom du fichier, ou `null` s'il annule. */
  exportArchive(path: string): Promise<string | null>;
  /** Choisit une archive (ou un `coffre.json`) et en fait un coffre de
   * l'appareil ; rend son chemin, ou `null` si on annule. */
  importArchive(): Promise<string | null>;
}

let coffreFiles: CoffreFileBridge | null = null;

export function setCoffreFileBridge(b: CoffreFileBridge | null) {
  coffreFiles = b;
}

export function coffreFileBridge(): CoffreFileBridge | null {
  return coffreFiles;
}

/** Les coffres locaux vus d'une autre session (`transfer.ts`) : copier un
 * compte dans un coffre, un coffre vers un serveur. */
export interface CoffreBridge {
  /** L'hôte des coffres, libre tant que la session n'est pas un coffre local. */
  host: LocalHost;
  /** Un second coffre ouvert à côté de la session, quelle qu'elle soit : la
   * copie avec laquelle on la synchronise (`coffreSync.ts`). */
  peer?: LocalHost;
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
  /** Comment elle a été installée : `msi` (pour tous les utilisateurs),
   * `nsis` (pour soi), `null` si on ne sait pas (lancée hors installeur).
   * L'updater installe la mise à jour par le même installeur. */
  installer(): Promise<"msi" | "nsis" | null>;
  /** Une version plus récente, ou `null` ; avec `null`, `advertised` dit
   * ce que la release annonce (égale à l'installée : à jour ; plus ancienne :
   * la dernière publication n'y est pas encore visible). */
  check(): Promise<{ update: AvailableUpdate | null; advertised: string | null }>;
  /** Télécharge, vérifie la signature, installe et relance — ou, `external`,
   * ouvre la page de la version (Android : pas d'updater, on installe l'APK
   * suivant par-dessus). */
  install(onProgress?: (done: number, total: number | null) => void): Promise<void>;
  /** Pas d'installation ici : `install` ouvre la page de téléchargement. */
  external?: boolean;
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

/** Pourquoi le mot de passe maître est demandé malgré la biométrie : le
 * téléphone a redémarré, ou il n'a pas servi depuis trop longtemps. */
export type BiometricPasswordReason = "reboot" | "age";

/** Ce que rend une invite biométrique. `cancel` : on a choisi le mot de
 * passe ; `invalidated` : les empreintes ont changé, tout est oublié. */
export type BiometricOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: "cancel" | "lockout" | "password" | "invalidated" | "none" | "error"; message?: string };

/** Le déverrouillage par empreinte ou visage de l'application Android
 * (`BiometricPlugin.kt`) : un secret (la user key) chiffré sous une clé du
 * Keystore qui ne sert qu'après une authentification biométrique forte. */
export interface BiometricBridge {
  status(): Promise<"ready" | "not-enrolled" | "unavailable">;
  state(id: string): Promise<{ enabled: boolean; password?: BiometricPasswordReason }>;
  /** Montre l'invite, puis range `secret` (base64) pour `id`. */
  enable(id: string, secret: string): Promise<BiometricOutcome<object>>;
  /** Montre l'invite, rend le secret de `id`. */
  unlock(id: string, subtitle?: string): Promise<BiometricOutcome<{ secret: string }>>;
  /** Le mot de passe vient d'ouvrir `id` : le délai repart. */
  touch(id: string): Promise<void>;
  disable(id: string): Promise<void>;
}

let biometric: BiometricBridge | null = null;

export function setBiometricBridge(b: BiometricBridge | null) {
  biometric = b;
}

/** `null` : pas de biométrie ici (tout sauf l'application Android). */
export function biometricBridge(): BiometricBridge | null {
  return biometric;
}

/** L'index du remplissage : les identifiants du coffre ouvert, tels que le
 * service de remplissage d'Android les propose (`lib/autofill.ts`). */
export interface AutofillIndex {
  v: 1;
  /** Le coffre ou le compte (ce que la feuille de remplissage nomme). */
  label: string;
  entries: { id: string; name: string; vault: string; username: string; password: string; uris: { uri: string; match: string | null }[] }[];
}

/** Le remplissage automatique de l'application Android (`AutofillPlugin.kt`,
 * `docs/REMPLISSAGE.md`). */
export interface AutofillBridge {
  /** `enabled` : GuiVault est le service de remplissage choisi ;
   * `biometric` : l'index se garde chiffré, l'application fermée remplit
   * encore après une empreinte. */
  status(): Promise<{ supported: boolean; enabled: boolean; biometric: boolean }>;
  /** L'écran d'Android qui propose de choisir GuiVault. */
  request(): Promise<void>;
  /** Ne plus être le service choisi ; l'index s'efface. */
  disable(): Promise<void>;
  /** Le coffre ouvert : son index (en mémoire, et chiffré sur le disque). */
  update(index: AutofillIndex): Promise<void>;
  /** Verrouillé : plus rien en clair (le fichier chiffré reste). */
  clear(): Promise<void>;
  /** Déconnecté, coffre fermé : tout s'efface. */
  forget(): Promise<void>;
  /** Le mot de passe maître vient d'ouvrir un coffre (le délai repart). */
  passwordUsed(): Promise<void>;
}

let autofill: AutofillBridge | null = null;

export function setAutofillBridge(b: AutofillBridge | null) {
  autofill = b;
}

/** `null` : pas de remplissage ici (tout sauf l'application Android). */
export function autofillBridge(): AutofillBridge | null {
  return autofill;
}

/** Une clé du coffre confiée à l'agent SSH : le texte OpenSSH de la clé
 * privée et sa phrase de passe (`app-tauri/src/ssh_agent/`). */
export interface SshAgentKey {
  id: string;
  name: string;
  content: string;
  passphrase: string | null;
}

/** Ce que l'agent a fait d'une clé confiée : son empreinte, ou pourquoi il
 * n'a pas pu la lire. */
export interface SshAgentKeyStatus {
  id: string;
  fingerprint: string | null;
  error: string | null;
}

/** Ce qu'un programme demande de signer. */
export type SshAgentPurpose =
  | { kind: "sshLogin"; user: string; fingerprint: string | null }
  | { kind: "gitSignature" }
  | { kind: "sshsig"; namespace: string }
  | { kind: "unknown" };

/** La question posée avant chaque signature (ou une fois pour 10 minutes). */
export interface SshAgentRequest {
  id: number;
  keyId: string;
  keyName: string;
  keyFingerprint: string;
  purpose: SshAgentPurpose;
  client: { pid: number | null; program: string | null };
  /** Par un agent transféré sur un hôte distant : toujours redemandé. */
  forwarded: boolean;
}

/** L'agent SSH de l'application (bureau) : `ssh`, `git`… signent avec les
 * clés du coffre ouvert, après confirmation. */
export interface SshAgentBridge {
  /** Où l'agent écoute (Windows : le tube d'OpenSSH). */
  status(): Promise<{ running: boolean; endpoint: string }>;
  /** Rejette avec le code `agent_busy` si le tube est déjà pris (le service
   * « OpenSSH Authentication Agent » de Windows). */
  start(): Promise<{ running: boolean; endpoint: string }>;
  stop(): Promise<void>;
  /** Les clés du coffre ouvert ; `[]` au verrouillage. */
  setKeys(keys: SshAgentKey[]): Promise<SshAgentKeyStatus[]>;
  /** Appelé à chaque demande de signature ; rend de quoi se désabonner. */
  onRequest(handler: (r: SshAgentRequest) => void): () => void;
  /** Une demande restée sans réponse (délai écoulé) : la retirer. */
  onCancel(handler: (id: number) => void): () => void;
  answer(id: number, allow: boolean, remember: boolean): Promise<void>;
}

let sshAgent: SshAgentBridge | null = null;

export function setSshAgentBridge(b: SshAgentBridge | null) {
  sshAgent = b;
}

export function sshAgentBridge(): SshAgentBridge | null {
  return sshAgent;
}
