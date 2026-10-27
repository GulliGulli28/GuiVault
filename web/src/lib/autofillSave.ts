/** « Enregistrer dans GuiVault ? » (remplissage Android,
 * `docs/REMPLISSAGE.md`) : que faire d'une connexion tapée à la main ailleurs.
 * Pur : la page du vault ouvre ensuite le formulaire pré-rempli
 * (`pendingDraft.ts`). */
import type { VaultItem } from "./allItems";
import { emptyPayload, uriHost } from "./items";
import type { CapturedLogin } from "./platform";
import { canWrite, type Payload, type Role } from "./types";

export type SavePlan =
  /** Déjà là, même mot de passe : rien à faire. */
  | { kind: "same"; item: VaultItem }
  /** Le même compte (site et utilisateur), un autre mot de passe : le mettre
   * à jour — l'ancien passe dans son historique. */
  | { kind: "update"; item: VaultItem; draft: Payload }
  /** Un nouvel identifiant, dans `vaultId`. */
  | { kind: "new"; vaultId: string; draft: Payload };

const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** L'adresse que l'identifiant gardera : le site, sinon l'application. */
export function capturedUri(c: CapturedLogin): string {
  return c.domain ? `https://${c.domain}` : `androidapp://${c.pkg}`;
}

/** L'identifiant vise-t-il ce site ou cette application ? */
function sameTarget(uris: { uri: string }[], c: CapturedLogin): boolean {
  if (c.domain) return uris.some((u) => !u.uri.startsWith("androidapp://") && bare(uriHost(u.uri)) === bare(c.domain!));
  return uris.some((u) => u.uri === `androidapp://${c.pkg}`);
}

/** `vaults` : ceux de la session (un vault personnel encore vide n'a pas
 * d'éléments mais reste le bon endroit). */
export function planSave(items: VaultItem[], vaults: { id: string; kind: string; role: Role; emergency?: unknown }[], c: CapturedLogin): SavePlan | null {
  const writable = items.filter((v) => !v.vault.emergency && canWrite(v.vault.role));
  const user = c.username.trim().toLowerCase();
  const same = writable.find((v) => {
    const p = v.item.payload;
    return p.kind === "login" && p.login.username.trim().toLowerCase() === user && sameTarget(p.login.uris, c);
  });
  if (same) {
    const p = same.item.payload as Extract<Payload, { kind: "login" }>;
    if (p.login.password === c.password) return { kind: "same", item: same };
    return { kind: "update", item: same, draft: { ...p, login: { ...p.login, password: c.password } } };
  }
  const open = vaults.filter((v) => !v.emergency && canWrite(v.role));
  const target = open.find((v) => v.kind === "personal") ?? open[0];
  if (!target) return null;
  const draft = emptyPayload("login") as Extract<Payload, { kind: "login" }>;
  draft.login.name = c.label || c.domain || c.pkg;
  draft.login.username = c.username;
  draft.login.password = c.password;
  draft.login.uris = [{ uri: capturedUri(c) }];
  return { kind: "new", vaultId: target.id, draft };
}
