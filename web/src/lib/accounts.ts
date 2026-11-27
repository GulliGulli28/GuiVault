/** Les comptes enregistrés (`Account`, type `account`) : un identifiant ou
 * un hôte du même vault s'y relie par `accountId` et en garde une **copie**
 * de l'utilisateur et du mot de passe. Une copie plutôt qu'une référence :
 * Guiterm, l'extension, Android, `gv` et la saisie automatique lisent
 * l'identifiant ou l'hôte comme avant, sans connaître les comptes. Changer
 * le compte réécrit les copies (`syncLinked`) ; une copie restée en
 * arrière (écriture ratée, autre appareil) se voit (`staleLink`) et se
 * rattrape depuis la fiche. Pur sauf `syncLinked` ; testé
 * (`accounts.test.ts`). */
import { runBulk, type BulkResult } from "./bulk";
import { changeItem, payloadName, type DecodedItem, type VaultView } from "./session";
import type { Account, AuthMethod, Payload } from "./types";

type Ok = DecodedItem & { ok: true };

/** Les types qui peuvent reprendre un compte. */
export function canLink(p: Payload): boolean {
  if (p.kind === "login") return true;
  // Un hôte Docker ou Kubernetes n'a pas d'utilisateur à lui (le champ est
  // un namespace) : seuls SSH et RDP.
  return p.kind === "host" && (p.host.kind ?? "ssh") !== "dockerExec" && (p.host.kind ?? "ssh") !== "k8sExec";
}

/** Le compte que reprend un élément, s'il en reprend un. */
export function linkedAccountId(p: Payload): string | null {
  if (p.kind === "login") return p.login.accountId || null;
  if (p.kind === "host") return typeof p.host.accountId === "string" && p.host.accountId ? p.host.accountId : null;
  return null;
}

/** Un hôte ne garde le mot de passe que s'il s'en sert. */
function hostUsesPassword(auth: AuthMethod): boolean {
  return auth === "password";
}

/** L'élément relié à `account` avec la copie à jour ; `null` s'il l'était
 * déjà (rien à écrire). Un compte protégé (`reprompt`) protège ce qui le
 * reprend : la copie y donne le même mot de passe. */
export function withAccount(p: Payload, account: Account): Payload | null {
  const reprompt = account.reprompt ? true : undefined;
  if (p.kind === "login") {
    const l = p.login;
    const next = { ...l, accountId: account.id, username: account.username, password: account.password, ...(reprompt && { reprompt }) };
    if (l.accountId === next.accountId && l.username === next.username && l.password === next.password && (l.reprompt ?? undefined) === (next.reprompt ?? undefined)) return null;
    return { ...p, login: next };
  }
  if (p.kind === "host") {
    const h = p.host;
    const secrets = { ...(p.secrets ?? {}) };
    if (hostUsesPassword(h.auth)) secrets.password = account.password;
    const next = { ...h, accountId: account.id, username: account.username };
    if (h.accountId === account.id && h.username === next.username && (p.secrets?.password ?? undefined) === (secrets.password ?? undefined)) return null;
    return { ...p, host: next, secrets };
  }
  return null;
}

/** L'élément détaché de son compte : il garde la dernière copie, qui
 * redevient la sienne. */
export function withoutAccount(p: Payload): Payload {
  if (p.kind === "login") {
    const { accountId: _, ...login } = p.login;
    return { ...p, login };
  }
  if (p.kind === "host") {
    const { accountId: _, ...host } = p.host;
    return { ...p, host };
  }
  return p;
}

export type LinkState =
  | { kind: "none" }
  /** Le compte du lien, et si la copie de l'élément en est restée en arrière. */
  | { kind: "linked"; account: Account; stale: boolean }
  /** Le compte n'est plus dans ce vault (supprimé, déplacé) : l'élément
   * garde sa dernière copie. */
  | { kind: "missing" };

export function linkState(p: Payload, accounts: Map<string, Account> | Account[]): LinkState {
  const id = linkedAccountId(p);
  if (!id) return { kind: "none" };
  const account = accounts instanceof Map ? accounts.get(id) : accounts.find((a) => a.id === id);
  if (!account) return { kind: "missing" };
  return { kind: "linked", account, stale: withAccount(p, account) !== null };
}

/** Les éléments du vault qui reprennent ce compte. */
export function linkedItems(items: readonly DecodedItem[], accountId: string): Ok[] {
  return items.filter((i): i is Ok => i.ok && linkedAccountId(i.payload) === accountId);
}

/** Réécrit les copies restées en arrière de ce compte, une écriture après
 * l'autre ; ce qui était à jour compte dans `skipped`. */
export async function syncLinked(vault: VaultView, account: Account, items: readonly DecodedItem[]): Promise<BulkResult> {
  return runBulk(linkedItems(items, account.id), (i) => payloadName(i.payload), async (i) =>
    // Rejouée sur la version du serveur si l'élément a changé entre-temps,
    // et plus rien à faire s'il a été détaché du compte.
    !!(await changeItem(vault, i, (p) => (linkedAccountId(p) === account.id ? withAccount(p, account) : null))),
  );
}
