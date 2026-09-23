import { useMemo, useRef } from "react";
import type { VaultIndex } from "../../lib/entities";
import { payloadEntity } from "../../lib/session";
import type { CustomIcon, ItemKind, Payload } from "../../lib/types";
import { HostForm } from "./HostForm";
import { GroupForm } from "./GroupForm";
import { SnippetForm } from "./SnippetForm";
import { KeyForm } from "./KeyForm";
import { SqlConnectionForm } from "./SqlConnectionForm";
import { IconForm } from "./IconForm";
import { LoginForm } from "./LoginForm";
import { NoteForm } from "./NoteForm";
import { CardForm } from "./CardForm";
import { IdentityForm } from "./IdentityForm";
import { AwsForm } from "./AwsForm";
import { ApiKeyForm } from "./ApiKeyForm";
import { RunbookForm } from "./RunbookForm";
import { DraftContext, type DraftContextValue } from "./common";

/** Le formulaire qui va avec un type d'item — partagé par l'interface web
 * et le popup de l'extension. */
export function ItemForm({ kind, initial, draft, onDraft, index, defaultGroupId, onSave: save, onCancel, onAddIcon }: {
  kind: ItemKind;
  initial?: Payload;
  index: VaultIndex;
  defaultGroupId?: string | null;
  onSave: (p: Payload) => Promise<void>;
  onCancel: () => void;
  /** Enregistrer une icône importée depuis le sélecteur d'icône d'un hôte
   * ou d'un dossier — un item `icon` de plus dans le vault. */
  onAddIcon?: (icon: CustomIcon) => Promise<void>;
  /** Un brouillon à reprendre (du même type), et où envoyer le suivant —
   * voir `DraftContext`. */
  draft?: Payload;
  onDraft?: (p: Payload) => void;
}) {
  const capturing = useRef(false);
  const last = useRef<string | null>(null);
  // Un nouvel élément reçoit un id neuf à chaque construction : le brouillon
  // garde le premier, sinon il changerait à chaque fois.
  const draftId = useRef<string | null>(draft?.kind === kind ? payloadEntity(draft).id : null);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const onSave = (p: Payload): Promise<void> => {
    if (!capturing.current) return save(p);
    if (!initial) {
      const e = payloadEntity(p);
      draftId.current ??= e.id;
      e.id = draftId.current;
    }
    const json = JSON.stringify(p);
    if (json !== last.current) {
      last.current = json;
      onDraftRef.current?.(p);
    }
    return Promise.resolve();
  };
  const ctx = useMemo<DraftContextValue>(() => ({
    draft: draft?.kind === kind ? draft : undefined,
    snapshot: onDraft ? (build) => {
      capturing.current = true;
      try {
        build().catch(() => {});
      } finally {
        capturing.current = false;
      }
    } : undefined,
  }), [draft, kind, !!onDraft]); // eslint-disable-line react-hooks/exhaustive-deps
  return <DraftContext.Provider value={ctx}>{form(kind, initial, index, defaultGroupId, onSave, onCancel, onAddIcon)}</DraftContext.Provider>;
}

function form(kind: ItemKind, initial: Payload | undefined, index: VaultIndex, defaultGroupId: string | null | undefined, onSave: (p: Payload) => Promise<void>, onCancel: () => void, onAddIcon?: (icon: CustomIcon) => Promise<void>) {
  switch (kind) {
    case "host":
      return <HostForm initial={initial?.kind === "host" ? initial : undefined} index={index} defaultGroupId={defaultGroupId} onSave={onSave} onCancel={onCancel} onAddIcon={onAddIcon} />;
    case "group":
      return <GroupForm initial={initial?.kind === "group" ? initial.group : undefined} index={index} defaultParentId={defaultGroupId} onSave={onSave} onCancel={onCancel} onAddIcon={onAddIcon} />;
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
    case "aws":
      return <AwsForm initial={initial?.kind === "aws" ? initial.aws : undefined} index={index} defaultGroupId={defaultGroupId} onSave={onSave} onCancel={onCancel} />;
    case "api-key":
      return <ApiKeyForm initial={initial?.kind === "api-key" ? initial.apiKey : undefined} index={index} defaultGroupId={defaultGroupId} onSave={onSave} onCancel={onCancel} />;
    case "runbook":
      return <RunbookForm initial={initial?.kind === "runbook" ? initial.runbook : undefined} index={index} onSave={onSave} onCancel={onCancel} />;
  }
}

