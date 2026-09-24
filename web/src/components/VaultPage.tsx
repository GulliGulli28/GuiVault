import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { filterEntities, indexItems, toEntities, withParent } from "../lib/entities";
import { uuid } from "../lib/bytes";
import { isSecret } from "../lib/items";
import { pinnedEmailFor } from "../lib/pins";
import { navigate } from "../lib/route";
import { loadItems, moveItem, payloadEntity, payloadName, putPayload, RevisionConflict, type DecodedItem, type VaultView } from "../lib/session";
import { canWrite, KIND_LABELS, KIND_LABELS_PLURAL, ROLE_HINTS, ROLE_LABELS, type CustomIcon, type GuiVaultEntity, type ItemKind, type Payload } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { EntityIcon, ItemTree, KIND_ICONS, type FolderNaming } from "./ItemTree";
import { ItemView } from "./ItemView";
import { ItemForm } from "./forms/ItemForm";
import { IconHistory, IconStar, IconTools } from "./secret-icons";
import { ItemHistory } from "./ItemHistory";
import { IconChevronDown, IconCopy, IconEdit, IconFolder, IconPlus, IconRefresh, IconSearch, IconSettings, IconTrash } from "./ui-icons";
import { copyText, formatWhen, Loading, useDelayed } from "./ui";
import { PaneHandle, usePersistedPane } from "../hooks/usePersistedPane";

/** `groupId` : le dossier où créer (bouton « + » d'un dossier) ; absent, le
 * dossier de l'élément sélectionné. */
type Mode = { kind: "view" } | { kind: "edit" } | { kind: "new"; itemKind: ItemKind; groupId?: string | null };

/** Les entrées du menu « Nouveau » : les secrets d'abord, puis les entités
 * Guiterm, un trait entre les deux. */
const NEW_KINDS: (ItemKind | "sep")[] = ["login", "note", "card", "identity", "api-key", "aws", "sep", "host", "group", "sql-connection", "key", "snippet", "runbook", "icon"];

type Filter = "all" | "favorites" | ItemKind;
/** Les filtres proposés, dans l'ordre ; ceux sans élément sont masqués. */
const FILTERS: Filter[] = ["all", "favorites", "login", "note", "card", "identity", "api-key", "aws", "host", "sql-connection", "key", "snippet", "runbook", "group", "icon"];

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
  const [history, setHistory] = useState(false);
  const [moveTo, setMoveTo] = useState<VaultView | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [stale, setStale] = useState(false);
  const [naming, setNaming] = useState<FolderNaming | null>(null);
  /** Le menu « + » d'un dossier, posé à l'endroit du bouton. */
  const [folderMenu, setFolderMenu] = useState<{ folderId: string; x: number; y: number } | null>(null);
  const slow = useDelayed(loading);
  const writable = canWrite(vault.role);
  // La colonne de la liste se redimensionne, comme les panneaux de Guiterm.
  const list = usePersistedPane("vault-list", { initial: 340, min: 240, max: 720, axis: "horizontal", mode: "px" });
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
  // Filtrer par type garde les dossiers qui mènent à quelque chose, pas les
  // autres.
  const filtered = useMemo(() => {
    if (filter === "all") return entities;
    if (filter === "group") return entities.filter((e) => e.kind === "group");
    if (filter === "favorites") return filterEntities(entities, (e) => !!e.favorite);
    return filterEntities(entities, (e) => e.kind === filter);
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
      case "aws": next = { ...p, aws: flip(p.aws) }; break;
      case "api-key": next = { ...p, apiKey: flip(p.apiKey) }; break;
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
        {l.username && <button onClick={copy("Utilisateur", l.username)} className="btn btn-ghost btn-sm" title="Copier l'utilisateur" aria-label="Copier l'utilisateur">U</button>}
        {l.password && <button onClick={copy("Mot de passe", l.password)} className="btn btn-ghost btn-sm btn-icon" title="Copier le mot de passe" aria-label="Copier le mot de passe"><IconCopy size={11} /></button>}
      </>
    );
  };

  // ─── Dossiers, comme dans le panneau des hôtes de Guiterm ──────────────

  /** Deux dossiers de même nom au même niveau : refusé, comme Guiterm. */
  const nameTaken = (name: string, parentId: string | null, except?: string) =>
    index.groups.some((g) => g.id !== except && (g.parentId ?? null) === parentId && g.name.toLowerCase() === name.toLowerCase());

  const submitFolderName = async (name: string) => {
    const n = naming;
    setNaming(null);
    if (!n) return;
    try {
      if (n.mode === "create") {
        if (nameTaken(name, n.parentId)) return ctx.error(`Un dossier « ${name} » existe déjà à ce niveau.`);
        await putPayload(vault, { kind: "group", group: { id: uuid(), name, parentId: n.parentId, color: null } });
        ctx.notify(`Dossier « ${name} » créé.`);
      } else {
        const it = index.byId.get(n.id);
        if (!it || it.payload.kind !== "group") return;
        const g = it.payload.group;
        if (nameTaken(name, g.parentId ?? null, g.id)) return ctx.error(`Un dossier « ${name} » existe déjà à ce niveau.`);
        await putPayload(vault, { kind: "group", group: { ...g, name } }, it.revision);
        ctx.notify(`Dossier renommé en « ${name} ».`);
      }
    } catch (e) {
      ctx.error(errorMessage(e));
    }
    await load();
  };

  /** Glisser-déposer : l'élément change de dossier, rien d'autre. */
  const moveToFolder = async (id: string, folderId: string | null) => {
    const it = index.byId.get(id);
    if (!it) return;
    const next = withParent(it.payload, folderId);
    if (!next) return;
    if (next.kind === "group" && nameTaken(next.group.name, folderId, id)) return ctx.error(`Un dossier « ${next.group.name} » existe déjà à cet endroit.`);
    try {
      await putPayload(vault, next, it.revision);
      const dest = folderId ? index.groups.find((g) => g.id === folderId)?.name : null;
      ctx.notify(`« ${payloadName(next)} » rangé ${dest ? `dans « ${dest} »` : "à la racine"}.`);
    } catch (e) {
      ctx.error(errorMessage(e));
    }
    await load();
  };

  const folderActions = (folder: GuiVaultEntity) => (
    <>
      <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setFolderMenu({ folderId: folder.id, x: r.right, y: r.bottom }); }} className="btn btn-ghost btn-sm btn-icon" title="Nouvel élément dans ce dossier" aria-label={`Nouvel élément dans ${folder.name}`}><IconPlus size={12} /></button>
      <button onClick={() => setNaming({ mode: "create", parentId: folder.id })} className="btn btn-ghost btn-sm btn-icon" title="Nouveau sous-dossier" aria-label={`Nouveau sous-dossier dans ${folder.name}`}><IconFolder size={12} /></button>
      <button onClick={() => setNaming({ mode: "rename", id: folder.id })} className="btn btn-ghost btn-sm btn-icon" title="Renommer" aria-label={`Renommer ${folder.name}`}><IconEdit size={12} /></button>
      <button onClick={() => { setSelected(folder.id); setMode({ kind: "view" }); }} className={`btn btn-ghost btn-sm ${selected === folder.id ? "btn-toggled" : ""}`} title="Ouvrir le dossier : icône, couleur, suppression">ouvrir</button>
    </>
  );

  /** Une icône importée depuis le sélecteur d'un hôte ou d'un dossier :
   * un item de plus, et l'index se recharge pour que le sélecteur la voie. */
  const addIcon = async (icon: CustomIcon) => {
    await putPayload(vault, { kind: "icon", icon });
    await load();
  };

  const otherWritable = ctx.session.vaults.filter((v) => v.id !== vault.id && canWrite(v.role));
  const selectedGroupId = current?.ok && current.payload.kind === "group" ? current.id : current?.ok && "groupId" in payloadEntity(current.payload) ? (payloadEntity(current.payload).groupId as string | null) : null;
  const isSecretItem = current?.ok && isSecret(current.payload);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 pl-4 max-md:pl-11">
        <h1 className="min-w-0 truncate text-[14px] font-semibold text-[var(--c-text)]">{vault.name}</h1>
        <span className="tag" title={ROLE_HINTS[vault.role]}>{vault.kind === "personal" ? "personnel" : ROLE_LABELS[vault.role]}</span>
        {vault.keyFrom.kind === "member" && !pinnedEmailFor(vault.keyFrom.fingerprint) && (
          <button
            type="button"
            onClick={() => navigate({ page: "vault-settings", id: vault.id })}
            className="tag"
            style={{ color: "var(--c-warn)" }}
            title="La clé de ce vault vous a été remise par quelqu'un dont vous n'avez pas vérifié l'empreinte — voir les réglages du vault"
          >
            clé non vérifiée
          </button>
        )}
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
                        <button key={k} onClick={() => { setNewMenu(false); if (k === "group") { setQuery(""); setFilter("all"); setNaming({ mode: "create", parentId: selectedGroupId }); } else setMode({ kind: "new", itemKind: k }); }} className="menu-item">
                          <Icon size={13} /> {capitalize(KIND_LABELS[k])}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
          <button onClick={() => navigate({ page: "vault-trash", id: vault.id })} className="btn btn-secondary btn-sm btn-icon" title="Corbeille : les éléments supprimés, à restaurer" aria-label="Corbeille"><IconTrash size={13} /></button>
          <button onClick={() => navigate({ page: "vault-tools", id: vault.id })} className="btn btn-secondary btn-sm btn-icon" title="Importer / exporter" aria-label="Importer / exporter"><IconTools size={13} /></button>
          <button onClick={() => navigate({ page: "vault-settings", id: vault.id })} className="btn btn-secondary btn-sm btn-icon" title="Réglages du vault : membres, invitations, clé" aria-label="Réglages du vault"><IconSettings size={13} /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section
          style={{ "--list-w": `${list.value}px` } as React.CSSProperties}
          className={`flex min-h-0 flex-col md:w-[var(--list-w)] md:shrink-0 ${mode.kind !== "view" || current ? "max-md:hidden" : ""}`}
        >
          <div className="shrink-0 space-y-1.5 p-2">
            <div className="flex items-center gap-1.5">
              <div className="relative min-w-0 flex-1">
                <IconSearch size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)]" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrer…" aria-label="Filtrer" className="input pl-7" />
              </div>
              {writable && (
                <button onClick={() => { setQuery(""); setFilter("all"); setNaming({ mode: "create", parentId: null }); }} className="btn btn-secondary btn-icon shrink-0" title="Nouveau dossier (à la racine ; le bouton d'un dossier en crée un dedans)" aria-label="Nouveau dossier"><IconFolder size={13} /><IconPlus size={9} className="-ml-1 -mt-2" /></button>
              )}
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
              <ItemTree
                entities={filtered}
                customIcons={index.icons}
                query={query}
                selected={selected}
                onSelect={(id) => { setSelected(id); setMode({ kind: "view" }); }}
                rowActions={rowActions}
                emptyMessage={writable ? "Rien ici pour l'instant — « Nouveau » pour commencer, importez un export, ou synchronisez depuis Guiterm." : "Rien ici pour l'instant."}
                {...(writable ? { folderActions, naming, onName: (n: string) => void submitFolderName(n), onNameCancel: () => setNaming(null), onMove: (id: string, folderId: string | null) => void moveToFolder(id, folderId) } : {})}
              />
            )}
          </div>
        </section>

        <PaneHandle onMouseDown={list.onMouseDown} />
        <section className={`flex min-h-0 flex-1 flex-col ${list.isDragging ? "pointer-events-none select-none" : ""}`}>
          {stale && mode.kind !== "view" && (
            <p className="callout callout-warn m-3 mb-0">Ce vault a été modifié entre-temps. Si cet élément l'a été aussi, l'enregistrement sera refusé : rechargez alors avant de réessayer.</p>
          )}
          {mode.kind === "new" && (
            <ItemForm key={`${mode.itemKind}-${mode.groupId ?? ""}`} kind={mode.itemKind} index={index} defaultGroupId={mode.groupId !== undefined ? mode.groupId : selectedGroupId} onSave={(p) => save(p)} onCancel={() => setMode({ kind: "view" })} onAddIcon={addIcon} />
          )}
          {mode.kind === "edit" && current?.ok && (
            <ItemForm kind={current.payload.kind} initial={current.payload} index={index} onSave={(p) => save(p, current.revision)} onCancel={() => setMode({ kind: "view" })} onAddIcon={addIcon} />
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
                {current.ok && (() => { const entity = entities.find((e) => e.id === current.id); return <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--c-bg3)] text-[var(--c-text-secondary)] [&>.host-icon]:h-[72%] [&>.host-icon]:w-[72%] [&>.host-icon>*]:h-full [&>.host-icon>*]:w-full">{entity ? <EntityIcon entity={entity} customIcons={index.icons} /> : null}</span>; })()}
                <h2 className="min-w-0 truncate text-[13px] font-semibold text-[var(--c-text)]">{current.ok ? payloadName(current.payload) : "Élément illisible"}</h2>
                <span className="text-[11px] text-[var(--c-text-faint)]" title={`Révision ${current.revision}`}>{current.ok ? KIND_LABELS[current.payload.kind] : current.itemType} · {formatWhen(current.updatedAt)}</span>
                <button onClick={() => setHistory(true)} className={`btn btn-ghost btn-sm btn-icon ${writable ? "" : "ml-auto"}`} title="Historique : ses versions précédentes" aria-label="Historique"><IconHistory size={13} /></button>
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

      {folderMenu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setFolderMenu(null)} />
          <div className="popover fixed z-40 w-44 py-1" role="menu" style={{ left: Math.max(8, Math.min(folderMenu.x - 176, window.innerWidth - 184)), top: Math.min(folderMenu.y + 4, window.innerHeight - 320) }}>
            {NEW_KINDS.filter((k) => k === "sep" || k === "group" || FOLDER_KINDS.has(k)).map((k, i) => {
              if (k === "sep") return <div key={i} className="menu-sep" />;
              const Icon = KIND_ICONS[k];
              return (
                <button key={k} role="menuitem" onClick={() => {
                  const folderId = folderMenu.folderId;
                  setFolderMenu(null);
                  if (k === "group") setNaming({ mode: "create", parentId: folderId });
                  else { setSelected(null); setMode({ kind: "new", itemKind: k, groupId: folderId }); }
                }} className="menu-item">
                  <Icon size={13} /> {capitalize(KIND_LABELS[k])}
                </button>
              );
            })}
          </div>
        </>
      )}
      {confirmDelete && current && (
        <ConfirmDialog
          title={`Supprimer « ${current.ok ? payloadName(current.payload) : current.id.slice(0, 8)} » ?`}
          message={(current.ok && current.payload.kind === "group" ? "Le dossier est supprimé ; ce qu'il contient remonte à la racine lors de la prochaine synchronisation de chaque appareil." : "Chaque appareil synchronisé le retire à son tour.") + " Il reste dans la corbeille du vault, d'où il peut être restauré."}
          confirmLabel="Supprimer"
          danger
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {history && current && (
        <ItemHistory
          vault={vault}
          item={current}
          index={index}
          writable={writable}
          onClose={() => setHistory(false)}
          onRestored={() => { setHistory(false); ctx.notify("Version restaurée."); void load(); }}
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

/** Ce qui peut naître dans un dossier. */
const FOLDER_KINDS = new Set<ItemKind>(["login", "note", "card", "identity", "api-key", "aws", "host", "sql-connection"]);

function payloadIdOf(p: Payload): string {
  return payloadEntity(p).id;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
