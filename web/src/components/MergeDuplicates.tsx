/** Fusionner des doublons (rapport de santé, onglet « Doublons ») : choisir
 * l'élément qui reste ; les autres s'y fondent (`mergeLogins`) puis partent
 * dans la corbeille, leurs pièces jointes rattachées à celui qui reste. */
import { useCallback, useState } from "react";
import { api, ApiError, errorMessage } from "../lib/api";
import { mergeLogins } from "../lib/duplicates";
import type { HealthEntry } from "../lib/health";
import { deleteItem, findVault, payloadName, putPayload, type SessionState } from "../lib/session";
import { formatAgo, Modal } from "./ui";
import { useReprompt } from "./Reprompt";

/** Une fusion n'a de sens qu'entre identifiants d'un vault où l'on écrit. */
export function canMerge(group: HealthEntry[]): boolean {
  return group.length > 1 && group.every((e) => e.item.payload.kind === "login" && e.vault.role !== "reader" && e.vault.id === group[0].vault.id);
}

export function MergeDuplicates({ session, group, onClose, onMerged }: { session: SessionState; group: HealthEntry[]; onClose: () => void; onMerged: (name: string) => void }) {
  // Par défaut, le plus récemment modifié reste.
  const [keepId, setKeepId] = useState(() => [...group].sort((a, b) => Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt))[0].item.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = useReprompt();
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);

  const merge = async () => {
    const keep = group.find((e) => e.item.id === keepId)!;
    const drops = group.filter((e) => e !== keep);
    const vault = findVault(session, keep.vault.id);
    if (!vault || keep.item.payload.kind !== "login") return;
    // Un élément protégé ne se fond pas dans un autre sans son mot de passe.
    for (const e of group) if (!(await ask(e.item.payload))) return;
    setBusy(true);
    setError(null);
    try {
      let merged = keep.item.payload.login;
      for (const d of drops) if (d.item.payload.kind === "login") merged = mergeLogins(merged, d.item.payload.login);
      // Celui qui reste d'abord : s'il échoue, rien n'a bougé.
      await putPayload(vault, { kind: "login", login: merged }, keep.item.revision);
      for (const d of drops) {
        for (const a of (d.item.payload.kind === "login" ? d.item.payload.login.attachments : undefined) ?? []) {
          try {
            await api.moveAttachment(vault.id, a.id, { vault_id: vault.id, item_id: keep.item.id });
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 404)) throw e;
          }
        }
        await deleteItem(vault, d.item.id);
      }
      onMerged(payloadName(keep.item.payload) || "l'élément");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Fusionner les doublons" onClose={close}>
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-[var(--c-text-secondary)]">Celui qui reste :</p>
        <div className="card divide-y divide-[var(--c-border)]" role="radiogroup" aria-label="Celui qui reste">
          {group.map((e) => {
            const p = e.item.payload;
            const user = p.kind === "login" ? p.login.username : "";
            return (
              <label key={e.item.id} className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5">
                <input type="radio" name="keep" checked={keepId === e.item.id} onChange={() => setKeepId(e.item.id)} disabled={busy} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13.5px] font-medium">{payloadName(p) || "(sans nom)"}</span>
                  <span className="truncate text-[12px] text-[var(--c-text-muted)]">{user || "—"} · modifié {formatAgo(e.item.updatedAt)}</span>
                </span>
              </label>
            );
          })}
        </div>
        <ul className="flex flex-col gap-1 text-[12.5px] text-[var(--c-text-secondary)]">
          <li>Son mot de passe reste ; les autres vont dans son historique.</li>
          <li>Adresses, champs, notes, passkeys et pièces jointes s'ajoutent.</li>
          <li>Les autres partent dans la corbeille du vault.</li>
        </ul>
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={close} disabled={busy} className="btn btn-ghost">Annuler</button>
          <button onClick={() => void merge()} disabled={busy} className="btn btn-primary">{busy ? "Fusion…" : `Fusionner ${group.length} éléments`}</button>
        </div>
      </div>
    </Modal>
  );
}
