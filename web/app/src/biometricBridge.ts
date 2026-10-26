/** Le pont de la biométrie (`src/lib/platform.ts`) vers le plugin Kotlin de
 * l'application Android (`app-tauri/src/biometric.rs`, `BiometricPlugin.kt`).
 * Ailleurs, la commande n'existe pas : pas de pont. */
import { invoke } from "@tauri-apps/api/core";
import { setBiometricBridge, type BiometricBridge } from "../../src/lib/platform";
import { t } from "../../src/lib/i18n";

export async function installBiometric(): Promise<void> {
  const status = await invoke<{ value: string }>("plugin:biometric|status").then((r) => r.value, () => null);
  if (!status) return;
  const bridge: BiometricBridge = {
    status: () => invoke<{ value: "ready" | "not-enrolled" | "unavailable" }>("plugin:biometric|status").then((r) => r.value),
    state: (id) => invoke("plugin:biometric|state", { id }),
    enable: (id, secret) => invoke("plugin:biometric|enable", { id, secret, title: t("Déverrouillage biométrique") }),
    unlock: (id, subtitle) => invoke("plugin:biometric|unlock", { id, title: t("Déverrouiller GuiVault"), subtitle }),
    touch: (id) => invoke<void>("plugin:biometric|touch", { id }),
    disable: (id) => invoke<void>("plugin:biometric|disable", { id }),
  };
  setBiometricBridge(bridge);
}
