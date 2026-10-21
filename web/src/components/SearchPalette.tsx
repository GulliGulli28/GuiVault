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
import { errorMessage, supports } from "../lib/api";
import { autoTypeBridge } from "../lib/platform";
import { copyText } from "../lib/clipboard";
import { indexItems, matchesQuery, toEntities } from "../lib/entities";
import { primarySecret, primaryUser, withArticle } from "../lib/items";
import { vaultColor } from "../lib/vaultColors";
import { navigate, type Route } from "../lib/route";
import { loadItems, type DecodedItem, type VaultView } from "../lib/session";
import { KIND_LABELS, KIND_LABELS_PLURAL, type CustomIcon, type GuiVaultEntity, type Payload } from "../lib/types";
import { useModalSurface } from "../hooks/useModalSurface";
import { ItemTile } from "./ItemTree";
import { IconChevronRight } from "./ui-icons";

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
  const all: Entry[] = [
    { kind: "page", key: "generator", label: "Générateur de mots de passe", keywords: "générer phrase de passe clé ssh", route: { page: "generator" } },
    { kind: "page", key: "totp", label: "Codes 2FA", keywords: "authentificateur totp otp code", route: { page: "totp" } },
    { kind: "page", key: "invitations", label: "Invitations reçues", keywords: "partage", route: { page: "invitations" } },
    { kind: "page", key: "settings-apparence", label: "Paramètres — Apparence", keywords: "thème couleur police", route: { page: "settings", section: "apparence" } },
    { kind: "page", key: "settings-compte", label: "Paramètres — Compte", keywords: "empreinte e-mail", route: { page: "settings", section: "compte" } },
    { kind: "page", key: "settings-securite", label: "Paramètres — Sécurité", keywords: "mot de passe maître totp verrouiller presse-papiers", route: { page: "settings", section: "securite" } },
    { kind: "page", key: "settings-saisie", label: "Paramètres — Saisie automatique", keywords: "autotype keepass raccourci séquence", route: { page: "settings", section: "saisie" } },
    { kind: "page", key: "settings-sessions", label: "Paramètres — Appareils connectés", keywords: "sessions journal", route: { page: "settings", section: "sessions" } },
  ];
  // Ce que ce transport (un coffre local) ou cette plateforme (le web) n'a pas.
  const out = all.filter((p) => (p.key !== "invitations" || supports("myInvitations")) && (p.key !== "settings-sessions" || supports("sessions")) && (p.key !== "settings-saisie" || !!autoTypeBridge()));
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
      // Groupés par genre ; dans un genre, le nom qui contient la recherche
      // d'abord, puis par nom.
      .sort((a, b) => {
        if (a.kind !== "item" || b.kind !== "item") return 0;
        const ak = kindRank(a.entity.kind), bk = kindRank(b.entity.kind);
        const an = a.entity.name.toLowerCase().includes(q) ? 0 : 1;
        const bn = b.entity.name.toLowerCase().includes(q) ? 0 : 1;
        return ak - bk || an - bn || a.entity.name.localeCompare(b.entity.name);
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
  const groupOf = (e: Entry) => (e.kind === "item" ? capitalize(KIND_LABELS_PLURAL[e.entity.kind]) : "Aller à");
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(5,6,8,0.55)] px-4 pt-[12vh]" onClick={onClose}>
      <div ref={ref} {...dialogProps} className="modal w-full max-w-[660px] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-[var(--c-border)] px-[18px]">
          <span className="font-mono text-[18px] leading-none text-[var(--c-accent)]" aria-hidden="true">›</span>
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
            placeholder="Rechercher dans tous les vaults, ou aller à une page"
            aria-label="Rechercher"
            className="min-w-0 flex-1 bg-transparent py-4 text-[16px] text-[var(--c-text)] outline-none placeholder:text-[var(--c-text-muted)] focus-visible:outline-none"
          />
          {loading ? <span className="shrink-0 text-[12px] text-[var(--c-text-muted)]">Lecture…</span> : <span className="tag max-sm:hidden">Tous les vaults</span>}
          <span className="kbd [@media(pointer:coarse)]:hidden">Échap</span>
        </div>
        <div className="sidebar-scroll max-h-[55vh] overflow-y-auto p-1.5" role="listbox" aria-label="Résultats">
          {results.length === 0 && <p className="px-4 py-8 text-center text-[13px] text-[var(--c-text-muted)]">{loading ? "Lecture des vaults…" : "Aucun résultat"}</p>}
          {results.map((e, i) => (
            <div key={e.key}>
              {(i === 0 || groupOf(results[i - 1]) !== groupOf(e)) && <p className="px-3 pb-1 pt-2.5 text-[12px] font-medium text-[var(--c-text-muted)]">{groupOf(e)}</p>}
              <button
                ref={(el) => { rowRefs.current[i] = el; }}
                role="option"
                aria-selected={i === active}
                onClick={() => run(e)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full min-w-0 items-center gap-3 rounded-[9px] px-3 py-2 text-left transition-colors ${i === active ? "bg-[var(--c-sel)]" : ""}`}
              >
                {e.kind === "item" ? (
                  <ItemRow entity={e.entity} icons={e.icons} vault={e.vault} query={query.trim()} active={i === active} />
                ) : (
                  <>
                    <span className="tile tile-neutral" style={{ "--tile-size": "28px" } as React.CSSProperties}><IconChevronRight size={14} /></span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--c-text)]"><Highlight text={e.label} query={query.trim()} /></span>
                    {i === active && <span className="kbd [@media(pointer:coarse)]:hidden">Entrée</span>}
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
        {/* Des raccourcis clavier : rien à dire à un doigt. */}
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--c-border)] px-[18px] py-2.5 text-[12px] text-[var(--c-text-muted)] [@media(pointer:coarse)]:hidden">
          <Hint keys={["↑", "↓"]}>parcourir</Hint>
          <Hint keys={["Entrée"]}>ouvrir</Hint>
          {current?.kind === "item" && primarySecret(current.payload) && <Hint keys={["Ctrl", "C"]}>copier {withArticle(primarySecret(current.payload)!.label)}</Hint>}
          {current?.kind === "item" && primaryUser(current.payload) && <Hint keys={["Ctrl", "Maj", "C"]}>copier {withArticle(primaryUser(current.payload)!.label)}</Hint>}
        </footer>
      </div>
    </div>
  );
}

/** L'ordre des groupes : les identifiants et les hôtes d'abord. */
const KIND_ORDER: GuiVaultEntity["kind"][] = ["login", "host", "card", "note", "identity", "api-key", "aws", "sql-connection", "key", "snippet", "runbook"];
function kindRank(k: GuiVaultEntity["kind"]): number {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? KIND_ORDER.length : i;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Le texte, la partie qui correspond à la recherche mise en avant. */
function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark className="bg-transparent font-semibold text-[var(--c-accent-text)]">{text.slice(i, i + query.length)}</mark>{text.slice(i + query.length)}</>;
}

function ItemRow({ entity, icons, vault, query, active }: { entity: GuiVaultEntity; icons: CustomIcon[]; vault: VaultView; query: string; active: boolean }) {
  return (
    <>
      <ItemTile entity={entity} customIcons={icons} size={28} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className={`truncate text-[13.5px] text-[var(--c-text)] ${entity.kind === "host" ? "font-mono" : ""}`}><Highlight text={entity.name} query={query} /></span>
        <span className={`truncate text-[12px] text-[var(--c-text-muted)] ${entity.mono ? "font-mono" : ""}`}>
          {[entity.path, entity.subtitle].filter(Boolean).join(" · ") || KIND_LABELS[entity.kind]}
        </span>
      </span>
      <span className="flex max-w-[160px] min-w-0 shrink-0 items-center gap-1.5 text-[12px] text-[var(--c-text-muted)] max-sm:hidden">
        <span className="vdot" style={{ background: vaultColor(vault.id, vault.kind === "personal") }} />
        <span className="truncate">{vault.name}</span>
      </span>
      {active && <span className="kbd [@media(pointer:coarse)]:hidden">Entrée</span>}
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
