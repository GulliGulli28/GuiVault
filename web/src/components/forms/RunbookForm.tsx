import { useState } from "react";
import { uuid } from "../../lib/bytes";
import type { VaultIndex } from "../../lib/entities";
import type { Payload, Runbook, RunbookAction, RunbookApproval, RunbookOnFailure, RunbookStep } from "../../lib/types";
import { IconArrowUp, IconClose, IconPlus } from "../ui-icons";
import { Field, FormShell, HostSelect, TagsInput, useSeed } from "./common";

export const ON_FAILURE_LABELS: Record<RunbookOnFailure, string> = {
  stop: "Arrêter le runbook",
  continue: "Continuer avec toutes les cibles",
  dropFailed: "Continuer sans les cibles en échec",
};

export const APPROVAL_LABELS: Record<RunbookApproval, string> = {
  beforeIrreversible: "Avant une opération irréversible",
  never: "Jamais",
  always: "Toujours",
};

export const ACTION_LABELS: Record<RunbookAction["kind"], string> = {
  command: "Commande shell",
  program: "Programme adaptatif",
  playbook: "Playbook Ansible",
};

function newStep(): RunbookStep {
  return { id: uuid(), title: "", notes: "", action: { kind: "command", command: "" }, scope: { tags: [], groups: [] }, onFailure: "stop", approval: "beforeIrreversible" };
}

/** Changer le genre d'action repart de ses champs, sans recopier ceux d'un
 * autre genre (Guiterm refuserait un `command` sur un playbook). */
function actionOf(kind: RunbookAction["kind"], from: RunbookAction): RunbookAction {
  if (kind === from.kind) return from;
  if (kind === "command") return { kind, command: from.kind === "program" ? from.programText : "" };
  if (kind === "program") return { kind, programText: from.kind === "command" ? from.command : "" };
  return { kind, relayHostId: "", relayHostLabel: "", playbook: "", inventory: "" };
}

/** Le runbook de Guiterm : une procédure ordonnée, chaque étape avec son
 * action, sa portée (tags et dossiers, jamais d'hôte), ce qui se passe si
 * elle échoue et quand demander l'accord. Les cibles se choisissent au
 * lancement, dans Guiterm. */
export function RunbookForm({ initial, index, onSave, onCancel }: {
  initial?: Runbook;
  index: VaultIndex;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
}) {
  const seed = useSeed(initial, (p) => (p.kind === "runbook" ? p.runbook : undefined));
  const [rb, setRb] = useState<Runbook>(seed ?? { id: uuid(), name: "", description: "", steps: [newStep()] });
  const setStep = (i: number, patch: Partial<RunbookStep>) => setRb({ ...rb, steps: rb.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, by: number) => {
    const steps = [...rb.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(i + by, 0, s);
    setRb({ ...rb, steps });
  };

  const validate = () => {
    if (!rb.name.trim()) return "Le nom est obligatoire.";
    if (rb.steps.length === 0) return "Un runbook a au moins une étape.";
    const bad = rb.steps.findIndex((s) => !s.title.trim());
    if (bad >= 0) return `L'étape ${bad + 1} n'a pas de titre.`;
    const empty = rb.steps.findIndex((s) => (s.action.kind === "command" ? !s.action.command.trim() : s.action.kind === "program" ? !s.action.programText.trim() : !s.action.relayHostId || !s.action.playbook.trim()));
    if (empty >= 0) return `L'étape ${empty + 1} n'a rien à exécuter.`;
    return null;
  };

  return (
    <FormShell title={initial ? `Modifier « ${initial.name} »` : "Nouveau runbook"} onSave={() => onSave({ kind: "runbook", runbook: { ...rb, name: rb.name.trim(), steps: rb.steps.map((s) => ({ ...s, title: s.title.trim() })) } })} onCancel={onCancel} validate={validate}>
      <Field label="Nom">
        <input value={rb.name} onChange={(e) => setRb({ ...rb, name: e.target.value })} autoFocus placeholder="Mise à jour des serveurs web" className="input" />
      </Field>
      <Field label="Description" hint="À quoi sert la procédure, en une ou deux phrases : affichée en tête de l'onglet et dans le rapport.">
        <textarea value={rb.description} onChange={(e) => setRb({ ...rb, description: e.target.value })} rows={2} className="input" />
      </Field>
      <div role="group" aria-label="Étapes" className="space-y-2">
        <span className="field-label">Étapes</span>
        {rb.steps.map((s, i) => (
          <div key={s.id} className="card space-y-2 p-3">
            <div className="flex items-center gap-1.5">
              <span className="tag shrink-0">{i + 1}</span>
              <input value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} placeholder="Ce que fait l'étape, en une ligne" aria-label={`Titre de l'étape ${i + 1}`} className="input min-w-0 flex-1" />
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="btn btn-ghost btn-sm btn-icon" title="Monter" aria-label={`Monter l'étape ${i + 1}`}><IconArrowUp size={11} /></button>
              <button type="button" disabled={i === rb.steps.length - 1} onClick={() => move(i, 1)} className="btn btn-ghost btn-sm btn-icon" title="Descendre" aria-label={`Descendre l'étape ${i + 1}`}><IconArrowUp size={11} className="rotate-180" /></button>
              <button type="button" onClick={() => setRb({ ...rb, steps: rb.steps.filter((_, j) => j !== i) })} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Retirer" aria-label={`Retirer l'étape ${i + 1}`}><IconClose size={11} /></button>
            </div>
            <Field label="Action">
              <select value={s.action.kind} onChange={(e) => setStep(i, { action: actionOf(e.target.value as RunbookAction["kind"], s.action) })} className="input">
                {(Object.keys(ACTION_LABELS) as RunbookAction["kind"][]).map((k) => <option key={k} value={k}>{ACTION_LABELS[k]}</option>)}
              </select>
            </Field>
            {s.action.kind === "command" && (
              <textarea value={s.action.command} onChange={(e) => setStep(i, { action: { ...s.action, kind: "command", command: e.target.value } })} rows={3} spellCheck={false} placeholder="sudo apt-get update && sudo apt-get -y upgrade" aria-label={`Commande de l'étape ${i + 1}`} className="input input-mono" />
            )}
            {s.action.kind === "program" && (
              <textarea value={s.action.programText} onChange={(e) => setStep(i, { action: { ...s.action, kind: "program", programText: e.target.value } })} rows={4} spellCheck={false} aria-label={`Programme de l'étape ${i + 1}`} className="input input-mono" />
            )}
            {s.action.kind === "playbook" && (() => {
              const a = s.action;
              return (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Hôte relais" className="col-span-2" hint="L'hôte d'où le playbook est joué (le nœud de contrôle Ansible).">
                    <HostSelect index={index} value={a.relayHostId || null} none={a.relayHostLabel ? `${a.relayHostLabel} (absent de ce vault)` : "Choisir…"} onChange={(id) => setStep(i, { action: { ...a, relayHostId: id ?? "", relayHostLabel: index.hosts.find((h) => h.id === id)?.label ?? "" } })} />
                  </Field>
                  <Field label="Playbook (sur le relais)">
                    <input value={a.playbook} onChange={(e) => setStep(i, { action: { ...a, playbook: e.target.value } })} placeholder="site.yml" className="input input-mono" />
                  </Field>
                  <Field label="Inventaire">
                    <input value={a.inventory} onChange={(e) => setStep(i, { action: { ...a, inventory: e.target.value } })} placeholder="celui de ansible.cfg" className="input input-mono" />
                  </Field>
                </div>
              );
            })()}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Seulement les hôtes avec ces tags">
                <TagsInput value={s.scope.tags} onChange={(tags) => setStep(i, { scope: { ...s.scope, tags } })} />
              </Field>
              <Field label="Et dans un de ces dossiers">
                <TagsInput value={s.scope.groups} onChange={(groups) => setStep(i, { scope: { ...s.scope, groups } })} commas placeholder="Prod Paris, Lyon" />
              </Field>
              <Field label="En cas d'échec">
                <select value={s.onFailure} onChange={(e) => setStep(i, { onFailure: e.target.value as RunbookOnFailure })} className="input">
                  {(Object.keys(ON_FAILURE_LABELS) as RunbookOnFailure[]).map((k) => <option key={k} value={k}>{ON_FAILURE_LABELS[k]}</option>)}
                </select>
              </Field>
              <Field label="Demander l'accord">
                <select value={s.approval} onChange={(e) => setStep(i, { approval: e.target.value as RunbookApproval })} className="input">
                  {(Object.keys(APPROVAL_LABELS) as RunbookApproval[]).map((k) => <option key={k} value={k}>{APPROVAL_LABELS[k]}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Notes" hint="Le pourquoi, le ticket, ce qu'il faut vérifier avant de continuer. Jamais exécutées.">
              <textarea value={s.notes} onChange={(e) => setStep(i, { notes: e.target.value })} rows={2} className="input" />
            </Field>
          </div>
        ))}
        <button type="button" onClick={() => setRb({ ...rb, steps: [...rb.steps, newStep()] })} className="btn btn-secondary btn-sm"><IconPlus size={11} /> Ajouter une étape</button>
      </div>
    </FormShell>
  );
}
