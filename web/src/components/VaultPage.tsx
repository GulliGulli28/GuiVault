import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { indexItems, toEntities } from "../lib/entities";
import { navigate } from "../lib/route";
import { loadItems, moveItem, payloadEntity, payloadName, putPayload, RevisionConflict, type DecodedItem, type VaultView } from "../lib/session";
import { canWrite, KIND_LABELS, KIND_LABELS_PLURAL, ROLE_HINTS, ROLE_LABELS, type GuiVaultEntity, type ItemKind, type Payload } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { ItemTree, KIND_ICONS } from "./ItemTree";
import { ItemView } from "./ItemView";
import { HostForm } from "./forms/HostForm";
import { GroupForm } from "./forms/GroupForm";
import { SnippetForm } from "./forms/SnippetForm";
import { KeyForm } from "./forms/KeyForm";
import { SqlConnectionForm } from "./forms/SqlConnectionForm";
import { IconForm } from "./forms/IconForm";
import { LoginForm } from "./forms/LoginForm";
import { NoteForm } from "./forms/NoteForm";
import { CardForm } from "./forms/CardForm";
import { IdentityForm } from "./forms/IdentityForm";
import { IconStar, IconTools } from "./secret-icons";
import { IconChevronDown, IconCopy, IconEdit, IconPlus, IconRefresh, IconSearch, IconSettings, IconTrash } from "./ui-icons";
import { copyText, formatWhen, Loading, useDelayed } from "./ui";

type Mode = { kind: "view" } | { kind: "edit" } | { kind: "new"; itemKind: ItemKind };

/** Les entrées du menu « Nouveau » : les secrets d'abord, puis les entités
 * Guiterm, un trait entre les deux. */
const NEW_KINDS: (ItemKind | "sep")[] = ["login", "note", "card", "identity", "sep", "host", "group", "sql-connection", "key", "snippet", "icon"];

type Filter = "all" | "favorites" | ItemKind;
/** Les filtres proposés, dans l'ordre ; ceux sans élément sont masqués. */
const FILTERS: Filter[] = ["all", "favorites", "login", "note", "card", "identity", "host", "sql-connection", "key", "snippet", "group", "icon"];

/** Un vault : son contenu à gauche, la fiche ou le formulaire à droite. */
export function VaultPage({ ctx, vaultId }: { ctx: PageContext; vaultId: string }) {
  const vault = ctx.session.vaults.find((v) => v.id === vaultId);
  if (!vault) return <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Ce vault n'existe pas (ou plus).</p>;
  return <VaultBody key={vault.id} ctx={ctx} vault={vault} />;
}

function VaultBody({ ctx, vault }: { ctx: PageContext; vault: VaultView }) {
  const [items, setItems] = useState<DecodedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveTo, setMoveTo] = useState<VaultView | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [stale, setStale] = useState(false);
  const slow = useDelayed(loading);
  const writable = canWrite(vault.role);
  const editingRef = useRef(false);
  editingRef.current = mode.kind !== "view";
  // `vault` et `ctx` changent d'identité à chaque `/sync` ou notification :
  // `load` les lit par référence pour ne pas recharger les items à chaque
  // fois — seulement au montage et quand le serveur le dit (`tick`).
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await loadItems(vaultRef.current);
      setItems(page.items);
    } catch (e) {
      ctxRef.current.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Le serveur dit que le vault a changé : on recharge, sauf au milieu d'une
  // saisie — on le signale alors, et le verrou de révision fera le reste.
  const tick = ctx.vaultTicks[vault.id] ?? 0;
  useEffect(() => {
    if (tick === 0) return;
    if (editingRef.current) setStale(true);
    else void load();
  }, [tick, load]);

  const index = useMemo(() => indexItems(items ?? []), [items]);
  const entities = useMemo(() => toEntities(items ?? []), [items]);
  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: entities.length, favorites: entities.filter((e) => e.favorite).length };
    for (const e of entities) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [entities]);
  // Filtrer par type garde les dossiers : ils portent l'arborescence, et
  // `buildVaultTree` retire ceux qui finissent vides.
  const filtered = useMemo(() => {
    if (filter === "all") return entities;
    if (filter === "favorites") return entities.filter((e) => e.favorite || e.kind === "group");
    if (filter === "group") return entities.filter((e) => e.kind === "group");
    return entities.filter((e) => e.kind === filter || e.kind === "group");
  }, [entities, filter]);
  const current = selected ? items?.find((i) => i.id === selected) ?? null : null;

  const save = async (payload: Payload, baseRevision?: number) => {
    try {
      await putPayload(vault, payload, baseRevision);
    } catch (e) {
      if (e instanceof RevisionConflict) {
        await load();
        throw e;
      }
      throw e;
    }
    ctx.notify(`« ${payloadName(payload)} » enregistré.`);
    setMode({ kind: "view" });
    setStale(false);
    await load();
    setSelected(payloadIdOf(payload));
  };

  const remove = async () => {
    if (!current) return;
    setConfirmDelete(false);
    try {
      await api.deleteItem(vault.id, current.id);
      ctx.notify("Élément supprimé.");
      setSelected(null);
      await load();
    } catch (e) {
      ctx.error(errorMessage(e));
    }
  };

  const doMove = async () => {
    if (!current || !current.ok || !moveTo) return;
    const dest = moveTo;
    setMoveTo(null);
    try {
      await moveItem(vault, dest, current);
      ctx.notify(`« ${payloadName(current.payload)} » déplacé vers « ${dest.name} ».`);
      setSelected(null);
      await load();
    } catch (e) {
      ctx.error(errorMessage(e));
    }
  };

  const toggleFavorite = async () => {
    if (!current?.ok) return;
    const p = current.payload;
    const flip = <T extends { favorite?: boolean }>(e: T): T => ({ ...e, favorite: e.favorite ? undefined : true });
    let next: Payload;
    switch (p.kind) {
      case "login": next = { ...p, login: flip(p.login) }; break;
      case "note": next = { ...p, note: flip(p.note) }; break;
      case "card": next = { ...p, card: flip(p.card) }; break;
      case "identity": next = { ...p, identity: flip(p.identity) }; break;
      default: return;
    }
    try {
      await putPayload(vault, next, current.revision);
      await load();
    } catch (e) {
      ctx.error(errorMessage(e));
      if (e instanceof RevisionConflict) await load();
    }
  };

  /** Copier l'utilisateur ou le mot de passe depuis la liste, sans ouvrir. */
  const rowActions = (entity: GuiVaultEntity) => {
    const it = index.byId.get(entity.id);
    if (!it || it.payload.kind !== "login") return null;
    const l = it.payload.login;
    const copy = (label: string, value: string) => () => copyText(value).then((ok) => ok && ctx.notify(`${label} copié.`));
    return (
      <>
        {l.username && <button onClick={copy("Utilisateur", l.username)} className="btn btn-ghost btn-sm" title="Copier l'utilisateur">U</button>}
        {l.password && <button onClick={copy("Mot de passe", l.password)} className="btn btn-ghost btn-sm btn-icon" title="Copier le mot de passe" aria-label="Copier le mot de passe"><IconCopy size={11} /></button>}
      </>
    );
  };

  const otherWritable = ctx.session.vaults.filter((v) => v.id !== vault.id && canWrite(v.role));
  const selectedGroupId = current?.ok && current.payload.kind === "group" ? current.id : current?.ok && "groupId" in payloadEntity(current.payload) ? (payloadEntity(current.payload).groupId as string | null) : null;
  const isSecretItem = current?.ok && ["login", "note", "card", "identity"].includes(current.payload.kind);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 pl-4 max-md:pl-28">
        <h1 className="min-w-0 truncate text-[14px] font-semibold text-[var(--c-text)]">{vault.name}</h1>
        <span className="tag" title={ROLE_HINTS[vault.role]}>{vault.kind === "personal" ? "personnel" : ROLE_LABELS[vault.role]}</span>
        <span className="hidden text-[11px] text-[var(--c-text-faint)] sm:inline" title={`Révision ${vault.revision}`}>{items ? `${items.length} élément(s)` : ""}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={() => void load()} className="btn btn-ghost btn-sm btn-icon" title="Recharger" aria-label="Recharger"><IconRefresh size={13} /></button>
          {writable && (
            <div className="relative">
              <button onClick={() => setNewMenu((m) => !m)} className="btn btn-primary btn-sm"><IconPlus size={12} /> Nouveau <IconChevronDown size={10} /></button>
              {newMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setNewMenu(false)} />
                  <div className="popover absolute right-0 z-20 mt-1 w-44 py-1">
                    {NEW_KINDS.map((k, i) => {
                      if (k === "sep") return <div key={i} className="menu-sep" />;
                      const Icon = KIND_ICONS[k];
                      return (
                        <button key={k} onClick={() => { setNewMenu(false); setMode({ kind: "new", itemKind: k }); }} className="menu-item">
                          <Icon size={13} /> {capitalize(KIND_LABELS[k])}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
          <button onClick={() => navigate({ page: "vault-tools", id: vault.id })} className="btn btn-secondary btn-sm btn-icon" title="Importer / exporter" aria-label="Importer / exporter"><IconTools size={13} /></button>
          <button onClick={() => navigate({ page: "vault-settings", id: vault.id })} className="btn btn-secondary btn-sm btn-icon" title="Réglages du vault : membres, invitations, clé" aria-label="Réglages du vault"><IconSettings size={13} /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section className={`flex min-h-0 flex-col border-[var(--c-border)] md:w-80 md:shrink-0 md:border-r lg:w-96 ${mode.kind !== "view" || current ? "max-md:hidden" : ""}`}>
          <div className="shrink-0 space-y-1.5 p-2">
            <div className="relative">
              <IconSearch size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)]" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrer…" aria-label="Filtrer" className="input pl-7" />
            </div>
            {entities.length > 0 && (
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Type d'élément">
                {FILTERS.filter((f) => f === "all" || (counts[f] ?? 0) > 0).map((f) => (
                  <button
                    key={f}
                    role="tab"
                    aria-selected={filter === f}
                    onClick={() => setFilter(f)}
                    className={`btn btn-sm shrink-0 ${filter === f ? "btn-toggled" : "btn-ghost"}`}
                  >
                    {f === "all" ? "Tout" : f === "favorites" ? <><IconStar size={11} filled /> Favoris</> : KIND_LABELS_PLURAL[f]}
                    <span className="text-[10px] text-[var(--c-text-faint)]">{counts[f]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="sidebar-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {items === null ? (slow ? <Loading /> : null) : (
              <ItemTree entities={filtered} query={query} selected={selected} onSelect={(id) => { setSelected(id); setMode({ kind: "view" }); }} rowActions={rowActions} emptyMessage={writable ? "Rien ici pour l'instant — « Nouveau » pour commencer, importez un export, ou synchronisez depuis Guiterm." : "Rien ici pour l'instant."} />
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-1 flex-col">
          {stale && mode.kind !== "view" && (
            <p className="callout callout-warn m-3 mb-0">Ce vault a été modifié entre-temps. Si cet élément l'a été aussi, l'enregistrement sera refusé : rechargez alors avant de réessayer.</p>
          )}
          {mode.kind === "new" && (
            <ItemForm kind={mode.itemKind} index={index} defaultGroupId={selectedGroupId} onSave={(p) => save(p)} onCancel={() => setMode({ kind: "view" })} />
          )}
          {mode.kind === "edit" && current?.ok && (
            <ItemForm kind={current.payload.kind} initial={current.payload} index={index} onSave={(p) => save(p, current.revision)} onCancel={() => setMode({ kind: "view" })} />
          )}
          {mode.kind === "view" && !current && (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-[12.5px] text-[var(--c-text-muted)]">
              {items && items.length > 0 ? "Choisissez un élément dans la liste." : ""}
            </div>
          )}
          {mode.kind === "view" && current && (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5">
                <button onClick={() => setSelected(null)} className="btn btn-ghost btn-sm md:hidden">← Liste</button>
                {current.ok && (() => { const Icon = KIND_ICONS[current.payload.kind]; return <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)]"><Icon size={13} /></span>; })()}
                <h2 className="min-w-0 truncate text-[13px] font-semibold text-[var(--c-text)]">{current.ok ? payloadName(current.payload) : "Élément illisible"}</h2>
                <span className="text-[11px] text-[var(--c-text-faint)]" title={`Révision ${current.revision}`}>{current.ok ? KIND_LABELS[current.payload.kind] : current.itemType} · {formatWhen(current.updatedAt)}</span>
                {writable && (
                  <div className="ml-auto flex items-center gap-1">
                    {isSecretItem && current.ok && (() => {
                      const fav = !!(payloadEntity(current.payload).favorite);
                      return <button onClick={() => void toggleFavorite()} aria-pressed={fav} className={`btn btn-sm btn-icon ${fav ? "btn-toggled" : "btn-ghost"}`} title={fav ? "Retirer des favoris" : "Ajouter aux favoris"} aria-label={fav ? "Retirer des favoris" : "Ajouter aux favoris"}><IconStar size={12} filled={fav} /></button>;
                    })()}
                    {current.ok && <button onClick={() => setMode({ kind: "edit" })} className="btn btn-secondary btn-sm"><IconEdit size={12} /> Modifier</button>}
                    {current.ok && otherWritable.length > 0 && (
                      <select value="" onChange={(e) => { const v = otherWritable.find((x) => x.id === e.target.value); if (v) setMoveTo(v); }} className="input h-6 w-auto text-[11.5px]" title="Déplacer vers un autre vault">
                        <option value="">Déplacer vers…</option>
                        {otherWritable.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                    )}
                    <button onClick={() => setConfirmDelete(true)} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Supprimer" aria-label="Supprimer"><IconTrash size={12} /></button>
                  </div>
                )}
              </div>
              <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-4">
                <div className="max-w-2xl">
                  {current.ok ? (
                    <ItemView payload={current.payload} index={index} />
                  ) : (
                    <p className="callout callout-danger">Impossible de déchiffrer cet élément : {current.error}. Il a peut-être été chiffré avec une clé de vault antérieure, ou altéré.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {confirmDelete && current && (
        <ConfirmDialog
          title={`Supprimer « ${current.ok ? payloadName(current.payload) : current.id.slice(0, 8)} » ?`}
          message={current.ok && current.payload.kind === "group" ? "Le dossier est supprimé ; ce qu'il contient remonte à la racine lors de la prochaine synchronisation de chaque appareil." : "Une pierre tombale est laissée pour que chaque appareil synchronisé le retire à son tour."}
          confirmLabel="Supprimer"
          danger
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {moveTo && current?.ok && (
        <ConfirmDialog
          title={`Déplacer vers « ${moveTo.name} » ?`}
          message={`« ${payloadName(current.payload)} » est re-chiffré sous la clé de ${moveTo.name} et retiré d'ici. ${moveTo.kind === "shared" ? "Tous les membres de ce vault pourront le lire, secrets compris." : ""} Ce qu'il référence (dossier, clé du trousseau, relais) ne suit pas : déplacez-les aussi si besoin.`}
          confirmLabel="Déplacer"
          onConfirm={doMove}
          onCancel={() => setMoveTo(null)}
        >
          {current.payload.kind === "group" && <p className="callout callout-warn">Seul le dossier lui-même est déplacé, pas son contenu.</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

function ItemForm({ kind, initial, index, defaultGroupId, onSave, onCancel }: {
  kind: ItemKind;
  initial?: Payload;
  index: ReturnType<typeof indexItems>;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  switch (kind) {
    case "host":
      return <HostForm initial={initial?.kind === "host" ? initial : undefined} index={index} defaultGroupId={defaultGroupId} onSave={onSave} onCancel={onCancel} />;
    case "group":
      return <GroupForm initial={initial?.kind === "group" ? initial.group : undefined} index={index} defaultParentId={defaultGroupId} onSave={onSave} onCancel={onCancel} />;
    case "snippet":
      return <SnippetForm initial={initial?.kind === "snippet" ? initial.snippet : undefined} onSave={onSave} onCancel={onCancel} />;
    case "key":
      return <KeyForm initial={initial?.kind === "key" ? initial : undefined} onSave={onSave} onCancel={onCancel} />;
    case "sql-connection":
      return <SqlConnectionForm initial={initial?.kind === "sql-connection" ? initial : undefined} index={index} defaultGroupId={defaultGroupId} onSave={onSave} onCancel={onCancel} />;
    case "icon":
      return <IconForm initial={initial?.kind === "icon" ? initial.icon : undefined} onSave={onSave} onCancel={onCancel} />;
    case "login":
      return <LoginForm initial={initial?.kind === "login" ? initial.login : undefined} index={index} defaultGroupId={defaultGroupId} onSave={onSave} onCancel={onCancel} />;
    case "note":
      return <NoteForm initial={initial?.kind === "note" ? initial.note : undefined} index={index} defaultGroupId={defaultGroupId} onSave={onSave} onCancel={onCancel} />;
    case "card":
      return <CardForm initial={initial?.kind === "card" ? initial.card : undefined} index={index} defaultGroupId={defaultGroupId} onSave={onSave} onCancel={onCancel} />;
    case "identity":
      return <IdentityForm initial={initial?.kind === "identity" ? initial.identity : undefined} index={index} defaultGroupId={defaultGroupId} onSave={onSave} onCancel={onCancel} />;
  }
}

function payloadIdOf(p: Payload): string {
  return payloadEntity(p).id;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
