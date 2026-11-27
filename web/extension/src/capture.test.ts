import { describe, expect, it } from "vitest";
import { type Candidate, classifyCapture } from "./capture";

const a: Candidate = { id: "a", name: "a.example.com", username: "moi", password: "pa", score: 1 };
const b: Candidate = { id: "b", name: "b.example.com", username: "moi", password: "pb", score: 3 };

describe("enregistrer après une connexion", () => {
  it("le bon mot de passe d'un autre sous-domaine : rien à proposer", () => {
    expect(classifyCapture([a, b], "moi", "pb", null)).toBeNull();
    expect(classifyCapture([a, b], "MOI", "pa", null)).toBeNull();
  });

  it("un nouveau mot de passe : l'identifiant de la page, pas le premier venu", () => {
    expect(classifyCapture([a, b], "moi", "nouveau", null)).toEqual({ mode: "update", loginId: "b", loginName: "b.example.com" });
  });

  it("celui qu'on vient de remplir passe avant", () => {
    expect(classifyCapture([a, b], "moi", "nouveau", "a")).toEqual({ mode: "update", loginId: "a", loginName: "a.example.com" });
  });

  it("seulement un autre sous-domaine avec ce nom : un nouvel identifiant", () => {
    expect(classifyCapture([a], "moi", "nouveau", null)).toEqual({ mode: "new", loginId: null, loginName: null });
  });

  it("un autre nom : un nouvel identifiant ; un mot de passe seul déjà là : rien", () => {
    expect(classifyCapture([b], "autre", "x", null)?.mode).toBe("new");
    expect(classifyCapture([{ ...b, username: "" }], "autre", "pb", null)).toBeNull();
  });
});
