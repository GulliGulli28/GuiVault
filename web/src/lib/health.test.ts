/** Le rapport de santé : ce qui est faible, réutilisé, ancien, qui expire,
 * sans 2FA, et la recherche de fuites par k-anonymat. */
import { describe, expect, it } from "vitest";
import { allSecrets, checkPwned, countInRange, findExpiring, findMissingTotp, findOld, findReused, findWeak, sha1Hex, type HealthEntry } from "./health";
import type { Payload } from "./types";

const vault = { id: "v-1", name: "Personnel", role: "owner" as const };
const entry = (payload: Payload, createdAt = "2026-01-01T00:00:00Z"): HealthEntry => ({
  vault,
  item: { id: Object.values(payload).find((v) => typeof v === "object" && v !== null && "id" in v)!.id as string, revision: 1, updatedAt: createdAt, createdAt, ok: true, payload },
});
const login = (id: string, password: string, over: Record<string, unknown> = {}): Payload =>
  ({ kind: "login", login: { id, name: id, groupId: null, tags: [], username: "moi", password, uris: [], totp: null, passkeys: [], passwordHistory: [], ...over } }) as Payload;

describe("rapport de santé", () => {
  it("trouve les secrets faibles et réutilisés, identifiants, hôtes et clés confondus", () => {
    const entries = [
      entry(login("a", "azerty123")),
      entry(login("b", "correct-horse-battery-staple-9!")),
      entry(login("c", "correct-horse-battery-staple-9!")),
      entry({ kind: "host", host: { id: "h", label: "db1" }, secrets: { password: "correct-horse-battery-staple-9!", passphrase: "x" } } as unknown as Payload),
      entry({ kind: "key", key: { id: "k", name: "id_ed25519" }, passphrase: "" } as unknown as Payload),
    ];
    const secrets = allSecrets(entries);
    expect(secrets).toHaveLength(5);
    expect(findWeak(secrets).map((s) => s.entry.item.id).sort()).toEqual(["a", "h"]);
    const reused = findReused(secrets);
    expect(reused).toHaveLength(1);
    expect(reused[0].map((s) => s.entry.item.id)).toEqual(["b", "c", "h"]);
  });

  it("date un mot de passe par son dernier changement, sinon la création", () => {
    const now = new Date("2026-09-28T00:00:00Z");
    const entries = [
      entry(login("vieux", "p"), "2024-01-01T00:00:00Z"),
      entry(login("change", "p", { passwordHistory: [{ password: "ancien", changedAt: "2026-06-01T00:00:00Z" }] }), "2020-01-01T00:00:00Z"),
      entry(login("neuf", "p"), "2026-09-01T00:00:00Z"),
    ];
    const old = findOld(entries, now);
    expect(old.map((o) => o.entry.item.id)).toEqual(["vieux"]);
    expect(old[0].days).toBeGreaterThan(900);
  });

  it("signale clés d'API et cartes expirées ou qui expirent dans le mois", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    const apiKey = (id: string, expiresAt: string) => ({ kind: "api-key", apiKey: { id, name: id, expiresAt } }) as unknown as Payload;
    const card = (id: string, expMonth: string, expYear: string) => ({ kind: "card", card: { id, name: id, expMonth, expYear } }) as unknown as Payload;
    const found = findExpiring([
      entry(apiKey("expiree", "2026-09-01")),
      entry(apiKey("bientot", "2026-10-10")),
      entry(apiKey("loin", "2027-06-01")),
      entry(apiKey("sans", "")),
      entry(card("carte-fin-sept", "09", "26")),
      entry(card("carte-2030", "12", "2030")),
      entry(card("carte-vide", "", "")),
    ], now);
    expect(found.map((f) => [f.entry.item.id, f.expired])).toEqual([
      ["expiree", true],
      ["carte-fin-sept", false],
      ["bientot", false],
    ]);
  });

  it("repère les sites qui acceptent un code TOTP sans secret enregistré", () => {
    const sites = [{ name: "GitHub", domains: ["github.com"], documentation: "https://docs.github.com/2fa" }];
    const entries = [
      entry(login("sans", "p", { uris: [{ uri: "https://github.com/login", match: null }] })),
      entry(login("avec", "p", { uris: [{ uri: "https://gist.github.com", match: null }], totp: "JBSWY3DPEHPK3PXP" })),
      entry(login("passkey", "p", { uris: [{ uri: "github.com", match: null }], passkeys: [{}] })),
      entry(login("autre", "p", { uris: [{ uri: "https://exemple.fr", match: null }] })),
    ];
    const missing = findMissingTotp(entries, sites);
    expect(missing.map((m) => m.entry.item.id)).toEqual(["sans"]);
    expect(missing[0].site.name).toBe("GitHub");
  });

  it("cherche les fuites par k-anonymat : 5 caractères envoyés, un préfixe une fois", async () => {
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    expect(sha1Hex("password")).toBe("5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
    const body = "1D2DA4053E34E76F6576ED1DA63134B5E2A:2\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0";
    expect(countInRange(body, "1E4C9B93F3F0682250B6CF8331B7EE68FD8")).toBe(9659365);
    expect(countInRange(body, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")).toBe(0);
    const asked: string[] = [];
    const counts = await checkPwned(["password", "password", "un-secret-que-personne-na"], async (prefix) => {
      asked.push(prefix);
      return prefix === "5BAA6" ? body : "";
    });
    expect(asked.every((p) => /^[0-9A-F]{5}$/.test(p))).toBe(true);
    expect(asked.filter((p) => p === "5BAA6")).toHaveLength(1);
    expect(counts.get("password")).toBe(9659365);
    expect(counts.get("un-secret-que-personne-na")).toBe(0);
  });
});
