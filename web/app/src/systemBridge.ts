/** Le pont système (`src/lib/platform.ts`) : verrouiller quand la session
 * Windows se verrouille ou que l'ordinateur se met en veille (événement
 * `system-lock` de `app-tauri/src/system.rs`), à la réduction de la fenêtre
 * si on l'a demandé, et l'inactivité de tout l'ordinateur. Les réglages
 * (`appSettings.ts`) sont relus à chaque avis. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadAppLock, loadAppTray, type LockReason } from "../../src/lib/appSettings";
import { setSystemBridge } from "../../src/lib/platform";
import { autoTypeRunning } from "./windowFlags";

export async function installSystem(): Promise<void> {
  const handlers = new Set<(r: LockReason) => void>();
  const fire = (r: LockReason) => handlers.forEach((h) => h(r));

  await listen<string>("system-lock", (e) => {
    const lock = loadAppLock();
    if ((e.payload === "session" || e.payload === "veille") && lock.onSystemLock) fire(e.payload);
    // Rangée dans la zone de notification : comme une réduction.
    else if (e.payload === "zone" && lock.onMinimize) fire("zone");
    else if (e.payload === "menu") fire("menu");
  });
  const w = getCurrentWindow();
  await w.onResized(() => {
    if (!loadAppLock().onMinimize || autoTypeRunning()) return;
    void w.isMinimized().then((min) => { if (min) fire("reduction"); });
  });

  const systemEvents = (await invoke<number | null>("system_idle_ms").catch(() => null)) !== null;
  const tray = await invoke<boolean>("app_tray_available").catch(() => false);
  const setCloseToTray = (enabled: boolean) => invoke<void>("app_set_close_to_tray", { enabled });
  if (tray) await setCloseToTray(loadAppTray().closeToTray).catch(() => {});
  setSystemBridge({
    systemEvents,
    tray,
    setCloseToTray,
    autostart: (enabled) => invoke<boolean>("app_autostart", { enabled: enabled ?? null }),
    browserIntegration: (enabled) => invoke<boolean>("app_browser_integration", { enabled: enabled ?? null }),
    onLock(handler) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    idleMs: () => invoke<number | null>("system_idle_ms").catch(() => null),
  });
}
