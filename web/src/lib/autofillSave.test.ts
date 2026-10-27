/** « Enregistrer dans GuiVault ? » : que faire d'une connexion tapée
 * ailleurs (`autofillSave.ts`). */
import { describe, expect, it } from "vitest";
import type { VaultItem } from "./allItems";
import { emptyPayload } from "./items";
import { planSave } from "./autofillSave";
import type { CapturedLogin } from "./platform";
import type { Payload, Role } from "./types";

function login(id: string, vault: { id: string; kind: "personal" | "shared"; role: Role; emergency?: unknown }, username: string, password: string, uri: string): VaultItem {
  const p = emptyPayload("login") as Extract<Payload, { kind: "login" }>;
  Object.assign(p.login, { id, name: id, username, password, uris: [{ uri }] });
  return { vault, item: { id, ok: true, payload: p } } as unknown as VaultItem;
}

const personal = { id: "p", kind: "personal" as const, role: "owner" as Role };
const shared = { id: "s", kind: "shared" as const, role: "reader" as Role };
const capture = (c: Partial<CapturedLogin>): CapturedLogin => ({ username: "alice", password: "neuf", domain: "github.com", pkg: "com.android.chrome", label: "github.com", ...c });

describe("enregistrer une connexion", () => {
  it("rien à faire si elle y est déjà, avec ce mot de passe", () => {
    const items = [login("a", personal, "Alice", "neuf", "https://www.github.com/login")];
    expect(planSave(items, [personal, shared], capture({}))).toMatchObject({ kind: "same" });
  });

  it("met à jour le mot de passe du même compte, sur le même site", () => {
    const items = [login("a", personal, "alice", "ancien", "github.com"), login("b", personal, "bob", "x", "github.com")];
    const plan = planSave(items, [personal, shared], capture({}));
    expect(plan?.kind).toBe("update");
    if (plan?.kind !== "update" || plan.draft.kind !== "login") throw new Error("plan");
    expect([plan.item.item.id, plan.draft.login.password, plan.draft.login.username]).toEqual(["a", "neuf", "alice"]);
  });

  it("crée un identifiant dans le vault personnel, même vide, pour le site ou l'application", () => {
    const items = [login("a", shared, "alice", "ancien", "github.com")];
    const web = planSave(items, [personal, shared], capture({}));
    // Le vault partagé est en lecture seule : pas de mise à jour là.
    expect(web?.kind).toBe("new");
    const app = planSave([], [personal], capture({ domain: null, pkg: "com.banque.app", label: "Ma Banque" }));
    if (app?.kind !== "new" || app.draft.kind !== "login") throw new Error("plan");
    expect([app.vaultId, app.draft.login.name, app.draft.login.uris]).toEqual(["p", "Ma Banque", [{ uri: "androidapp://com.banque.app" }]]);
  });

  it("une application ne prend pas l'identifiant d'un site, ni l'inverse", () => {
    const items = [login("a", personal, "alice", "ancien", "androidapp://com.github.android")];
    expect(planSave(items, [personal, shared], capture({}))?.kind).toBe("new");
    expect(planSave(items, [personal, shared], capture({ domain: null, pkg: "com.github.android" }))?.kind).toBe("update");
  });

  it("sans vault où écrire, rien", () => {
    expect(planSave([login("a", shared, "x", "y", "example.org")], [shared], capture({}))).toBeNull();
  });
});
