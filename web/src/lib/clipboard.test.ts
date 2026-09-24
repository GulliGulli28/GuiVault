/** L'effacement du presse-papiers dans une page (`scheduleInPage`) : même
 * règle que Guiterm — n'effacer que ce qui est encore à nous. */
import { describe, expect, it } from "vitest";
import { scheduleInPage, type PageClipboard } from "./clipboard";

/** Un presse-papiers, un focus et des minuteries qu'on fait avancer à la main. */
function fakePage({ canRead = true, focused = true, writeNeedsGesture = false } = {}) {
  const state = { clipboard: "", focused, inGesture: false };
  const listeners = { blur: new Set<() => void>(), focus: new Set<() => void>(), copy: new Set<() => void>(), gesture: new Set<() => void>() };
  let timers: { at: number; f: () => void }[] = [];
  let now = 0;
  const io: PageClipboard = {
    write: async (t) => {
      if (writeNeedsGesture && !state.inGesture) throw new Error("Write permission denied.");
      state.clipboard = t;
    },
    read: async () => (canRead ? state.clipboard : null),
    hasFocus: () => state.focused,
    on: (event, f) => { listeners[event].add(f); return () => listeners[event].delete(f); },
    setTimeout: (f, ms) => {
      const t = { at: now + ms, f };
      timers.push(t);
      return () => { timers = timers.filter((x) => x !== t); };
    },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    io,
    state,
    async advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      due.forEach((t) => t.f());
      await flush();
    },
    async blur() { state.focused = false; listeners.blur.forEach((f) => f()); await flush(); },
    async focus() { state.focused = true; listeners.focus.forEach((f) => f()); await flush(); },
    async copyElsewhere(text: string) { state.clipboard = text; listeners.copy.forEach((f) => f()); await flush(); },
    async click() { state.inGesture = true; listeners.gesture.forEach((f) => f()); await flush(); state.inGesture = false; },
  };
}

describe("effacement du presse-papiers dans une page", () => {
  it("efface ce qu'on a copié, au bout du délai", async () => {
    const p = fakePage();
    p.state.clipboard = "s3cret";
    scheduleInPage("s3cret", 30_000, p.io);
    await p.advance(29_000);
    expect(p.state.clipboard).toBe("s3cret");
    await p.advance(1_000);
    expect(p.state.clipboard).toBe("");
  });

  it("ne touche pas à ce qui a été copié depuis", async () => {
    const p = fakePage();
    p.state.clipboard = "s3cret";
    scheduleInPage("s3cret", 30_000, p.io);
    p.state.clipboard = "autre chose";
    await p.advance(30_000);
    expect(p.state.clipboard).toBe("autre chose");
  });

  it("sans focus à l'échéance, attend son retour pour vérifier et effacer", async () => {
    const p = fakePage();
    p.state.clipboard = "s3cret";
    scheduleInPage("s3cret", 30_000, p.io);
    await p.blur();
    await p.advance(30_000);
    expect(p.state.clipboard).toBe("s3cret");
    await p.focus();
    expect(p.state.clipboard).toBe("");
  });

  it("sans droit de lecture : efface seulement si la page n'a pas été quittée", async () => {
    const stayed = fakePage({ canRead: false });
    stayed.state.clipboard = "s3cret";
    scheduleInPage("s3cret", 30_000, stayed.io);
    await stayed.advance(30_000);
    expect(stayed.state.clipboard).toBe("");

    // Quittée (on est allé coller ailleurs, et peut-être copier autre chose) :
    // impossible de savoir, on laisse.
    const left = fakePage({ canRead: false });
    left.state.clipboard = "s3cret";
    scheduleInPage("s3cret", 30_000, left.io);
    await left.blur();
    await left.focus();
    await left.advance(30_000);
    expect(left.state.clipboard).toBe("s3cret");

    // Un Ctrl+C dans la page même, hors de nos boutons : pareil.
    const copied = fakePage({ canRead: false });
    scheduleInPage("s3cret", 30_000, copied.io);
    await copied.copyElsewhere("texte sélectionné");
    await copied.advance(30_000);
    expect(copied.state.clipboard).toBe("texte sélectionné");
  });

  it("écriture refusée hors d'un geste : efface au premier clic qui suit", async () => {
    const p = fakePage({ canRead: false, writeNeedsGesture: true });
    p.state.clipboard = "s3cret";
    scheduleInPage("s3cret", 30_000, p.io);
    await p.click();
    expect(p.state.clipboard).toBe("s3cret");
    await p.advance(30_000);
    expect(p.state.clipboard).toBe("s3cret");
    await p.click();
    expect(p.state.clipboard).toBe("");
  });

  it("une nouvelle copie remplace l'effacement en attente", async () => {
    const p = fakePage();
    p.state.clipboard = "premier";
    scheduleInPage("premier", 30_000, p.io);
    await p.advance(20_000);
    p.state.clipboard = "second";
    scheduleInPage("second", 30_000, p.io);
    await p.advance(10_000);
    expect(p.state.clipboard).toBe("second");
    await p.advance(20_000);
    expect(p.state.clipboard).toBe("");
  });

  it("renonce si la page reste sans focus trop longtemps", async () => {
    const p = fakePage();
    p.state.clipboard = "s3cret";
    scheduleInPage("s3cret", 30_000, p.io);
    await p.blur();
    await p.advance(30_000 + 10 * 60_000);
    await p.focus();
    expect(p.state.clipboard).toBe("s3cret");
  });
});
