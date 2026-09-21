import type { VaultIndex } from "../../lib/entities";
import type { ItemKind, Payload } from "../../lib/types";
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

/** Le formulaire qui va avec un type d'item — partagé par l'interface web
 * et le popup de l'extension. */
export function ItemForm({ kind, initial, index, defaultGroupId, onSave, onCancel }: {
  kind: ItemKind;
  initial?: Payload;
  index: VaultIndex;
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

