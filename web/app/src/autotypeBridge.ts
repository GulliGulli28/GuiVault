/** Le pont de la saisie automatique (`src/lib/platform.ts`) vers les
 * commandes de `app-tauri/src/autotype.rs`. Posé seulement si l'application
 * sait taper sur ce système (Windows pour l'instant).
 *
 * Le raccourci pressé coffre verrouillé : la demande attend (deux minutes au
 * plus) que le coffre s'ouvre, et la saisie se fait juste après — comme
 * KeePass, qui demande son mot de passe puis tape. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadAutoTypeSettings } from "../../src/lib/autotype";
import { setAutoTypeBridge, type AutoTypeBridge, type AutoTypeRequest } from "../../src/lib/platform";

const PENDING_MAX_MS = 2 * 60_000;

/** Une erreur de l'hôte (`{ code, message }`) en `Error`, son code gardé. */
function toError(e: unknown): Error {
  if (e && typeof e === "object" && "message" in e) return Object.assign(new Error(String((e as { message: unknown }).message)), { code: (e as { code?: unknown }).code });
  return e instanceof Error ? e : new Error(String(e));
}

export async function installAutoType(): Promise<void> {
  const available = await invoke<boolean>("autotype_available").catch(() => false);
  if (!available) return;

  const handlers = new Set<(r: AutoTypeRequest) => void>();
  let pending: { request: AutoTypeRequest; at: number } | null = null;

  const bridge: AutoTypeBridge = {
    type: (actions, target) => invoke<void>("autotype_type", { actions, target: target ?? null }).catch((e) => { throw toError(e); }),
    setHotkey: (accelerator) => invoke<void>("autotype_set_hotkey", { accelerator }).catch((e) => { throw toError(e); }),
    onRequest(handler) {
      handlers.add(handler);
      if (pending && Date.now() - pending.at < PENDING_MAX_MS) {
        const r = pending.request;
        pending = null;
        handler(r);
      }
      pending = null;
      return () => void handlers.delete(handler);
    },
    async focusApp() {
      const w = getCurrentWindow();
      await w.unminimize();
      await w.show();
      await w.setFocus();
    },
  };

  await listen<AutoTypeRequest>("autotype-request", (e) => {
    if (handlers.size === 0) {
      // Coffre verrouillé : on le montre, la demande attend l'ouverture.
      pending = { request: e.payload, at: Date.now() };
      void bridge.focusApp();
      return;
    }
    handlers.forEach((h) => h(e.payload));
  });
  setAutoTypeBridge(bridge);

  const { hotkey } = loadAutoTypeSettings();
  if (hotkey) await bridge.setHotkey(hotkey).catch((e) => console.warn("Raccourci de saisie automatique :", e));
}
