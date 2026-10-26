/** Les réglages propres à l'application (Paramètres › Application), gardés
 * sur cet appareil : quand verrouiller, et (plus tard) la zone de
 * notification. Le web et l'extension ne les voient pas. */

export interface AppLockSettings {
  /** Verrouiller quand la session Windows se verrouille (Win+L) ou que
   * l'ordinateur se met en veille. */
  onSystemLock: boolean;
  /** Verrouiller quand la fenêtre est réduite (pas par la saisie
   * automatique, qui la réduit pour taper ailleurs). */
  onMinimize: boolean;
  /** Ce que mesure « Verrouiller après » : l'activité dans GuiVault (le plus
   * sûr), ou sur tout l'ordinateur (qui tape avec le raccourci global depuis
   * d'autres fenêtres ne veut pas voir GuiVault se verrouiller sans cesse). */
  idleScope: "app" | "system";
}

export const DEFAULT_APP_LOCK: AppLockSettings = { onSystemLock: true, onMinimize: false, idleScope: "app" };

const KEY = "guivault.app.lock";

export function loadAppLock(): AppLockSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AppLockSettings> | null;
    return {
      onSystemLock: typeof raw?.onSystemLock === "boolean" ? raw.onSystemLock : DEFAULT_APP_LOCK.onSystemLock,
      onMinimize: typeof raw?.onMinimize === "boolean" ? raw.onMinimize : DEFAULT_APP_LOCK.onMinimize,
      idleScope: raw?.idleScope === "system" ? "system" : "app",
    };
  } catch {
    return DEFAULT_APP_LOCK;
  }
}

export function saveAppLock(s: AppLockSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // stockage indisponible : le réglage vaut pour cette fenêtre
  }
}

/** La zone de notification (Windows). */
export interface AppTraySettings {
  /** Fermer la fenêtre la range dans la zone de notification (le raccourci
   * de saisie automatique reste actif) ; sinon, fermer quitte. */
  closeToTray: boolean;
}

export const DEFAULT_APP_TRAY: AppTraySettings = { closeToTray: true };

const TRAY_KEY = "guivault.app.tray";

export function loadAppTray(): AppTraySettings {
  try {
    const raw = JSON.parse(localStorage.getItem(TRAY_KEY) ?? "null") as Partial<AppTraySettings> | null;
    return { closeToTray: typeof raw?.closeToTray === "boolean" ? raw.closeToTray : DEFAULT_APP_TRAY.closeToTray };
  } catch {
    return DEFAULT_APP_TRAY;
  }
}

export function saveAppTray(s: AppTraySettings) {
  try {
    localStorage.setItem(TRAY_KEY, JSON.stringify(s));
  } catch {
    // idem
  }
}

/** Pourquoi le système demande de verrouiller : session Windows, veille,
 * fenêtre réduite ou rangée dans la zone de notification (si on l'a
 * demandé), « Verrouiller » du menu de l'icône. */
export type LockReason = "session" | "veille" | "reduction" | "zone" | "menu";

export const LOCK_MESSAGES: Record<LockReason, string> = {
  session: "Verrouillé : la session Windows a été verrouillée.",
  veille: "Verrouillé : l'ordinateur s'est mis en veille.",
  reduction: "Verrouillé à la réduction de la fenêtre.",
  zone: "Verrouillé : GuiVault est passé dans la zone de notification.",
  menu: "Verrouillé depuis la zone de notification.",
};

/** Android : cacher l'écran aux captures et à l'aperçu des applications
 * récentes tant qu'un coffre est ouvert (`ScreenBridge`). Activé par défaut ;
 * il gêne les captures voulues, d'où le réglage. */
const SCREEN_KEY = "guivault.app.secureScreen";

export function loadSecureScreen(): boolean {
  try {
    return localStorage.getItem(SCREEN_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveSecureScreen(on: boolean) {
  try {
    localStorage.setItem(SCREEN_KEY, on ? "true" : "false");
  } catch {
    // stockage indisponible : le réglage vaut pour cette fois
  }
}

/** L'agent SSH (Paramètres › Agent SSH) : en marche ou non, et les clés
 * (ids d'éléments) qu'on lui confie quand le coffre est ouvert. */
export interface SshAgentSettings {
  enabled: boolean;
  keys: string[];
}

const SSH_AGENT_KEY = "guivault.app.sshAgent";
/** Émis sur `window` quand le réglage change (les composants se relisent). */
export const SSH_AGENT_CHANGED = "guivault-ssh-agent-settings";

export function loadSshAgent(): SshAgentSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SSH_AGENT_KEY) ?? "null") as Partial<SshAgentSettings> | null;
    return {
      enabled: raw?.enabled === true,
      keys: Array.isArray(raw?.keys) ? raw.keys.filter((k): k is string => typeof k === "string") : [],
    };
  } catch {
    return { enabled: false, keys: [] };
  }
}

export function saveSshAgent(s: SshAgentSettings) {
  try {
    localStorage.setItem(SSH_AGENT_KEY, JSON.stringify(s));
  } catch {
    // stockage indisponible : le réglage vaut pour cette fenêtre
  }
  window.dispatchEvent(new Event(SSH_AGENT_CHANGED));
}
