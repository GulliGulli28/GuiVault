/** La couleur de chaque vault : la pastille de la barre latérale, de
 * l'accueil, des résultats de recherche. Une préférence de l'utilisateur
 * (pas une donnée du vault : chaque membre choisit la sienne), gardée dans
 * `localStorage` et synchronisée avec le compte (section `vaultColors`,
 * `settingsSections.ts`). Sans choix, une couleur tirée de l'id ; le vault
 * personnel prend l'accent par défaut. */
import { useEffect, useState } from "react";
import { ACCENT_COLORS, type UiAccent } from "./preferences";
import { onSettingsApplied, settingsChanged } from "./syncedSettings";

const STORAGE_KEY = "guivault.vaultColors";
const EVENT = "guivault-vault-colors";

/** Les couleurs proposées, dans l'ordre du sélecteur. */
export const VAULT_COLORS: UiAccent[] = ["pervenche", "amber", "emerald", "rose", "cyan", "violet", "teal", "blue", "indigo"];

function load(): Record<string, UiAccent> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    const out: Record<string, UiAccent> = {};
    for (const [id, c] of Object.entries(parsed)) if (c in ACCENT_COLORS) out[id] = c as UiAccent;
    return out;
  } catch {
    return {};
  }
}

/** Le nom de couleur d'un vault : choisi, ou tiré de son id. */
export function vaultColorName(id: string, personal = false, chosen = load()): UiAccent {
  const c = chosen[id];
  if (c) return c;
  if (personal) return "pervenche";
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return VAULT_COLORS[1 + (h % (VAULT_COLORS.length - 1))];
}

/** La couleur affichable (`c500` de l'accent nommé). */
export function vaultColor(id: string, personal = false, chosen = load()): string {
  return ACCENT_COLORS[vaultColorName(id, personal, chosen)].c500;
}

export function setVaultColor(id: string, color: UiAccent): void {
  const all = { ...load(), [id]: color };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Sans stockage, la couleur vaut pour la page.
  }
  settingsChanged("vaultColors");
  window.dispatchEvent(new Event(EVENT));
}

/** Les couleurs choisies, relues quand elles changent ici ou arrivent d'un
 * autre appareil. */
export function useVaultColors(): Record<string, UiAccent> {
  const [colors, setColors] = useState(load);
  useEffect(() => {
    const on = () => setColors(load());
    window.addEventListener(EVENT, on);
    const off = onSettingsApplied(on);
    return () => {
      window.removeEventListener(EVENT, on);
      off();
    };
  }, []);
  return colors;
}
