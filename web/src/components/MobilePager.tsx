import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { navigate, type Route } from "../lib/route";

/** Mobile : les pages et leurs transitions, comme une application native.
 *
 * - Entre onglets, la page suit le doigt et l'onglet voisin glisse avec elle
 *   (un « pager ») ; relâchée assez loin ou assez vite, elle part, sinon elle
 *   revient. Au bout de la rangée, elle résiste (élastique).
 * - Toucher un onglet : glissé court et fondu, du côté de l'onglet.
 * - Une page plus profonde (réglages, outils) arrive par la droite par-dessus
 *   la précédente, qui recule un peu (comme iOS) ; le retour fait l'inverse.
 *
 * La page qui s'en va reste montée le temps de l'animation (même instance
 * React : ni rechargement ni défilement perdu), celle qu'on tire aussi —
 * elle devient la page courante sans être remontée. Les pages sont rangées
 * par clé, jamais déplacées dans le DOM (un nœud déplacé perd son
 * défilement), et empilées par `z-index`. */

type Kind = "pager" | "tab" | "push" | "pop" | "fade";

interface Entry {
  key: string;
  route: Route;
}

interface Leaving {
  entry: Entry;
  kind: Kind;
  /** +1 : vers l'onglet suivant (la page part à gauche), -1 : précédent. */
  dir: number;
  /** Pager : où le doigt a laissé la page, et sa vitesse (px/ms). */
  dx: number;
  v: number;
}

/** La courbe des transitions : rapide au départ, longue à se poser. */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Celle d'iOS pour empiler une page. */
const EASE_PUSH = "cubic-bezier(0.32, 0.72, 0, 1)";

/** Élastique au bout de la rangée d'onglets (la formule d'iOS). */
function rubber(dx: number, width: number): number {
  return Math.sign(dx) * (1 - 1 / ((Math.abs(dx) * 0.55) / width + 1)) * width;
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Un geste qui peut changer d'onglet : pas depuis un bord (le geste
 * « retour » d'Android), ni depuis un champ, un curseur, une fiche ouverte
 * ou une fenêtre. Les rangées qui défilent de côté sont vues plus tard,
 * quand on sait dans quel sens va le doigt (`scrollsAlong`). */
function swipeable(target: EventTarget | null, x: number): boolean {
  if (x < 24 || x > window.innerWidth - 24) return false;
  for (let el = target as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (el.matches("input, textarea, select, [role=slider], [data-noswipe], .modal")) return false;
  }
  return true;
}

/** Un élément sous le doigt peut-il encore défiler dans ce sens ? Alors c'est
 * lui qui prend le geste (une rangée d'onglets, un tableau) ; arrivé au bout,
 * le geste revient au pager. */
function scrollsAlong(target: EventTarget | null, stop: HTMLElement, dx: number): boolean {
  for (let el = target as HTMLElement | null; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const o = getComputedStyle(el).overflowX;
    if (o !== "auto" && o !== "scroll") continue;
    const max = el.scrollWidth - el.clientWidth;
    if (dx < 0 ? el.scrollLeft < max - 1 : el.scrollLeft > 1) return true;
  }
  return false;
}

export function MobilePager({ route, pageKey, render, tabs, tabKey, depth }: {
  route: Route;
  pageKey: (r: Route) => string;
  render: (r: Route) => ReactNode;
  /** Les onglets, dans l'ordre de la barre du bas. */
  tabs: { key: string; route: Route }[];
  /** L'onglet d'une route, s'il y en a un (`tabOf`). */
  tabKey: (r: Route) => string | null;
  /** 0 pour une page d'onglet, plus pour une page qu'on ouvre depuis elle. */
  depth: (r: Route) => number;
}) {
  const key = pageKey(route);
  const box = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  const running = useRef<Animation[]>([]);
  // Le geste qui vient d'aboutir : la prochaine route est la sienne.
  const committed = useRef<{ key: string; dx: number; v: number } | null>(null);
  const [shown, setShown] = useState<Entry>({ key, route });
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  // L'onglet qu'on tire du bord pendant le geste, et de quel côté.
  const [peek, setPeek] = useState<{ entry: Entry; dir: number } | null>(null);

  const isTab = (r: Route, ts = tabs) => depth(r) === 0 && ts.some((t) => t.key === tabKey(r));
  const tabIndex = (r: Route, ts = tabs) => ts.findIndex((t) => t.key === tabKey(r));

  // Une autre page : on décide ici, pendant le rendu, comment elle arrive —
  // la page d'avant doit rester dans l'arbre dès ce rendu-ci, sinon React la
  // démonterait avant qu'on l'anime.
  if (shown.key !== key) {
    const old = shown;
    // Lu sans être vidé : le rendu peut être rejoué (StrictMode) ; l'effet
    // qui anime le vide.
    const g = committed.current;
    let next: Leaving;
    if (reducedMotion()) {
      next = { entry: old, kind: "fade", dir: 0, dx: 0, v: 0 };
    } else if (g && g.key === key) {
      next = { entry: old, kind: "pager", dir: g.dx < 0 ? 1 : -1, dx: g.dx, v: g.v };
    } else if (isTab(old.route) && isTab(route)) {
      next = { entry: old, kind: "tab", dir: Math.sign(tabIndex(route) - tabIndex(old.route)) || 1, dx: 0, v: 0 };
    } else {
      const d = depth(route) - depth(old.route);
      next = { entry: old, kind: d > 0 ? "push" : d < 0 ? "pop" : "fade", dir: 0, dx: 0, v: 0 };
    }
    setShown({ key, route });
    setLeaving(next);
    setPeek(null);
  } else if (shown.route !== route) {
    // Même page, autre détail (l'élément ouvert d'un vault) : rien à animer.
    setShown({ key, route });
  }

  // Les animations de la page qui arrive et de celle qui part.
  useLayoutEffect(() => {
    committed.current = null;
    if (!leaving) return;
    const inEl = els.current.get(key);
    const outEl = els.current.get(leaving.entry.key);
    const width = box.current?.clientWidth || window.innerWidth;
    running.current.forEach((a) => a.cancel());
    const anims: Animation[] = [];
    const go = (el: HTMLElement | undefined, frames: Keyframe[], duration: number, easing = EASE) => {
      if (!el) return;
      el.style.transform = "";
      el.style.opacity = "";
      anims.push(el.animate(frames, { duration, easing }));
    };
    const { kind, dir } = leaving;
    if (kind === "pager") {
      // Repartir d'où le doigt a laissé les pages, à la vitesse du doigt.
      const from = leaving.dx;
      const rest = width - Math.abs(from);
      const duration = Math.max(200, Math.min(420, (rest / Math.max(Math.abs(leaving.v), 0.8)) * 2.2));
      go(inEl, [{ transform: `translateX(${from + dir * width}px)` }, { transform: "translateX(0)" }], duration);
      go(outEl, [{ transform: `translateX(${from}px)` }, { transform: `translateX(${-dir * width}px)` }], duration);
    } else if (kind === "tab") {
      go(inEl, [{ transform: `translateX(${dir * 0.22 * width}px)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], 340);
      go(outEl, [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${-dir * 0.12 * width}px)`, opacity: 0 }], 200, "ease-out");
    } else if (kind === "push") {
      go(inEl, [{ transform: `translateX(${width}px)`, boxShadow: "0 0 0 rgba(0,0,0,0)" }, { transform: "translateX(0)", boxShadow: "-16px 0 40px rgba(0,0,0,0.28)" }], 420, EASE_PUSH);
      go(outEl, [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${-0.28 * width}px)`, opacity: 0.55 }], 420, EASE_PUSH);
    } else if (kind === "pop") {
      go(inEl, [{ transform: `translateX(${-0.28 * width}px)`, opacity: 0.55 }, { transform: "translateX(0)", opacity: 1 }], 380, EASE_PUSH);
      go(outEl, [{ transform: "translateX(0)", boxShadow: "-16px 0 40px rgba(0,0,0,0.28)" }, { transform: `translateX(${width}px)`, boxShadow: "0 0 0 rgba(0,0,0,0)" }], 380, EASE_PUSH);
    } else {
      go(inEl, [{ transform: "translateY(8px)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], reducedMotion() ? 1 : 240);
    }
    running.current = anims;
    const done = anims[0]?.finished ?? Promise.resolve();
    let alive = true;
    void done.then(() => { if (alive) setLeaving(null); }, () => {});
    return () => { alive = false; };
    // `key` change toujours avec `leaving`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  // Le geste : écouteurs natifs, `touchmove` non passif pour retenir le
  // défilement vertical une fois le geste horizontal reconnu.
  const latest = useRef({ route, key, tabs, peek });
  latest.current = { route, key, tabs, peek };
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    let g: {
      x: number; y: number; target: EventTarget | null;
      axis: "x" | "y" | null; dx: number;
      samples: { x: number; t: number }[];
      /** Le côté vers lequel on tire (0 : pas encore), et l'onglet qui y est. */
      side: number;
      neighbor: { entry: Entry; dir: number } | null;
    } | null = null;
    let frame = 0;
    const width = () => root.clientWidth || window.innerWidth;
    const neighborOf = (dir: number) => {
      const { route: r, tabs: ts } = latest.current;
      if (!isTab(r, ts)) return null;
      const t = ts[tabIndex(r, ts) + dir];
      return t ? { entry: { key: pageKey(t.route), route: t.route }, dir } : null;
    };
    const place = () => {
      frame = 0;
      if (!g) return;
      const w = width();
      const cur = els.current.get(latest.current.key);
      const offset = g.neighbor ? g.dx : rubber(g.dx, w);
      if (cur) cur.style.transform = `translateX(${offset}px)`;
      const n = g.neighbor && els.current.get(g.neighbor.entry.key);
      if (n) n.style.transform = `translateX(${offset + g.neighbor!.dir * w}px)`;
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !isTab(latest.current.route, latest.current.tabs) || !swipeable(e.target, t.clientX)) {
        g = null;
        return;
      }
      running.current.forEach((a) => a.finish());
      g = { x: t.clientX, y: t.clientY, target: e.target, axis: null, dx: 0, samples: [{ x: t.clientX, t: e.timeStamp }], side: 0, neighbor: null };
    };
    const onMove = (e: TouchEvent) => {
      if (!g) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (!g.axis) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.2 || scrollsAlong(g.target, root, dx)) {
          g = null;
          return;
        }
        g.axis = "x";
        // Partir de là où le geste a été reconnu : pas de saut.
        g.x = t.clientX - Math.sign(dx) * 2;
      }
      if (e.cancelable) e.preventDefault();
      g.dx = t.clientX - g.x;
      g.samples.push({ x: t.clientX, t: e.timeStamp });
      if (g.samples.length > 6) g.samples.shift();
      const dir = g.dx < 0 ? 1 : -1;
      if (g.side !== dir) {
        g.side = dir;
        const n = neighborOf(dir);
        // L'onglet voisin d'avant repart hors champ ; le nouveau se monte.
        if (g.neighbor) {
          const old = els.current.get(g.neighbor.entry.key);
          if (old) old.style.transform = "";
        }
        g.neighbor = n;
        setPeek(n);
      }
      if (!frame) frame = requestAnimationFrame(place);
    };
    const onEnd = () => {
      const s = g;
      g = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!s || s.axis !== "x") return;
      const w = width();
      const first = s.samples[0];
      const last = s.samples[s.samples.length - 1];
      const v = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const n = s.neighbor;
      const commit = n && (Math.abs(s.dx) > w * 0.35 || (Math.abs(v) > 0.35 && Math.sign(v) === Math.sign(s.dx)));
      if (commit && n) {
        committed.current = { key: n.entry.key, dx: s.dx, v };
        navigate(n.entry.route);
        return;
      }
      // Retour en place, avec ressort.
      const cur = els.current.get(latest.current.key);
      const offset = n ? s.dx : rubber(s.dx, w);
      const anims: Animation[] = [];
      if (cur) {
        cur.style.transform = "";
        anims.push(cur.animate([{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }], { duration: 380, easing: EASE }));
      }
      const nEl = n && els.current.get(n.entry.key);
      if (nEl && n) {
        nEl.style.transform = `translateX(${n.dir * w}px)`;
        nEl.animate([{ transform: `translateX(${offset + n.dir * w}px)` }, { transform: `translateX(${n.dir * w}px)` }], { duration: 380, easing: EASE });
      }
      running.current = anims;
      const a = anims[0];
      if (a) void a.finished.then(() => { if (!g) setPeek(null); }, () => {});
      else setPeek(null);
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
      if (frame) cancelAnimationFrame(frame);
    };
    // Tout ce qui change passe par `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rangées par clé (ordre stable dans le DOM), empilées par rôle.
  const entries: { entry: Entry; role: "current" | "leaving" | "peek" }[] = [{ entry: shown, role: "current" }];
  if (leaving && leaving.entry.key !== shown.key) entries.push({ entry: leaving.entry, role: "leaving" });
  if (peek && !entries.some((e) => e.entry.key === peek.entry.key)) entries.push({ entry: peek.entry, role: "peek" });
  entries.sort((a, b) => (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0));
  // Ce qui passe dessus : la page qu'on empile, ou celle qu'on dépile.
  const z = (role: string) => {
    if (leaving?.kind === "pop") return role === "leaving" ? 2 : 1;
    return role === "current" ? 2 : 1;
  };

  return (
    <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
      {entries.map(({ entry, role }) => (
        <div
          key={entry.key}
          ref={(el) => { if (el) els.current.set(entry.key, el); else els.current.delete(entry.key); }}
          className="m-pager-page absolute inset-0 flex min-h-0 flex-col bg-[var(--c-bg2)]"
          style={{ zIndex: z(role), transform: role === "peek" && peek ? `translateX(${peek.dir * 100}%)` : undefined }}
          aria-hidden={role !== "current" || undefined}
          inert={role !== "current" || undefined}
        >
          {render(entry.route)}
        </div>
      ))}
    </div>
  );
}
