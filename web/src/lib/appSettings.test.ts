import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_LOCK, loadAppLock, saveAppLock } from "./appSettings";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

describe("réglages de verrouillage de l'application", () => {
  it("par défaut : verrouiller avec la session, pas à la réduction, inactivité dans GuiVault", () => {
    expect(loadAppLock()).toEqual(DEFAULT_APP_LOCK);
    expect(DEFAULT_APP_LOCK).toEqual({ onSystemLock: true, onMinimize: false, idleScope: "app" });
  });

  it("relit ce qui a été enregistré, et ignore ce qui ne se lit pas", () => {
    saveAppLock({ onSystemLock: false, onMinimize: true, idleScope: "system" });
    expect(loadAppLock()).toEqual({ onSystemLock: false, onMinimize: true, idleScope: "system" });
    localStorage.setItem("guivault.app.lock", JSON.stringify({ onSystemLock: "oui", idleScope: "partout" }));
    expect(loadAppLock()).toEqual(DEFAULT_APP_LOCK);
    localStorage.setItem("guivault.app.lock", "{pas du json");
    expect(loadAppLock()).toEqual(DEFAULT_APP_LOCK);
  });
});
