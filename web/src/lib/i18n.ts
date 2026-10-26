/** La langue de l'interface (Paramètres › Apparence › Langue).
 *
 * Façon gettext : le texte français **est** la clé — `t("Enregistrer")` —,
 * l'anglais vit dans `src/i18n/en.json`. Le code reste lisible, et un texte
 * pas encore traduit s'affiche en français plutôt qu'en clé. `i18n.test.ts`
 * vérifie que chaque `t("…")` écrit en dur a sa traduction.
 *
 * Paramètres : `t("{0} éléments", n)` — positionnels, dans l'ordre où le
 * français les cite ; la traduction les place où elle veut. Pluriel :
 * `plural(n, "{0} élément", "{0} éléments")`, chaque forme étant une clé.
 *
 * La langue est réglée par appareil (`localStorage`), « Système » par
 * défaut : le français si le navigateur le préfère, l'anglais sinon. En
 * changer redessine toute l'interface (`useLanguage` à la racine). */
import { useSyncExternalStore } from "react";
import en from "../i18n/en.json";

export type Language = "fr" | "en";
export type LanguageSetting = Language | "system";

const KEY = "guivault.language";
const catalogs: Record<Language, Record<string, string> | null> = { fr: null, en: en as Record<string, string> };

function systemLanguage(): Language {
  const langs = (typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []).filter(Boolean);
  // Rien à lire (tests, environnement sans navigateur) : la langue d'origine.
  if (!langs.length) return "fr";
  for (const l of langs) {
    const base = l.toLowerCase().split("-")[0];
    if (base === "fr") return "fr";
    if (base === "en") return "en";
  }
  return "en";
}

/** Un réglage lu d'ailleurs (stockage de l'extension), validé. */
export function asLanguageSetting(v: unknown): LanguageSetting {
  return v === "fr" || v === "en" ? v : "system";
}

export function loadLanguageSetting(): LanguageSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === "fr" || v === "en" ? v : "system";
  } catch {
    return "system";
  }
}

function resolve(s: LanguageSetting): Language {
  return s === "system" ? systemLanguage() : s;
}

let current: Language = resolve(loadLanguageSetting());
const listeners = new Set<() => void>();

function apply() {
  if (typeof document !== "undefined") document.documentElement.lang = current;
}
apply();

/** La langue en vigueur. */
export function language(): Language {
  return current;
}

/** La locale pour `Intl` et `toLocale…String` (dates, nombres). */
export function locale(): string {
  return current === "fr" ? "fr-FR" : "en-GB";
}

let mirror: ((s: LanguageSetting) => void) | null = null;

/** L'extension recopie le réglage là où son service worker et ses scripts de
 * page le lisent (`chrome.storage.local`). */
export function setLanguageMirror(fn: ((s: LanguageSetting) => void) | null) {
  mirror = fn;
}

export function setLanguageSetting(s: LanguageSetting) {
  try {
    if (s === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, s);
  } catch {
    // stockage indisponible : le réglage vaut pour cette fenêtre
  }
  mirror?.(s);
  applyLanguageSetting(s);
}

/** Applique un réglage lu ailleurs (service worker de l'extension), sans
 * l'écrire. */
export function applyLanguageSetting(s: LanguageSetting) {
  const next = resolve(s);
  if (next === current) return;
  current = next;
  apply();
  for (const l of listeners) l();
}

/** À la racine : redessine l'interface quand la langue change. */
export function useLanguage(): Language {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => current,
  );
}

/** Traduit `fr` (le texte français, qui sert de clé) et y place les
 * paramètres `{0}`, `{1}`… */
export function t(fr: string, ...args: (string | number)[]): string {
  const out = catalogs[current]?.[fr] ?? fr;
  return args.length ? out.replace(/\{(\d+)\}/g, (m, i: string) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m)) : out;
}

/** Singulier ou pluriel selon `n` (le français met 0 et 1 au singulier,
 * l'anglais seulement 1), `n` comme premier paramètre. */
export function plural(n: number, one: string, many: string, ...args: (string | number)[]): string {
  const single = current === "fr" ? Math.abs(n) < 2 : Math.abs(n) === 1;
  return t(single ? one : many, n, ...args);
}

/** Une table de libellés (par type, par rôle, une liste de catégories…)
 * traduite **à la lecture** : elle reste une constante du module, et suit
 * pourtant la langue. Sans `fields`, toute chaîne est traduite (table
 * `clé → libellé`) ; avec, seulement les champs nommés, à toute profondeur
 * (listes d'objets, tables d'objets). */
export function translated<T extends object>(table: T, fields?: string[]): T {
  return new Proxy(table, {
    get: (target, prop, receiver) => {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v === "string") return !fields || (typeof prop === "string" && fields.includes(prop)) ? t(v) : v;
      if (v && typeof v === "object") return translated(v as object, fields);
      return v;
    },
  });
}
