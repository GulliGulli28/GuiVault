/** Ce que le rapport de santé ne doit plus signaler : un vieux compte gardé
 * faible exprès, deux éléments voulus en double… Une clé par élément et par
 * problème (`vault:élément:type`), qui suit le compte comme les autres
 * réglages synchronisés (section `healthIgnored`, chiffrée sous la user key :
 * le serveur n'en voit que la taille). Le score, lui, ne change pas : il
 * dit l'état réel du coffre. */
import { useEffect, useState } from "react";
import { onSettingsApplied, registerSettingsSection, settingsChanged } from "./syncedSettings";

const KEY = "guivault.health.ignored";

export function issueKey(vaultId: string, itemId: string, kind: string): string {
  return `${vaultId}:${itemId}:${kind}`;
}

export function loadIgnored(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { keys?: unknown } | null;
    return new Set(Array.isArray(raw?.keys) ? raw.keys.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function save(keys: Set<string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ keys: [...keys] }));
  } catch {
    // sans stockage, le choix vaut pour cette page
  }
  settingsChanged("healthIgnored");
}

registerSettingsSection({
  key: "healthIgnored",
  read: () => ({ keys: [...loadIgnored()] }),
  write: (v) => {
    const keys = (v as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys)) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ keys: keys.filter((k) => typeof k === "string") }));
    } catch {
      // idem
    }
  },
});

/** Les clés ignorées, relues quand un autre appareil en change, et de quoi
 * en ignorer ou en reprendre une. */
export function useIgnored(): [Set<string>, (key: string, ignore: boolean) => void] {
  const [keys, setKeys] = useState(loadIgnored);
  useEffect(() => onSettingsApplied(() => setKeys(loadIgnored())), []);
  const set = (key: string, ignore: boolean) => {
    const next = new Set(loadIgnored());
    if (ignore) next.add(key);
    else next.delete(key);
    save(next);
    setKeys(next);
  };
  return [keys, set];
}
