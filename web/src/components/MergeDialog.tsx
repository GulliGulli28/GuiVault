/** Un élément modifié des deux côtés (`lib/merge.ts`) : ce que la fusion
 * reprend de chaque version, et un choix pour chaque champ changé des deux
 * côtés. Ou, s'il a été supprimé entre-temps, le recréer avec notre version.
 * Le formulaire reste ouvert derrière : « Revenir à mes modifications » y
 * ramène tel quel. */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useModalSurface } from "../hooks/useModalSurface";
import { groupPath, type VaultIndex } from "../lib/entities";
import { buildMerge, planMerge, type MergeField, type MergePlan, type Side } from "../lib/merge";
import { decodeItem, payloadName, RevisionConflict, type VaultView } from "../lib/session";
import type { Group, Payload } from "../lib/types";
import { SecretValue } from "./ui";

/** Un enregistrement refusé parce que l'élément a changé entre-temps :
 * `base`, la version ouverte ; `mine`, la nôtre ; `theirs`, celle du serveur
 * (`null` : supprimé), à sa `revision`. */
interface Merge {
  name: string;
  base: Payload;
  mine: Payload;
  theirs: Payload | null;
  revision: number | undefined;
  plan: MergePlan | null;
}

/** La fusion au moment d'enregistrer une modification — page du vault et
 * popup de l'extension. `offer` sur un `RevisionConflict` : la fusion à
 * proposer (`false` : rien à proposer, version illisible — l'erreur remonte
 * comme avant) ; `dialog` à rendre. `write` enregistre (et peut refuser à
 * nouveau : on refusionne) ; `done` reçoit la version enregistrée — ou la
 * nôtre, déjà contenue dans celle du serveur — et le message à dire. */
export function useMerge({ vault, index, write, done, discard }: {
  vault: VaultView | undefined;
  index: VaultIndex;
  write: (p: Payload, revision: number | undefined) => Promise<void>;
  done: (p: Payload, message: string) => void | Promise<void>;
  discard: () => void;
}) {
  const [merge, setMerge] = useState<Merge | null>(null);
  // Stable : `useModalSurface` rend le focus à l'ouvreur quand `onClose` change.
  const close = useCallback(() => setMerge(null), []);

  const offer = (base: Payload, mine: Payload, conflict: unknown): boolean => {
    if (!(conflict instanceof RevisionConflict) || !vault) return false;
    const cur = conflict.current;
    if (!cur || cur.deleted) {
      setMerge({ name: payloadName(mine), base, mine, theirs: null, revision: undefined, plan: null });
      return true;
    }
    const theirs = decodeItem(vault, cur);
    if (!theirs.ok || theirs.payload.kind !== mine.kind) return false;
    const plan = planMerge(base, mine, theirs.payload);
    if (plan.fromMine.length === 0 && plan.conflicts.length === 0) {
      // Rien de nous qui n'y soit déjà : pas d'écriture.
      setMerge(null);
      void done(theirs.payload, `« ${payloadName(mine)} » : la version enregistrée contient déjà vos modifications.`);
      return true;
    }
    setMerge({ name: payloadName(mine), base, mine, theirs: theirs.payload, revision: theirs.revision, plan });
    return true;
  };

  const save = async (choices: Record<string, Side>) => {
    if (!merge) return;
    const merged = merge.theirs && merge.plan ? buildMerge(merge.mine, merge.theirs, merge.plan, choices) : merge.mine;
    try {
      await write(merged, merge.revision);
    } catch (e) {
      // Encore changé entre-temps : on refusionne sur la nouvelle version.
      if (offer(merge.theirs ?? merge.base, merged, e)) return;
      throw e;
    }
    setMerge(null);
    await done(merged, `« ${payloadName(merged)} » enregistré ${merge.theirs ? "(versions fusionnées)" : "(recréé)"}.`);
  };

  const dialog = merge ? (
    <MergeDialog
      key={merge.revision ?? "supprimé"}
      name={merge.name}
      plan={merge.plan}
      deleted={!merge.theirs}
      index={index}
      onSave={save}
      onBack={close}
      onDiscard={() => {
        setMerge(null);
        discard();
      }}
    />
  ) : null;
  return { offer, dialog };
}

export function MergeDialog({ name, plan, deleted, index, onSave, onBack, onDiscard }: {
  name: string;
  /** `null` : l'élément a été supprimé entre-temps. */
  plan: MergePlan | null;
  deleted?: boolean;
  index: VaultIndex;
  /** Enregistrer la fusion (ou recréer). Peut rejeter : le message s'affiche ici. */
  onSave: (choices: Record<string, Side>) => Promise<void>;
  /** Stable (`useCallback`) : `useModalSurface` rend le focus quand il change. */
  onBack: () => void;
  onDiscard: () => void;
}) {
  const title = deleted ? `« ${name} » a été supprimé entre-temps` : `« ${name} » a été modifié entre-temps`;
  const { ref, dialogProps } = useModalSurface({ onClose: onBack, label: title });
  const [choices, setChoices] = useState<Record<string, Side>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => new Map(index.groups.map((g) => [g.id, g])), [index.groups]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(choices);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const passwordChosen = plan?.conflicts.some((f) => f.path === "login.password");

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onBack} />
      <div ref={ref} {...dialogProps} className="modal fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col p-4">
        <h2 className="text-[14px] font-semibold text-[var(--c-text)]">{title}</h2>
        <div className="sidebar-scroll mt-1.5 min-h-0 flex-1 space-y-3 overflow-y-auto text-[12.5px] leading-relaxed text-[var(--c-text-secondary)]">
          {deleted || !plan ? (
            <p>
              Un autre appareil ou un autre membre l'a supprimé pendant que vous le modifiiez ; il est dans la corbeille du vault.
              Le recréer avec votre version, ou abandonner vos modifications ?
            </p>
          ) : (
            <>
              <p>Un autre appareil ou un autre membre l'a enregistré pendant que vous le modifiiez. La fusion des deux versions :</p>
              {plan.fromTheirs.length > 0 && <p><span className="font-medium text-[var(--c-text)]">Repris de la version enregistrée :</span> {labels(plan.fromTheirs)}.</p>}
              {plan.fromMine.length > 0 && <p><span className="font-medium text-[var(--c-text)]">Gardé de la vôtre :</span> {labels(plan.fromMine)}.</p>}
              {plan.conflicts.length > 0 && (
                <div className="space-y-2">
                  <p className="font-medium text-[var(--c-text)]">Modifié des deux côtés — à choisir :</p>
                  {plan.conflicts.map((f) => (
                    <fieldset key={f.path} className="card space-y-1.5 p-2.5">
                      <legend className="px-1 text-[12px] font-medium text-[var(--c-text)]">{f.label}</legend>
                      {(["mine", "theirs"] as Side[]).map((side) => {
                        const id = `merge-${f.path}-${side}`;
                        return (
                          <div key={side} className="flex items-start gap-2">
                            <input
                              type="radio"
                              id={id}
                              name={`merge-${f.path}`}
                              checked={(choices[f.path] ?? "mine") === side}
                              onChange={() => setChoices((c) => ({ ...c, [f.path]: side }))}
                              className="mt-1"
                            />
                            <label htmlFor={id} className="w-40 shrink-0 cursor-pointer whitespace-nowrap text-[var(--c-text)]">{side === "mine" ? "Ma version" : "Version enregistrée"}</label>
                            <div className="min-w-0 flex-1">{value(f, side === "mine" ? f.mine : f.theirs, groups)}</div>
                          </div>
                        );
                      })}
                    </fieldset>
                  ))}
                  {passwordChosen && <p className="help-text">Le mot de passe écarté est gardé dans l'historique de l'élément.</p>}
                </div>
              )}
            </>
          )}
          {error && <p className="callout callout-danger">{error}</p>}
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button onClick={onBack} className="btn btn-ghost">Revenir à mes modifications</button>
          <button onClick={onDiscard} className="btn btn-secondary">Abandonner les miennes</button>
          <button onClick={() => void save()} disabled={busy} autoFocus className="btn btn-primary">
            {busy ? "Enregistrement…" : deleted || !plan ? "Recréer avec ma version" : "Enregistrer la fusion"}
          </button>
        </div>
      </div>
    </>
  );
}

function labels(fields: MergeField[]): string {
  return [...new Set(fields.map((f) => f.label))].join(", ");
}

/** Une valeur de champ, lisible : secret masqué, dossier par son chemin,
 * tableau résumé. */
function value(f: MergeField, v: unknown, groups: Map<string, Group>): ReactNode {
  const empty = <span className="text-[var(--c-text-faint)]">(vide)</span>;
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) return empty;
  if (f.secret && typeof v === "string") return <SecretValue value={v} />;
  const last = f.path.split(".").pop();
  if ((last === "groupId" || last === "parentId") && typeof v === "string") return <span className="text-[var(--c-text)]">{groupPath(groups, v) || "Racine"}</span>;
  if (typeof v === "boolean") return <span className="text-[var(--c-text)]">{v ? "oui" : "non"}</span>;
  const text = Array.isArray(v) ? v.map(summarize).join(", ") : summarize(v);
  return <span className="block truncate text-[var(--c-text)]" title={text}>{text}</span>;
}

function summarize(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const named = o.uri ?? o.name ?? o.label ?? o.title;
    if (typeof named === "string") return named;
  }
  return JSON.stringify(v);
}
