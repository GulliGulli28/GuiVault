/** `t()` du script de page : même principe que `src/lib/i18n.ts` (le texte
 * français est la clé), mais avec ses seules traductions
 * (`contentText.json`, `node scripts/i18n.mjs --content`) — le catalogue
 * entier pèserait sur chaque page. La langue est celle réglée dans le popup
 * (`chrome.storage.local`), sinon celle du navigateur. */
import en from "./contentText.json";

type Language = "fr" | "en";

function fromBrowser(): Language {
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = (l ?? "").toLowerCase().split("-")[0];
    if (base === "fr" || base === "en") return base;
  }
  return "en";
}

let current: Language = fromBrowser();
const apply = (v: unknown) => {
  current = v === "fr" || v === "en" ? v : fromBrowser();
};
try {
  void chrome.storage.local.get("language").then((r) => apply(r.language)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.language) apply(changes.language.newValue);
  });
} catch {
  // hors extension (tests) : la langue du navigateur
}

export function t(fr: string, ...args: (string | number)[]): string {
  const out = current === "en" ? ((en as Record<string, string>)[fr] ?? fr) : fr;
  return args.length ? out.replace(/\{(\d+)\}/g, (m, i: string) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m)) : out;
}
