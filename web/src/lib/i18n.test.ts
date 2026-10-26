/** La langue de l'interface (`i18n.ts`) : la mécanique, et le catalogue
 * anglais complet — chaque texte écrit en dur (`t("…")`, `plural`, tables
 * `translated`) y a sa traduction, sans orphelin ni paramètre inventé. Un
 * texte qui manque : `node scripts/i18n.mjs` dit lesquels. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — script Node sans déclarations de types
import { contentCatalog, extractKeys, loadCatalog } from "../../scripts/i18n.mjs";
import contentText from "../../extension/src/contentText.json";
import { language, locale, plural, setLanguageSetting, t, translated } from "./i18n";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  setLanguageSetting("fr");
  vi.unstubAllGlobals();
});

describe("la mécanique", () => {
  it("traduit, place les paramètres, et rend le français sans traduction", () => {
    setLanguageSetting("fr");
    expect(language()).toBe("fr");
    expect(t("Enregistrer")).toBe("Enregistrer");
    setLanguageSetting("en");
    expect([language(), locale()]).toEqual(["en", "en-GB"]);
    expect(t("Enregistrer")).toBe("Save");
    expect(t("Copier {0} de {1}", "le mot de passe", "GitHub")).toBe("Copy le mot de passe of GitHub");
    expect(t("Un texte qui n'existe pas")).toBe("Un texte qui n'existe pas");
  });

  it("met le pluriel de chaque langue : 0 au singulier en français, au pluriel en anglais", () => {
    setLanguageSetting("fr");
    expect([0, 1, 2].map((n) => plural(n, "{0} élément", "{0} éléments"))).toEqual(["0 élément", "1 élément", "2 éléments"]);
    setLanguageSetting("en");
    expect([0, 1, 2].map((n) => plural(n, "{0} élément", "{0} éléments"))).toEqual(["0 items", "1 item", "2 items"]);
  });

  it("traduit les tables à la lecture, et suit la langue", () => {
    const table = translated({ a: "Enregistrer", list: [{ label: "Annuler", tone: "tag-danger" }] });
    setLanguageSetting("fr");
    expect(table.a).toBe("Enregistrer");
    setLanguageSetting("en");
    expect(table.a).toBe("Save");
    expect(table.list.map((x) => [x.label, x.tone])).toEqual([["Cancel", "tag-danger"]]);
  });
});

describe("le catalogue anglais", () => {
  const keys: Map<string, Set<string>> = extractKeys();
  const en: Record<string, string> = loadCatalog();

  it("traduit chaque texte de l'interface", () => {
    const missing = [...keys.entries()].filter(([k]) => !(k in en)).map(([k, files]) => `${k}  (${[...files].join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("n'a pas de traduction orpheline", () => {
    expect(Object.keys(en).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("n'invente pas de paramètre, et ne laisse aucune traduction vide", () => {
    const bad = Object.entries(en).filter(([fr, s]) => !s.trim() || (s.match(/\{\d+\}/g) ?? []).some((p) => !fr.includes(p)));
    expect(bad).toEqual([]);
  });

  it("donne au script de page de l'extension ses traductions à jour", () => {
    // Sinon : node scripts/i18n.mjs --content
    expect(contentText).toEqual(contentCatalog());
  });
});
