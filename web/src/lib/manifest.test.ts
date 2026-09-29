/** Les cas de `guivault_crypto::manifest` (tests unitaires), côté web ;
 * l'interopérabilité avec Rust est dans `crypto.test.ts`. */
import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes";
import * as c from "./crypto";
import { itemDigest, manifestOf, nextManifest, problemText, sealManifest, verifyManifest, type ManifestProblem } from "./manifest";

const VAULT = "11111111-2222-3333-4444-555555555555";

function setup() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const items = ["a", "b", "c"].map((n) => {
    const id = `${n}aaaaaaa-0000-4000-8000-000000000000`;
    return { id, ciphertext: c.sealItem(key, VAULT, id, "note", utf8.encode(n)) };
  });
  return { key, items };
}

const served = (counter: number, ciphertext: Uint8Array) => ({ revision: counter, ciphertext });

describe("manifeste de vault", () => {
  it("laisse passer un serveur fidèle", () => {
    const { key, items } = setup();
    const m = manifestOf(3, items);
    const v = verifyManifest(key, VAULT, served(3, sealManifest(key, VAULT, m)), items, 2);
    expect(v.problems).toEqual([]);
    expect(v.manifest).toEqual(m);
    // Vault d'avant les manifestes, jamais vu avec : rien à dire.
    expect(verifyManifest(key, VAULT, null, items, null).problems).toEqual([]);
  });

  it("voit un item rejoué, retenu, ressuscité, et un manifeste qui recule", () => {
    const { key, items } = setup();
    const blob = sealManifest(key, VAULT, manifestOf(5, items));
    const withheld = items.splice(2, 1)[0].id;
    items[1] = { id: items[1].id, ciphertext: c.sealItem(key, VAULT, items[1].id, "note", utf8.encode("ancien")) };
    const intruder = "dddddddd-0000-4000-8000-000000000000";
    items.push({ id: intruder, ciphertext: c.sealItem(key, VAULT, intruder, "note", utf8.encode("x")) });
    expect(verifyManifest(key, VAULT, served(5, blob), items, 7).problems).toEqual<ManifestProblem[]>([
      { kind: "rollback", counter: 5, seen: 7 },
      { kind: "altered", itemId: items[1].id },
      { kind: "unexpected", itemId: intruder },
      { kind: "withheld", itemId: withheld },
    ]);
  });

  it("voit un compteur échangé, un manifeste disparu ou contrefait", () => {
    const { key, items } = setup();
    const blob = sealManifest(key, VAULT, manifestOf(4, items));
    expect(verifyManifest(key, VAULT, served(6, blob), items, null).problems).toEqual([{ kind: "mismatch", counter: 4, revision: 6 }]);
    expect(verifyManifest(key, VAULT, null, items, 4).problems).toEqual([{ kind: "missing", seen: 4 }]);
    // Un chiffré d'item servi comme manifeste : l'AAD diffère.
    expect(verifyManifest(key, VAULT, served(4, items[0].ciphertext), items, null).problems).toEqual([{ kind: "unreadable" }]);
    // Un manifeste d'un autre vault non plus.
    const other = sealManifest(key, "autre", manifestOf(4, items));
    expect(verifyManifest(key, VAULT, served(4, other), items, null).problems).toEqual([{ kind: "unreadable" }]);
  });

  it("suivant, ajout, retrait, empreinte", () => {
    const { items } = setup();
    const m = manifestOf(2, items);
    const n = nextManifest(m, 2);
    delete n.items[items[0].id];
    n.items.new = itemDigest(utf8.encode("ct"));
    expect(n.counter).toBe(3);
    expect(n.items[items[0].id]).toBeUndefined();
    // Le suivant est une copie : l'original ne bouge pas.
    expect(m.items[items[0].id]).toBeDefined();
    expect(itemDigest(utf8.encode("abc"))).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });

  it("nomme l'élément en cause quand on le connaît", () => {
    const p: ManifestProblem = { kind: "withheld", itemId: "x" };
    expect(problemText(p, (id) => (id === "x" ? "Banque" : undefined))).toContain("« Banque »");
    expect(problemText(p)).toContain("l'élément x");
  });
});
