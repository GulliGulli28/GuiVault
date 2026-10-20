import { describe, expect, it } from "vitest";
import { AutoTypeError, DEFAULT_SEQUENCE, matchWindow, parseSequence, resolveSequence, sequenceError, titleMatches } from "./autotype";
import { emptyLogin } from "./items";
import { totpCode, parseTotp } from "./totp";
import type { Login } from "./types";

const login = (patch: Partial<Login> = {}): Login => ({ ...emptyLogin(), name: "GitHub", username: "alice", password: "p{a}ss", uris: [{ uri: "https://github.com/login", match: null }], ...patch });

describe("séquences", () => {
  it("la séquence par défaut : utilisateur, Tab, mot de passe, Entrée", async () => {
    expect(await resolveSequence(DEFAULT_SEQUENCE, login())).toEqual([
      { kind: "text", text: "alice" },
      { kind: "key", key: "Tab" },
      { kind: "text", text: "p{a}ss" },
      { kind: "key", key: "Enter" },
    ]);
  });

  it("noms sans casse, texte littéral, accolades échappées, répétitions et pauses", async () => {
    const a = await resolveSequence("{username}@{{}x{}}{tab 2}{DELAY 250}{Title}", login());
    expect(a).toEqual([
      { kind: "text", text: "alice@{x}" },
      { kind: "key", key: "Tab" },
      { kind: "key", key: "Tab" },
      { kind: "delay", ms: 250 },
      { kind: "text", text: "GitHub" },
    ]);
  });

  it("champs personnalisés, URL, notes et code TOTP du moment", async () => {
    const l = login({ notes: "n", totp: "JBSWY3DPEHPK3PXP", fields: [{ name: "PIN", value: "1234", type: "hidden" }] });
    const now = 1_800_000_000_000;
    const code = await totpCode(parseTotp("JBSWY3DPEHPK3PXP")!, now);
    expect(await resolveSequence("{S:pin}|{URL}|{NOTES}|{TOTP}", l, now)).toEqual([{ kind: "text", text: `1234|https://github.com/login|n|${code}` }]);
  });

  it("refuse ce qu'elle ne comprend pas, plutôt que de le taper", async () => {
    for (const [seq, msg] of [
      ["{USERNAEM}", /inconnu/],
      ["{TAB", /sans fermante/],
      ["a}b", /sans ouvrante/],
      ["{DELAY}", /durée/],
      ["{DELAY 99999}", /au plus/],
      ["{TAB 0}", /de 1 à/],
      ["{PASSWORD 2}", /ne se répète pas/],
      ["{S:}", /nom du champ/],
    ] as const) {
      expect(() => parseSequence(seq), seq).toThrowError(msg);
      expect(sequenceError(seq)).toMatch(msg);
    }
    expect(sequenceError(DEFAULT_SEQUENCE)).toBeNull();
    await expect(resolveSequence("{TOTP}", login())).rejects.toThrowError(AutoTypeError);
    await expect(resolveSequence("{S:PIN}", login())).rejects.toThrowError(/pas de champ « PIN »/);
  });

  it("un champ vide ne tape rien", async () => {
    expect(await resolveSequence("{USERNAME}{TAB}", login({ username: "" }))).toEqual([{ kind: "key", key: "Tab" }]);
  });
});

describe("fenêtres", () => {
  it("motifs : * pour n'importe quoi, sans casse, sur tout le titre", () => {
    expect(titleMatches("*github*firefox", "Sign in to GitHub · GitHub — Mozilla Firefox")).toBe(true);
    expect(titleMatches("GitHub", "Sign in to GitHub")).toBe(false);
    expect(titleMatches("Connexion (1.2)?", "connexion (1.2)?")).toBe(true);
    expect(titleMatches("  ", "x")).toBe(false);
  });

  it("propose d'abord les motifs associés, puis le nom dans le titre, puis le domaine", () => {
    const items = [
      login({ id: "nom", name: "GitHub" }),
      login({ id: "domaine", name: "Travail", uris: [{ uri: "https://www.github.com", match: null }] }),
      login({ id: "motif", name: "Perso", uris: [], autoType: { windows: [{ title: "*GitHub*Firefox", sequence: "{PASSWORD}{ENTER}" }] } }),
      login({ id: "éteint", name: "GitHub", autoType: { enabled: false } }),
      login({ id: "autre", name: "Banque", uris: [] }),
    ];
    const m = matchWindow("Sign in to GitHub · github.com — Mozilla Firefox", items, (x) => x);
    expect(m.map((x) => [x.item.id, x.reason, x.sequence])).toEqual([
      ["motif", "window", "{PASSWORD}{ENTER}"],
      ["nom", "title", DEFAULT_SEQUENCE],
      ["domaine", "url", DEFAULT_SEQUENCE],
    ]);
  });

  it("la séquence de l'identifiant, à défaut celle de l'application", () => {
    const items = [login({ autoType: { sequence: "{PASSWORD}" } }), login({ id: "b" })];
    expect(matchWindow("GitHub", items, (x) => x, "{USERNAME}").map((x) => x.sequence)).toEqual(["{PASSWORD}", "{USERNAME}"]);
  });

  it("un nom d'une lettre ou un titre vide ne proposent rien", () => {
    expect(matchWindow("Bloc-notes", [login({ name: "B", uris: [] })], (x) => x)).toEqual([]);
    expect(matchWindow("   ", [login()], (x) => x)).toEqual([]);
  });
});
