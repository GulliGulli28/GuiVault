/** Où remplir quand la page a des cadres : un cadre est son propre site. */
import { describe, expect, it } from "vitest";
import { parentUrl, pickFrame, senderUrl, shortcutFrame, type FrameCandidate } from "./frames";

const info = (url: string, o: Partial<FrameCandidate["info"]> = {}) => ({ url, password: false, username: false, otp: false, focused: false, ...o });

describe("l'URL qui décide des correspondances", () => {
  it("est celle de l'onglet pour le cadre principal, celle du cadre sinon", () => {
    const tab = { url: "https://banque.test/connexion" };
    expect(senderUrl({ frameId: 0, url: "https://banque.test/connexion", tab })).toBe("https://banque.test/connexion");
    expect(senderUrl({ frameId: 3, url: "https://pub.test/cadre", tab })).toBe("https://pub.test/cadre");
    expect(parentUrl({ frameId: 3, url: "https://pub.test/cadre", tab })).toBe("https://banque.test/connexion");
    expect(parentUrl({ frameId: 0, tab })).toBeUndefined();
  });

  it("prend l'origine héritée d'un cadre about:blank, et rien pour ce qui n'est pas web", () => {
    const tab = { url: "https://banque.test/" };
    expect(senderUrl({ frameId: 2, url: "about:blank", origin: "https://banque.test", tab })).toBe("https://banque.test/");
    expect(senderUrl({ frameId: 2, url: "about:blank", origin: "null", tab })).toBeUndefined();
    expect(senderUrl({ frameId: 0, tab: { url: "chrome://settings" } })).toBeUndefined();
  });
});

describe("le cadre où remplir un identifiant du popup", () => {
  const banque = (u: string) => u.startsWith("https://banque.test");
  const fournisseur = (u: string) => u.startsWith("https://login.fournisseur.test");

  it("remplit la page elle-même quand elle a le formulaire", () => {
    const frames = [{ frameId: 0, info: info("https://banque.test/", { password: true }) }, { frameId: 5, info: info("https://pub.test/", { password: true }) }];
    expect(pickFrame(frames, banque, "credentials")).toEqual({ fill: 0 });
  });

  it("remplit le cadre du fournisseur quand l'identifiant est le sien", () => {
    const frames = [{ frameId: 0, info: info("https://banque.test/") }, { frameId: 4, info: info("https://login.fournisseur.test/", { password: true, username: true }) }];
    expect(pickFrame(frames, fournisseur, "credentials")).toEqual({ fill: 4 });
  });

  it("ne remplit pas un cadre d'un autre site sans le demander", () => {
    const frames = [{ frameId: 0, info: info("https://banque.test/") }, { frameId: 7, info: info("https://pub.test/formulaire", { password: true }) }];
    expect(pickFrame(frames, banque, "credentials")).toEqual({ confirm: 7, host: "pub.test" });
  });

  it("préfère le cadre qui a le focus, puis celui qui a un mot de passe", () => {
    const frames = [
      { frameId: 0, info: info("https://banque.test/", { username: true }) },
      { frameId: 2, info: info("https://banque.test/cadre-a", { password: true }) },
      { frameId: 3, info: info("https://banque.test/cadre-b", { password: true, focused: true }) },
    ];
    expect(pickFrame(frames, banque, "credentials")).toEqual({ fill: 3 });
    frames[2].info.focused = false;
    expect(pickFrame(frames, banque, "credentials")).toEqual({ fill: 2 });
  });

  it("cherche un champ de code pour un TOTP, et rien sans champ", () => {
    const frames = [{ frameId: 0, info: info("https://banque.test/", { password: true }) }, { frameId: 1, info: info("https://banque.test/2fa", { otp: true }) }];
    expect(pickFrame(frames, banque, "totp")).toEqual({ fill: 1 });
    expect(pickFrame([{ frameId: 0, info: info("https://banque.test/") }], banque, "credentials")).toBeNull();
  });
});

describe("le cadre du raccourci clavier", () => {
  it("est celui qui a le focus, sinon celui qui a un formulaire", () => {
    expect(shortcutFrame([{ frameId: 0, info: info("https://a.test/", { username: true }) }, { frameId: 6, info: info("https://b.test/", { password: true, focused: true }) }])).toBe(6);
    expect(shortcutFrame([{ frameId: 0, info: info("https://a.test/") }, { frameId: 6, info: info("https://b.test/", { password: true }) }])).toBe(6);
    expect(shortcutFrame([{ frameId: 0, info: info("https://a.test/") }])).toBe(0);
  });
});
