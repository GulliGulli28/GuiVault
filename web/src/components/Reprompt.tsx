/** La question « mot de passe maître » d'un élément protégé
 * (`lib/reprompt.ts`) : `RepromptProvider` autour des pages (et du popup de
 * l'extension), `useReprompt()` là où un secret s'affiche, se copie, se
 * remplit ou se modifie. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../lib/api";
import { forgetUnlocked, markUnlocked, needsReprompt, verifyMasterPassword } from "../lib/reprompt";
import { payloadEntity, type SessionState } from "../lib/session";
import type { Payload } from "../lib/types";
import { Modal, PasswordInput } from "./ui";
import { IconLock } from "./ui-icons";
import { t } from "../lib/i18n";

type Ask = (payload: Payload | null | undefined) => Promise<boolean>;

// Sans fournisseur (une page isolée, un test) : rien n'est protégé.
export const RepromptContext = createContext<Ask>(async () => true);

/** `true` si l'on peut continuer : élément non protégé, déverrouillé il y a
 * peu, ou mot de passe maître donné à l'instant. */
export function useReprompt(): Ask {
  return useContext(RepromptContext);
}

interface Pending {
  name: string;
  id: string;
  resolve: (ok: boolean) => void;
}

/** La question et de quoi la poser, pour qui détient la session (`App`, le
 * popup de l'extension) : `ask`, et l'élément à rendre. À donner ensuite à
 * `RepromptContext` pour les composants en dessous. */
export function useRepromptHost(session: SessionState | null): [Ask, ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);
  const queue = useRef<Pending | null>(null);
  // Une autre session (verrouillage, autre compte) : on oublie tout.
  useEffect(() => () => forgetUnlocked(), [session]);
  const ask = useCallback<Ask>(async (payload) => {
    if (!needsReprompt(payload)) return true;
    const e = payloadEntity(payload!);
    // Une seule question à la fois : une seconde demande remplace la première.
    if (queue.current) queue.current.resolve(false);
    return new Promise<boolean>((resolve) => {
      const p = { name: typeof e.name === "string" && e.name ? e.name : t("Cet élément"), id: e.id, resolve };
      queue.current = p;
      setPending(p);
    });
  }, []);
  const close = useCallback((ok: boolean) => {
    setPending((p) => {
      if (p) {
        if (ok) markUnlocked(p.id);
        p.resolve(ok);
      }
      queue.current = null;
      return null;
    });
  }, []);
  const dialog = pending && session ? <RepromptDialog key={pending.id} session={session} name={pending.name} onDone={close} /> : null;
  return [ask, dialog];
}

export function RepromptProvider({ session, children }: { session: SessionState; children: ReactNode }) {
  const [ask, dialog] = useRepromptHost(session);
  return (
    <RepromptContext.Provider value={ask}>
      {children}
      {dialog}
    </RepromptContext.Provider>
  );
}

function RepromptDialog({ session, name, onDone }: { session: SessionState; name: string; onDone: (ok: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useCallback(() => onDone(false), [onDone]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await verifyMasterPassword(session, password);
      if (r === "ok") return onDone(true);
      setError(r === "wrong" ? t("Mot de passe maître incorrect.") : t("Cette session ne peut pas vérifier le mot de passe (ouverte par passkey) : reconnectez-vous avec le mot de passe maître."));
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };
  return (
    <Modal title={t("Élément protégé")} onClose={cancel}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="truncate text-[13px] text-[var(--c-text-secondary)]">« {name} {t("» demande le mot de passe maître.")}</p>
        <label className="block">
          <span className="field-label">{t("Mot de passe maître")}</span>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
        </label>
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={cancel} className="btn btn-ghost">{t("Annuler")}</button>
          <button type="submit" disabled={!password || busy} className="btn btn-primary">{busy ? t("Vérification…") : t("Déverrouiller")}</button>
        </div>
      </form>
    </Modal>
  );
}

/** `children` (un code 2FA, un secret) seulement une fois l'élément
 * déverrouillé ; avant, un bouton qui pose la question. */
export function Guarded({ payload, children }: { payload: Payload; children: ReactNode }) {
  const ask = useReprompt();
  const [, setUnlocks] = useState(0);
  if (!needsReprompt(payload)) return <>{children}</>;
  return (
    <button type="button" onClick={() => void ask(payload).then((ok) => ok && setUnlocks((n) => n + 1))} className="btn btn-ghost btn-sm gap-1.5 text-[var(--c-text-muted)]" title={t("Protégé par le mot de passe maître")}>
      <IconLock size={13} /> {t("Afficher")}
    </button>
  );
}
