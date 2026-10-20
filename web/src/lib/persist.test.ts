/** Le délai d'inactivité : il vaut aussi pour une session qui n'est pas
 * gardée dans l'onglet (un coffre local de l'application). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idleMs, saveLockMinutes, touchWebSession, webSessionIdle } from "./persist";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("inactivité", () => {
  it("compte depuis le dernier geste, même sans session gardée", () => {
    saveLockMinutes(5);
    const t0 = 1_900_000_000_000;
    touchWebSession(t0);
    expect(idleMs(t0 + 1000)).toBe(1000);
    expect(webSessionIdle(t0 + 4 * 60_000)).toBe(false);
    expect(webSessionIdle(t0 + 6 * 60_000)).toBe(true);
    touchWebSession(t0 + 6 * 60_000);
    expect(webSessionIdle(t0 + 7 * 60_000)).toBe(false);
  });

  it("« jamais » ne verrouille pas", () => {
    saveLockMinutes(0);
    touchWebSession(1_900_000_000_000);
    expect(webSessionIdle(1_900_000_000_000 + 24 * 3_600_000)).toBe(false);
  });
});
