/** La recherche globale (Ctrl+K) : tous les éléments de tous les vaults, et
 * les pages de l'app, dans une palette à la manière de `CommandPalette` de
 * Guiterm. Entrée ouvre l'élément dans son vault ; Ctrl+C copie son secret
 * (le mot de passe d'un identifiant), Ctrl+Maj+C son utilisateur.
 *
 * Les vaults sont relus à chaque ouverture ; ce qu'on en a déjà déchiffré
 * s'affiche tout de suite, en mémoire seulement, effacé avec la session
 * (`clearSearchCache`). */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageContext } from "../App";
import { errorMessage } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { indexItems, matchesQuery, toEntities } from "../lib/entities";
import { primarySecret, primaryUser } from "../lib/items";
import { navigate, type Route } from "../lib/route";
import { loadItems, type DecodedItem, type VaultView } from "../lib/session";
import { KIND_LABELS, type CustomIcon, type GuiVaultEntity, type Payload } from "../lib/types";
import { useModalSurface } from "../hooks/useModalSurface";
import { EntityIcon } from "./ItemTree";
import { IconSearch } from "./ui-icons";

const cache = new Map<string, DecodedItem[]>();

/** À la fermeture de la session : rien de déchiffré ne reste en mémoire. */
export function clearSearchCache() {
  cache.clear();
}

type Entry =
  | { kind: "item"; key: string; vault: VaultView; entity: GuiVaultEntity; payload: Payload; icons: CustomIcon[] }
  | { kind: "page"; key: string; label: string; keywords: string; route: Route };

const MAX_ITEMS = 50;

function pages(vaults: VaultView[]): Entry[] {
  const out: Entry[] = [
    { kind: "page", key: "generator", label: "Générateur de mots de passe", keywords: "générer phrase de passe clé ssh", route: { page: "generator" } },
    { kind: "page", key: "totp", label: "Authentificateur (codes TOTP)", keywords: "2fa otp code", route: { page: "totp" } },
    { kind: "page", key: "invitations", label: "Invitations reçues", keywords: "partage", route: { page: "invitations" } },
    { kind: "page", key: "settings-apparence", label: "Paramètres — Apparence", keywords: "thème couleur police", route: { page: "settings", section: "apparence" } },
    { kind: "page", key: "settings-compte", label: "Paramètres — Compte", keywords: "empreinte e-mail", route: { page: "settings", section: "compte" } },
    { kind: "page", key: "settings-securite", label: "Paramètres — Sécurité", keywords: "mot de passe maître totp verrouiller presse-papiers", route: { page: "settings", section: "securite" } },
    { kind: "page", key: "settings-sessions", label: "Paramètres — Appareils connectés", keywords: "sessions journal", route: { page: "settings", section: "sessions" } },
  ];
  for (const v of vaults) {
    out.push(
      { kind: "page", key: `vault-${v.id}`, label: `Ouvrir « ${v.name} »`, keywords: "vault", route: { page: "vault", id: v.id } },
      { kind: "page", key: `trash-${v.id}`, label: `Corbeille de « ${v.name} »`, keywords: "supprimés restaurer", route: { page: "vault-trash", id: v.id } },
      { kind: "page", key: `settings-${v.id}`, label: `Réglages de « ${v.name} »`, keywords: "membres invitations clé rotation", route: { page: "vault-settings", id: v.id } },
      { kind: "page", key: `tools-${v.id}`, label: `Importer / exporter « ${v.name} »`, keywords: "import export bitwarden csv", route: { page: "vault-tools", id: v.id } },
    );
  }
  return out;
}

export function SearchPalette({ ctx, onClose }: { ctx: PageContext; onClose: () => void }) {
  const { ref, dialogProps } = useModalSurface({ onClose, label: "Recherche globale" });
  const vaults = ctx.session.vaults;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    Promise.all(
      vaults.map((v) =>
        loadItems(v)
          .then((page) => { cache.set(v.id, page.items); })
          .catch((e) => ctx.error(`${v.name} : ${errorMessage(e)}`)),
      ),
    ).finally(() => {
      if (!alive) return;
      setLoading(false);
      setTick((t) => t + 1);
    });
    return () => { alive = false; };
    // Relu à l'ouverture seulement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const v of vaults) {
      const decoded = cache.get(v.id) ?? [];
      const icons = indexItems(decoded).icons;
      const payloads = new Map(decoded.filter((d) => d.ok).map((d) => [d.id, (d as DecodedItem & { ok: true }).payload]));
      for (const entity of toEntities(decoded)) {
        const payload = payloads.get(entity.id);
        if (!payload || entity.kind === "group" || entity.kind === "icon") continue;
        out.push({ kind: "item", key: `${v.id}/${entity.id}`, vault: v, entity, payload, icons });
      }
    }
    return out;
    // `tick` : le cache a été rempli.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaults, tick]);

  const results = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const pageEntries = pages(vaults).filter((p) => p.kind === "page" && `${p.label} ${p.keywords}`.toLowerCase().includes(q));
    if (!q) return pageEntries;
    const found = items
      .filter((e) => e.kind === "item" && matchesQuery(e.entity, q, e.vault.name))
      // Le nom qui contient la recherche d'abord, puis par nom.
      .sort((a, b) => {
        if (a.kind !== "item" || b.kind !== "item") return 0;
        const an = a.entity.name.toLowerCase().includes(q) ? 0 : 1;
        const bn = b.entity.name.toLowerCase().includes(q) ? 0 : 1;
        return an - bn || a.entity.name.localeCompare(b.entity.name);
      })
      .slice(0, MAX_ITEMS);
    return [...found, ...pageEntries];
  }, [items, vaults, query]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { rowRefs.current[active]?.scrollIntoView({ block: "nearest" }); }, [active]);

  const run = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    navigate(e.kind === "item" ? { page: "vault", id: e.vault.id, item: e.entity.id } : e.route);
  };
  const copy = (e: Entry | undefined, which: "secret" | "user") => {
    if (e?.kind !== "item") return;
    const what = which === "secret" ? primarySecret(e.payload) : primaryUser(e.payload);
    if (!what) {
      ctx.error(`Rien à copier (${which === "secret" ? "secret" : "utilisateur"}) pour « ${e.entity.name} ».`);
      return;
    }
    void copyText(what.value).then((ok) => {
      if (ok) ctx.notify(`${what.label} de « ${e.entity.name} » copié.`);
    });
    onClose();
  };

  const current = results[active];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh]" onClick={onClose}>
      <div ref={ref} {...dialogProps} className="modal w-full max-w-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-[var(--c-border)] px-4">
          <IconSearch size={14} className="shrink-0 text-[var(--c-text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); run(current); }
              else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && current?.kind === "item" && !window.getSelection()?.toString()) {
                e.preventDefault();
                copy(current, e.shiftKey ? "user" : "secret");
              }
            }}
            placeholder="Rechercher un élément dans tous les vaults, ou une page…"
            aria-label="Rechercher"
            className="min-w-0 flex-1 bg-transparent py-3 text-[13.5px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-muted)]"
          />
          {loading && <span className="shrink-0 text-[11px] text-[var(--c-text-faint)]">lecture des vaults…</span>}
        </div>
        <div className="sidebar-scroll max-h-[55vh] overflow-y-auto py-1" role="listbox" aria-label="Résultats">
          {results.length === 0 && <p className="px-4 py-6 text-center text-[12.5px] text-[var(--c-text-muted)]">{loading ? "Lecture des vaults…" : "Aucun résultat"}</p>}
          {results.map((e, i) => (
            <button
              key={e.key}
              ref={(el) => { rowRefs.current[i] = el; }}
              role="option"
              aria-selected={i === active}
              onClick={() => run(e)}
              onMouseEnter={() => setActive(i)}
              className={`mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-md px-3 py-1.5 text-left transition-colors ${i === active ? "bg-[var(--c-accent-dim)]" : ""}`}
            >
              {e.kind === "item" ? <ItemRow entity={e.entity} icons={e.icons} vault={e.vault.name} /> : <span className="truncate text-[12.5px] text-[var(--c-text-secondary)]">{e.label}</span>}
            </button>
          ))}
        </div>
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--c-border)] px-4 py-2 text-[11px] text-[var(--c-text-muted)]">
          <Hint keys={["↑", "↓"]}>parcourir</Hint>
          <Hint keys={["Entrée"]}>ouvrir</Hint>
          {current?.kind === "item" && primarySecret(current.payload) && <Hint keys={["Ctrl", "C"]}>copier {primarySecret(current.payload)!.label.toLowerCase()}</Hint>}
          {current?.kind === "item" && primaryUser(current.payload) && <Hint keys={["Ctrl", "Maj", "C"]}>copier {primaryUser(current.payload)!.label.toLowerCase()}</Hint>}
          <Hint keys={["Échap"]}>fermer</Hint>
        </footer>
      </div>
    </div>
  );
}

function ItemRow({ entity, icons, vault }: { entity: GuiVaultEntity; icons: CustomIcon[]; vault: string }) {
  return (
    <>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)] [&>.host-icon]:h-[72%] [&>.host-icon]:w-[72%] [&>.host-icon>*]:h-full [&>.host-icon>*]:w-full">
        <EntityIcon entity={entity} customIcons={icons} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[12.5px] text-[var(--c-text)]">{entity.name}</span>
        <span className={`truncate text-[11px] text-[var(--c-text-muted)] ${entity.mono ? "font-mono" : ""}`}>
          {[KIND_LABELS[entity.kind], entity.path, entity.subtitle].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="tag shrink-0">{vault}</span>
    </>
  );
}

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => <span key={k} className="kbd">{k}</span>)}
      <span>{children}</span>
    </span>
  );
}
