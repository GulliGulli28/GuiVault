import { useCallback, useMemo, useState } from "react";
import type { PageContext } from "../App";
import { supports } from "../lib/api";
import { healthSummary, useAllItems, type VaultItem } from "../lib/allItems";
import { toEntities } from "../lib/entities";
import { primarySecret } from "../lib/items";
import { navigate, routeHash } from "../lib/route";
import { coffreName } from "../lib/localHost";
import { personInitials } from "../lib/tiles";
import { useVaultColors, vaultColor } from "../lib/vaultColors";
import { canWrite, KIND_LABELS, ROLE_LABELS, type CustomIcon, type GuiVaultEntity } from "../lib/types";
import { ItemTile, KIND_ICONS } from "./ItemTree";
import { NEW_KINDS } from "./VaultPage";
import { NewVaultDialog } from "./NewVault";
import { TotpCode } from "./TotpCode";
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconLock, IconPlus, IconSearch, IconVault } from "./ui-icons";
import { Logo } from "./Logo";
import { NARROW, useMediaQuery } from "../hooks/useMediaQuery";
import { copyText, Dropdown, formatAgo } from "./ui";

/** Un élément tel que l'accueil le montre : son entité (nom, ligne
 * secondaire, épinglé) et de quoi l'ouvrir. */
interface HomeEntry extends VaultItem {
  entity: GuiVaultEntity;
  icons: CustomIcon[];
}

const QUICK = 6;

/** Le prénom affiché : la première partie de l'e-mail, capitalisée. */
function firstName(email: string): string {
  const part = email.split("@")[0].split(/[.\-_+]/)[0] ?? "";
  return part ? part.charAt(0).toLocaleUpperCase("fr-FR") + part.slice(1) : "";
}

/** L'accueil (`docs/DESIGN.md`) : l'accès rapide (épinglés, puis les plus
 * récents), les codes 2FA, la santé, les coffres et les invitations en
 * attente. Tout est lu et calculé ici, comme le reste. */
export function HomePage({ ctx }: { ctx: PageContext }) {
  const { session } = ctx;
  const local = session.local;
  const colors = useVaultColors();
  const { items, counts, loading } = useAllItems(session, ctx.error);

  const entries = useMemo(() => {
    const out: HomeEntry[] = [];
    const byVault = new Map<string, VaultItem[]>();
    for (const x of items) byVault.set(x.vault.id, [...(byVault.get(x.vault.id) ?? []), x]);
    for (const list of byVault.values()) {
      const ents = new Map(toEntities(list.map((x) => x.item)).map((e) => [e.id, e]));
      const icons = list.flatMap((x) => (x.item.payload.kind === "icon" ? [x.item.payload.icon] : []));
      for (const x of list) {
        const entity = ents.get(x.item.id);
        if (entity && entity.kind !== "group" && entity.kind !== "icon") out.push({ ...x, entity, icons });
      }
    }
    return out;
  }, [items]);

  const recent = useMemo(() => [...entries].sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt)), [entries]);
  const quick = useMemo(() => {
    const pinned = entries.filter((e) => e.entity.favorite);
    const rest = recent.filter((e) => !e.entity.favorite && e.entity.kind === "login");
    return [...pinned, ...rest].slice(0, QUICK);
  }, [entries, recent]);
  const codes = useMemo(() => entries.filter((e) => e.item.payload.kind === "login" && e.item.payload.login.totp).slice(0, 5), [entries]);
  const health = useMemo(() => healthSummary(items), [items]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const target = session.vaults.find((v) => v.kind === "personal" && canWrite(v.role)) ?? session.vaults.find((v) => canWrite(v.role));
  const open = (e: HomeEntry) => navigate({ page: "vault", id: e.vault.id, item: e.item.id });
  const name = local ? coffreName(local.path) : firstName(session.user.email);
  const narrow = useMediaQuery(NARROW);

  if (narrow) {
    return (
      <div className="m-page">
        <header className="m-head">
          <Logo size={30} />
          <h1 className="m-title min-w-0 flex-1 truncate text-[22px]">{local ? name : `Bonjour ${name}`}</h1>
          <button onClick={ctx.lock} className="m-icon border border-[var(--c-border-strong)] bg-[var(--c-surface)]" aria-label="Verrouiller" title="Verrouiller"><IconLock size={18} /></button>
        </header>
        <div className="m-body">
          <button onClick={ctx.search} className="m-search text-left">
            <IconSearch size={18} />
            <span className="min-w-0 flex-1 truncate">Rechercher dans {session.vaults.length > 1 ? `${session.vaults.length} coffres` : "le coffre"}</span>
          </button>
          {supports("myInvitations") && session.invitations.map((inv) => (
            <div key={inv.id} className="m-card flex min-w-0 items-center gap-3 px-3.5 py-3">
              <span className="tile shrink-0 rounded-full" style={{ "--tile-size": "36px", "--tile-h": 25 } as React.CSSProperties}>{personInitials(inv.inviter_email)}</span>
              <p className="clamp-2 min-w-0 flex-1 text-[14px]"><b className="font-semibold">{inv.inviter_email}</b> vous invite dans un vault partagé</p>
              <a href={routeHash({ page: "invitations" })} className="m-btn m-btn-primary h-10 px-3.5 text-[14px]">Voir</a>
            </div>
          ))}
          <section className="flex flex-col gap-2.5" aria-labelledby="m-quick">
            <h2 id="m-quick" className="text-[17px] font-semibold">Accès rapide</h2>
            {quick.length === 0 ? (
              <div className="m-card px-4 py-8 text-center text-[14px] text-[var(--c-text-muted)]">{loading ? "Lecture des coffres…" : "Rien à montrer pour l'instant."}</div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                {quick.map((e) => (
                  <a key={`${e.vault.id}-${e.item.id}`} href={routeHash({ page: "vault", id: e.vault.id, item: e.item.id })} className="m-card flex min-w-0 flex-col gap-2.5 p-3.5 text-[var(--c-text)] hover:no-underline">
                    <ItemTile entity={e.entity} customIcons={e.icons} size={36} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-semibold">{e.entity.name}</span>
                      <span className="truncate text-[13px] text-[var(--c-text-muted)]">{e.entity.subtitle ?? e.vault.name}</span>
                    </span>
                  </a>
                ))}
              </div>
            )}
          </section>
          {codes.length > 0 && (
            <section className="m-card px-4 py-1.5" aria-labelledby="m-otp">
              <div className="flex min-h-[48px] items-center gap-2.5">
                <h2 id="m-otp" className="min-w-0 flex-1 text-[17px] font-semibold">Codes 2FA</h2>
                <a href={routeHash({ page: "totp" })} className="text-[14px]">Tout voir</a>
              </div>
              <div className="m-list">
                {codes.map((e) => (
                  <div key={`${e.vault.id}-${e.item.id}`} className="flex min-h-[56px] min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1 truncate font-medium">{e.entity.name}</span>
                    {e.item.payload.kind === "login" && e.item.payload.login.totp && <TotpCode secret={e.item.payload.login.totp} size="lg" />}
                  </div>
                ))}
              </div>
            </section>
          )}
          <a href={routeHash({ page: "health" })} className="m-card flex min-w-0 items-center gap-3.5 px-4 py-3.5 text-[var(--c-text)] hover:no-underline">
            <span className="whitespace-nowrap"><span className="text-[26px] font-semibold">{loading ? "…" : health.score}</span><span className="text-[var(--c-text-muted)]"> /100</span></span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">Santé</span>
              <span className={`truncate text-[13px] ${health.issues ? "text-[var(--c-warn-text)]" : "text-[var(--c-text-muted)]"}`}>{health.issues ? `${health.issues} ${health.issues > 1 ? "éléments à corriger" : "élément à corriger"}` : "Rien à corriger"}</span>
            </span>
            <IconChevronRight size={16} className="shrink-0 text-[var(--c-text-faint)]" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1320px] flex-col gap-7 px-10 py-8 max-md:px-4">
        <header className="flex flex-wrap items-end gap-4">
          <div className="min-w-[240px] flex-1">
            <h1 className="page-title truncate">{local ? name : `Bonjour ${name}`}</h1>
            <p className="page-sub">
              {session.vaults.length} {session.vaults.length > 1 ? "coffres" : "coffre"}
              {!loading && <> · {total} {total > 1 ? "éléments" : "élément"}</>}
            </p>
          </div>
          {target && <NewMenu ctx={ctx} defaultVault={target.id} />}
        </header>

        {supports("myInvitations") && session.invitations.map((inv) => (
          <div key={inv.id} className="card flex flex-wrap items-center gap-x-3.5 gap-y-2 px-[18px] py-3.5">
            <span className="tile h-8 w-8 rounded-full text-[12px]" style={{ "--tile-h": 25 } as React.CSSProperties}>{personInitials(inv.inviter_email)}</span>
            <p className="min-w-[220px] flex-1 truncate text-[13.5px]">
              <b className="font-semibold">{inv.inviter_email}</b> vous invite dans un vault partagé comme {ROLE_LABELS[inv.role]}.
            </p>
            <a href={routeHash({ page: "invitations" })} className="btn btn-secondary">Voir l'invitation</a>
          </div>
        ))}

        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-6">
            <section aria-labelledby="home-quick">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 id="home-quick" className="section-title">Accès rapide</h2>
                <span className="text-[12.5px] text-[var(--c-text-muted)]">Épinglés, puis les plus récents</span>
              </div>
              {quick.length === 0 ? (
                <div className="card px-5 py-8 text-center text-[13px] text-[var(--c-text-muted)]">{loading ? "Lecture des coffres…" : "Rien à montrer pour l'instant."}</div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
                  {quick.map((e) => {
                    const secret = primarySecret(e.item.payload);
                    return (
                      <div key={`${e.vault.id}-${e.item.id}`} className="card flex min-w-0 items-center gap-3 p-3 transition-colors hover:border-[var(--c-border-strong)]">
                        <ItemTile entity={e.entity} customIcons={e.icons} size={36} />
                        <a href={routeHash({ page: "vault", id: e.vault.id, item: e.item.id })} className="flex min-w-0 flex-1 flex-col text-[var(--c-text)]">
                          <span className="truncate font-semibold">{e.entity.name}</span>
                          <span className="truncate text-[12.5px] text-[var(--c-text-muted)]">{e.entity.subtitle ?? e.vault.name}</span>
                        </a>
                        {secret && (
                          <button
                            onClick={() => void copyText(secret.value).then((ok) => (ok ? ctx.notify(`${secret.label.charAt(0).toUpperCase()}${secret.label.slice(1)} copié.`) : ctx.error("Copie refusée par le navigateur.")))}
                            className="btn btn-ghost btn-icon"
                            title={`Copier ${secret.label}`}
                            aria-label={`Copier ${secret.label} de ${e.entity.name}`}
                          >
                            <IconCopy size={15} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {recent.length > 0 && (
              <section aria-labelledby="home-recent" className="card px-5 py-4">
                <h2 id="home-recent" className="section-title mb-1.5">Modifiés récemment</h2>
                <div className="divide-y divide-[var(--c-border)]">
                  {recent.slice(0, 5).map((e) => (
                    <button key={`${e.vault.id}-${e.item.id}`} onClick={() => open(e)} className="flex w-full min-w-0 items-center gap-3 py-2.5 text-left">
                      <ItemTile entity={e.entity} customIcons={e.icons} size={28} />
                      <span className="min-w-0 flex-1 truncate font-medium">{e.entity.name}</span>
                      <span className="flex max-w-[180px] min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--c-text-muted)] max-md:hidden">
                        <span className="vdot" style={{ background: vaultColor(e.vault.id, e.vault.kind === "personal", colors) }} />
                        <span className="truncate">{e.vault.name}</span>
                      </span>
                      <span className="w-24 shrink-0 text-right text-[12.5px] text-[var(--c-text-muted)]">{formatAgo(e.item.updatedAt)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>

          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-6">
            {codes.length > 0 && (
              <section aria-labelledby="home-otp" className="card px-5 py-4">
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <h2 id="home-otp" className="section-title">Codes 2FA</h2>
                  <a href={routeHash({ page: "totp" })} className="text-[12.5px]">Tout voir</a>
                </div>
                <div className="divide-y divide-[var(--c-border)]">
                  {codes.map((e) => (
                    <div key={`${e.vault.id}-${e.item.id}`} className="flex min-w-0 items-center gap-3 py-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{e.entity.name}</span>
                      {e.item.payload.kind === "login" && e.item.payload.login.totp && <TotpCode secret={e.item.payload.login.totp} />}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section aria-labelledby="home-health" className="card flex flex-col gap-3 px-5 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="home-health" className="section-title">Santé</h2>
                <span className="whitespace-nowrap"><span className="text-[24px] font-semibold tracking-[-0.02em]">{loading ? "…" : health.score}</span><span className="text-[var(--c-text-muted)]"> / 100</span></span>
              </div>
              <HealthBar total={health.total} weak={health.weak} reused={health.reused} />
              {health.issues > 0 ? (
                <a href={routeHash({ page: "health" })} className="callout callout-warn flex items-center justify-between gap-2 font-medium hover:no-underline">
                  <span className="truncate">{health.issues} {health.issues > 1 ? "éléments à corriger" : "élément à corriger"}</span>
                  <IconChevronRight size={14} />
                </a>
              ) : (
                <p className="text-[13px] text-[var(--c-text-muted)]">{loading ? "Analyse…" : "Rien à corriger."}</p>
              )}
            </section>

            <section aria-labelledby="home-vaults" className="card px-5 py-4">
              <h2 id="home-vaults" className="section-title mb-1.5">Coffres</h2>
              <div className="divide-y divide-[var(--c-border)]">
                {session.vaults.map((v) => (
                  <a key={v.id} href={routeHash({ page: "vault", id: v.id })} className="flex min-w-0 items-center gap-2.5 py-2.5 text-[var(--c-text)] hover:no-underline">
                    <span className="vdot h-2.5 w-2.5" style={{ background: vaultColor(v.id, v.kind === "personal", colors) }} />
                    <span className="min-w-0 flex-1 truncate font-medium">{v.name}</span>
                    <span className="shrink-0 whitespace-nowrap text-[12.5px] text-[var(--c-text-muted)]">
                      {counts[v.id] !== undefined ? `${counts[v.id]} · ` : ""}{v.kind === "personal" ? "personnel" : ROLE_LABELS[v.role]}
                    </span>
                  </a>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

/** La barre de santé : sains, faibles, réutilisés, en proportion. */
export function HealthBar({ total, weak, reused }: { total: number; weak: number; reused: number }) {
  const ok = Math.max(0, total - weak - reused);
  if (total === 0) return <div className="h-2 rounded bg-[var(--c-bg3)]" />;
  return (
    <div className="flex h-2 gap-[3px]" role="img" aria-label={`${ok} sains, ${weak} faibles, ${reused} réutilisés`}>
      {ok > 0 && <span className="rounded-l rounded-r-none bg-[var(--c-ok)] first:rounded-l last:rounded-r" style={{ flex: ok }} />}
      {weak > 0 && <span className="bg-[var(--c-warn)] first:rounded-l last:rounded-r" style={{ flex: weak }} />}
      {reused > 0 && <span className="bg-[var(--c-danger)] first:rounded-l last:rounded-r" style={{ flex: reused }} />}
    </div>
  );
}

/** « Nouvel élément » de l'accueil : dans quel vault (s'il y en a plusieurs
 * où écrire), chaque type d'élément, un dossier — ou un nouveau vault. */
function NewMenu({ ctx, defaultVault }: { ctx: PageContext; defaultVault: string }) {
  const colors = useVaultColors();
  const writable = ctx.session.vaults.filter((v) => canWrite(v.role));
  const [vaultId, setVaultId] = useState(defaultVault);
  const [creating, setCreating] = useState(false);
  const closeCreating = useCallback(() => setCreating(false), []);
  return (
    <>
      <Dropdown
        label="Nouvel élément"
        className="w-64"
        trigger={({ open, toggle }) => (
          <button onClick={toggle} aria-expanded={open} aria-haspopup="menu" className="btn btn-primary btn-lg">
            <IconPlus size={15} /> Nouvel élément <IconChevronDown size={13} />
          </button>
        )}
      >
        {(close) => (
          <>
            {writable.length > 1 && (
              <>
                <p className="px-3.5 pb-1 pt-1.5 text-[12px] font-medium text-[var(--c-text-muted)]">Dans</p>
                {writable.map((v) => (
                  <button key={v.id} role="menuitemradio" aria-checked={v.id === vaultId} data-active={v.id === vaultId ? "true" : undefined} onClick={() => setVaultId(v.id)} className="menu-item">
                    <span className="vdot" style={{ background: vaultColor(v.id, v.kind === "personal", colors) }} />
                    <span className="min-w-0 flex-1 truncate">{v.name}</span>
                    {v.id === vaultId && <IconCheck size={14} />}
                  </button>
                ))}
                <div className="menu-sep" />
              </>
            )}
            {NEW_KINDS.map((k, i) => {
              if (k === "sep") return <div key={i} className="menu-sep" />;
              const Icon = KIND_ICONS[k];
              return (
                <button key={k} role="menuitem" onClick={() => { close(); navigate({ page: "vault", id: vaultId, create: k }); }} className="menu-item">
                  <Icon size={14} /> {k === "group" ? "Dossier" : KIND_LABELS[k].charAt(0).toUpperCase() + KIND_LABELS[k].slice(1)}
                </button>
              );
            })}
            <div className="menu-sep" />
            <button role="menuitem" onClick={() => { close(); setCreating(true); }} className="menu-item">
              <IconVault size={14} /> {ctx.session.local ? "Nouveau vault" : "Nouveau vault partagé"}
            </button>
          </>
        )}
      </Dropdown>
      {creating && <NewVaultDialog ctx={ctx} onClose={closeCreating} />}
    </>
  );
}
