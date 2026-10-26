/** Copier un coffre local vers un serveur, ou un compte dans un coffre local
 * (`lib/transfer.ts`, `docs/TRANSFERT.md`). Seulement dans l'application
 * (`coffreBridge`) : le sens dépend de la session — un coffre local part vers
 * un serveur, un compte vers un coffre. La source n'est jamais modifiée. */
import { useCallback, useRef, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { coffreName } from "../lib/localHost";
import { coffreBridge } from "../lib/platform";
import { connectAccount, copyToCoffre, copyToNewCoffre, copyVaults, createAccountFrom, transferVaults, type AccountDestination, type TransferProgress, type VaultReport } from "../lib/transfer";
import { Modal, PasswordInput } from "./ui";
import { t, plural } from "../lib/i18n";

type Phase = "form" | "totp" | "running" | "done";

export function TransferDialog({ ctx, onClose }: { ctx: PageContext; onClose: () => void }) {
  const { session } = ctx;
  const bridge = coffreBridge();
  const local = session.local;
  const toServer = !!local;
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(session.vaults.filter((v) => toServer || v.role === "owner").map((v) => v.id)));
  const [url, setUrl] = useState(() => bridge?.lastServer() ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [verify, setVerify] = useState<((code: string) => Promise<AccountDestination>) | null>(null);
  const [phase, setPhase] = useState<Phase>("form");
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [reports, setReports] = useState<VaultReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busy = phase === "running";
  // Stable pour `useModalSurface` : pas de fermeture en pleine copie.
  const busyRef = useRef(false);
  busyRef.current = busy;
  const close = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  if (!bridge) return null;
  const personal = session.vaults.find((v) => v.kind === "personal");
  // Un compte ou un coffre neuf naît avec le vault personnel de la source.
  const forced = (id: string) => mode === "new" && id === personal?.id;
  const chosen = () => transferVaults(session, session.vaults.filter((v) => selected.has(v.id) || forced(v.id)).map((v) => v.id));
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const run = async (work: () => Promise<VaultReport[]>) => {
    setPhase("running");
    setError(null);
    try {
      setReports(await work());
      setPhase("done");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("form");
    }
  };
  const toAccount = (dest: AccountDestination) => run(async () => {
    try {
      return await copyVaults(api, dest, chosen(), setProgress);
    } finally {
      await dest.close();
    }
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (toServer) {
      if (!/^https?:\/\//i.test(url.trim())) { setError(t("L'adresse du serveur commence par https://")); return; }
      if (mode === "new") {
        await run(async () => {
          const dest = await createAccountFrom(session, api, url, email, password);
          try {
            return await copyVaults(api, dest, chosen(), setProgress);
          } finally {
            await dest.close();
          }
        });
        return;
      }
      setPhase("running");
      try {
        const out = await connectAccount(url, email, password, t("Personnel ({0})", coffreName(local.path)));
        if (out.kind === "totp") {
          setVerify(() => out.verify);
          setPhase("totp");
          return;
        }
        await toAccount(out.dest);
      } catch (err) {
        setError(errorMessage(err));
        setPhase("form");
      }
      return;
    }
    if (!path) { setError(t("Choisissez d'abord le dossier du coffre.")); return; }
    await run(async () => {
      const res = mode === "new"
        ? await copyToNewCoffre(session, api, bridge.host, path, password, chosen(), setProgress)
        : await copyToCoffre(api, bridge.host, path, password, t("Personnel ({0})", session.user.email), chosen(), setProgress);
      bridge.remember(path);
      return res;
    });
  };

  const submitTotp = async (e: FormEvent) => {
    e.preventDefault();
    if (!verify) return;
    setPhase("running");
    try {
      await toAccount(await verify(code));
    } catch (err) {
      setError(errorMessage(err));
      setPhase("totp");
    }
  };

  const pick = async () => {
    const p = await (mode === "new" ? bridge.pickNew() : bridge.pickExisting()).catch(() => null);
    if (p) setPath(p);
  };

  const title = toServer ? t("Copier vers un serveur") : t("Copier dans un coffre local");
  if (phase === "done") {
    const failed = reports.some((r) => r.error);
    return (
      <Modal title={title} onClose={close} wide>
        <div className="space-y-3">
          <ul className="space-y-1">
            {reports.map((r) => (
              <li key={r.id} className="card p-2.5 text-[12.5px] text-[var(--c-text)]">
                <span className="font-medium">{r.name}</span>{r.resumed && <span className="tag ml-1.5">{t("complété")}</span>}
                {r.error
                  ? <p className="text-[11.5px] text-[var(--c-danger)]">{r.error}</p>
                  : <p className="text-[11.5px] text-[var(--c-text-muted)]">{summary(r)}</p>}
              </li>
            ))}
          </ul>
          {failed && <p className="callout callout-warn">{t("Relancez la copie : ce qui est déjà arrivé ne repart pas.")}</p>}
          <p className="help-text">
            {toServer
              ? t("La copie est faite ; ce coffre n'a pas changé. Pour ouvrir le compte, fermez le coffre et connectez-vous depuis l'accueil.")
              : t("Le coffre « {0} » est dans les coffres récents de l'accueil. Ce compte n'a pas changé.", coffreName(path ?? ""))}
          </p>
          <div className="flex justify-end"><button onClick={onClose} className="btn btn-primary">{t("Fermer")}</button></div>
        </div>
      </Modal>
    );
  }

  if (phase === "totp") {
    return (
      <Modal title={title} onClose={close}>
        <form onSubmit={submitTotp} className="space-y-3">
          <label className="block"><span className="field-label">{t("Code de second facteur")}</span><input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" className="input" /></label>
          {error && <p className="callout callout-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn btn-ghost">{t("Annuler")}</button>
            <button type="submit" disabled={!code} className="btn btn-primary">{t("Continuer")}</button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={close} wide>
      <form onSubmit={submit} className="space-y-3">
        <div role="radiogroup" aria-label={t("Destination")} className="flex flex-wrap gap-x-4 gap-y-1">
          {(["new", "existing"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2 text-[12.5px] text-[var(--c-text)]">
              <input type="radio" name="transfer-mode" checked={mode === m} disabled={busy} onChange={() => { setMode(m); setPath(null); }} />
              {toServer ? (m === "new" ? t("Créer un compte") : t("Compte existant")) : (m === "new" ? t("Nouveau coffre") : t("Coffre existant"))}
            </label>
          ))}
        </div>

        {toServer ? (
          <>
            <label className="block"><span className="field-label">{t("Serveur")}</span><input value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} placeholder="https://vault.example.org" className="input" /></label>
            <label className="block"><span className="field-label">{t("E-mail")}</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} autoComplete="username" className="input" /></label>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <button type="button" onClick={pick} disabled={busy} className="btn btn-secondary btn-sm">{mode === "new" ? t("Créer le coffre…") : t("Choisir le coffre…")}</button>
            <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-[var(--c-text-muted)]">{path ?? t("aucun dossier choisi")}</span>
          </div>
        )}
        <label className="block"><span className="field-label">{passwordLabel(toServer, mode)}</span><PasswordInput value={password} onChange={setPassword} autoComplete="current-password" /></label>
        <p className="help-text">{passwordHelp(toServer, mode)}</p>

        <fieldset className="space-y-1">
          <legend className="field-label">{t("Vaults à copier")}</legend>
          <div className="card divide-y divide-[var(--c-border)]">
            {session.vaults.map((v) => (
              <label key={v.id} className="flex items-start gap-2 p-2.5">
                <input type="checkbox" checked={selected.has(v.id) || forced(v.id)} disabled={busy || forced(v.id)} onChange={() => toggle(v.id)} className="mt-0.5" />
                <span className="min-w-0 flex-1 text-[12.5px] text-[var(--c-text)]">
                  {v.name}
                  {v.role !== "owner" && <span className="block text-[11px] text-[var(--c-text-muted)]">{t("Partagé avec vous : la copie sera à vous seul, sans les autres membres.")}</span>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="help-text">{t("Tout part chiffré, historique et pièces jointes compris.")} {toServer ? t("Ce coffre") : t("Ce compte")} {t("ne change pas.")}</p>

        {busy && <p className="callout" role="status">{progress ? progressText(progress) : toServer && mode === "new" ? t("Création du compte…") : t("Connexion…")}</p>}
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost">{t("Annuler")}</button>
          <button type="submit" disabled={busy || !password || (toServer ? !url || !email : !path)} className="btn btn-primary">{busy ? t("Copie…") : t("Copier")}</button>
        </div>
      </form>
    </Modal>
  );
}

function passwordLabel(toServer: boolean, mode: "new" | "existing"): string {
  if (toServer) return mode === "new" ? t("Mot de passe maître de ce coffre") : t("Mot de passe maître du compte");
  return mode === "new" ? t("Mot de passe maître de ce compte") : t("Mot de passe maître du coffre");
}

function passwordHelp(toServer: boolean, mode: "new" | "existing"): string {
  if (toServer) return mode === "new"
    ? t("Le compte naît avec le compte de ce coffre : même mot de passe maître (à changer ensuite si vous voulez), mêmes clés — rien n'est re-chiffré.")
    : t("Les clés des vaults sont enveloppées pour ce compte ; le vault personnel du coffre y devient un vault ordinaire.");
  return mode === "new"
    ? t("Le coffre naît avec le compte : même mot de passe maître, mêmes clés.")
    : t("Les clés des vaults sont enveloppées pour le compte du coffre ; votre vault personnel y devient un vault ordinaire.");
}

function progressText(p: TransferProgress): string {
  return p.step === "items" ? t("{0} : éléments {1}/{2}", p.vault, p.done, p.total) : t("{0} : pièces jointes {1}/{2}", p.vault, p.done, p.total);
}

function summary(r: VaultReport): string {
  const parts = [t("{0} élément{1}{2}", r.items, r.items > 1 ? "s" : "", r.trashed ? t(" (dont {0} à la corbeille)", r.trashed) : ""), t("{0} version{1} précédente{2}", r.versions, r.versions > 1 ? "s" : "", r.versions > 1 ? "s" : "")];
  if (r.attachments) parts.push(plural(r.attachments, "{0} pièce jointe", "{0} pièces jointes"));
  let s = parts.join(", ");
  if (r.skippedAttachments) s += plural(r.skippedAttachments, " — {0} pièce jointe d'éléments à la corbeille non copiée", " — {0} pièces jointes d'éléments à la corbeille non copiées");
  return s;
}
