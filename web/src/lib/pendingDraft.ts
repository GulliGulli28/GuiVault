/** Un formulaire à ouvrir pré-rempli, demandé hors de la page du vault
 * (« Enregistrer dans GuiVault ? » d'Android, `autofillSave.ts`) : la page
 * du vault le prend en arrivant, ou tout de suite si elle est déjà ouverte.
 * En mémoire seulement. */
import { useSyncExternalStore } from "react";
import type { Payload } from "./types";

export interface PendingDraft {
  vaultId: string;
  /** L'élément à modifier ; absent : un nouvel élément. */
  itemId?: string;
  draft: Payload;
}

let pending: PendingDraft | null = null;
const listeners = new Set<() => void>();

export function requestDraft(p: PendingDraft) {
  pending = p;
  for (const l of listeners) l();
}

/** Le brouillon demandé pour ce vault, retiré. */
export function takeDraft(vaultId: string): PendingDraft | null {
  if (pending?.vaultId !== vaultId) return null;
  const p = pending;
  pending = null;
  return p;
}

/** Change quand un brouillon est demandé. */
export function usePendingDraft(): PendingDraft | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => pending,
  );
}
