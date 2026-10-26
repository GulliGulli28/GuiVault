import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errorMessage } from "../lib/api";
import { loginWithPasskey, passkeysSupported } from "../lib/accountPasskeys";
import { loadOfflineCopy, type OfflineCopy } from "../lib/offline";
import { login, openOffline, register, type SessionState } from "../lib/session";
import type { HealthResponse } from "../lib/types";
import { AuthShell } from "./AuthShell";
import { InfoTip, PasswordInput } from "./ui";
import { IconPasskey } from "./secret-icons";
import { t, locale } from "../lib/i18n";

/** Connexion ou inscription, puis le second facteur si le compte en a un —
 * le `ConnectForm` de Guiterm, sans le choix du serveur (c'est celui qui
 * sert cette page). */
/** `extra` : ce que l'app ajoute en pied (revenir à son accueil). */
export function LoginScreen({ onSession, extra }: { onSession: (s: SessionState) => void; extra?: ReactNode }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState<{ verify: (code: string) => Promise<SessionState>; webauthn: boolean; withKey: () => Promise<SessionState> } | null>(null);
  const [code, setCode] = useState("");
  /** Le serveur ne répond pas (page ouverte depuis le cache, erreur réseau,
   * proxy en 5xx) : la copie hors ligne de ce compte, s'il y en a une. */
  const [unreachable, setUnreachable] = useState(false);
  const [offlineCopy, setOfflineCopy] = useState<OfflineCopy | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => { setHealth(null); setUnreachable(true); });
  }, []);
  useEffect(() => {
    const e = email.trim();
    if (!e.includes("@")) { setOfflineCopy(null); return; }
    const t = setTimeout(() => void loadOfflineCopy(e).then(setOfflineCopy), 250);
    return () => clearTimeout(t);
  }, [email]);

  const openCopy = async () => {
    if (!offlineCopy || !password) return;
    setError(null);
    setBusy(t("Ouverture de la copie…"));
    try {
      const { session, warnings } = await openOffline(offlineCopy, password);
      if (warnings.length) setError(warnings.join(" "));
      onSession(session);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const canRegister = health?.registration !== "closed";
  const mismatch = mode === "register" && confirm.length > 0 && confirm !== password;
  const tooShort = mode === "register" && password.length > 0 && password.length < 12;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "register" && (mismatch || tooShort)) return;
    setBusy(mode === "register" ? t("Création des clés…") : t("Dérivation de la clé…"));
    try {
      if (mode === "register") {
        onSession(await register(email, password));
      } else {
        const out = await login(email, password);
        if (out.kind === "ok") onSession(out.session);
        else setTotp({ verify: out.verify, webauthn: out.webauthn, withKey: out.withKey });
      }
    } catch (err) {
      const down = !(err instanceof ApiError) || err.status >= 500;
      if (down) setUnreachable(true);
      setError(down && !(err instanceof ApiError) ? t("Serveur injoignable.") : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Sans mot de passe maître : la passkey signe, sa PRF rouvre le coffre. */
  const withPasskey = async () => {
    setError(null);
    setBusy(t("Passkey…"));
    try {
      onSession(await loginWithPasskey());
    } catch (err) {
      setError(err instanceof DOMException && err.name === "NotAllowedError" ? t("Connexion par passkey annulée, ou aucune passkey de ce coffre sur cet appareil.") : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const submitTotp = async (e: FormEvent) => {
    e.preventDefault();
    if (!totp) return;
    setError(null);
    setBusy(t("Vérification…"));
    try {
      onSession(await totp.verify(code));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // La clé de sécurité, seulement servie par le serveur lui-même : WebAuthn
  // la lie à son origine (l'application et l'extension ont la leur).
  const keyUsable = !!totp?.webauthn && passkeysSupported() && !("__TAURI_INTERNALS__" in window);
  const signWithKey = async () => {
    if (!totp) return;
    setError(null);
    setBusy(t("Clé de sécurité…"));
    try {
      onSession(await totp.withKey());
    } catch (err) {
      setError(err instanceof DOMException && err.name === "NotAllowedError" ? t("Clé de sécurité : annulé, ou refusé par le navigateur.") : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const title = totp ? t("Second facteur") : mode === "register" ? t("Créer un compte") : t("Déverrouiller");
  const sub = totp ? (keyUsable ? t("Le code de votre application, ou votre clé de sécurité.") : t("Le code de votre application d'authentification.")) : mode === "register" ? t("Vos secrets seront chiffrés sur cet appareil.") : t("Vos secrets se déchiffrent ici, sur cet appareil.");

  return (
    <AuthShell
      title={title}
      sub={sub}
      footer={<>
        <span className="inline-flex items-center gap-2"><span className={`dot ${health ? "dot-ok" : unreachable ? "dot-danger" : ""}`} />{health ? t("Serveur joignable · {0}", health.server_version) : unreachable ? t("Serveur injoignable") : t("Serveur…")}</span>
        {extra && <><span className="flex-1" />{extra}</>}
      </>}
    >
      {/* Servie en clair, la page est modifiable par qui est sur le
          chemin : il lui suffit de remplacer ce script pour récupérer
          le mot de passe maître. */}
      {!window.isSecureContext && (
        <div className="callout callout-danger flex items-start gap-2">
          <span className="min-w-0 flex-1">{t("Page servie sans HTTPS : n'y tapez pas votre mot de passe maître.")}</span>
          <InfoTip label={t("Pourquoi, et comment faire")} align="right" items={[
            { text: t("N'importe qui sur le réseau peut remplacer le code de cette page et lire le mot de passe."), tone: "warn" },
            { text: <>{t("Mettez le serveur derrière un reverse proxy TLS (voir")} <span className="font-mono">{t("README.md")}</span>).</> },
            { text: <>{t("Ou ouvrez-le par")} <span className="font-mono">{t("http://localhost")}</span> {t("à travers un tunnel SSH.")}</> },
          ]} />
        </div>
      )}

      {totp ? (
        <form onSubmit={submitTotp} className="flex flex-col gap-4">
          <label className="block">
            <span className="field-label">{t("Code, ou code de récupération")}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" className="input input-mono h-[42px] text-center text-[16px] tracking-[0.2em]" />
          </label>
          {error && <p className="callout callout-danger">{error}</p>}
          <button type="submit" disabled={!code.trim() || busy !== null} className="btn btn-primary btn-lg w-full">{busy ?? t("Valider")}</button>
          {keyUsable && (
            <button type="button" onClick={() => void signWithKey()} disabled={busy !== null} className="btn btn-secondary btn-lg w-full gap-2"><IconPasskey size={16} /> {t("Utiliser une clé de sécurité")}</button>
          )}
          <button type="button" onClick={() => { setTotp(null); setCode(""); setError(null); }} className="btn btn-ghost w-full">{t("Revenir")}</button>
        </form>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="block">
            <span className="field-label">{t("E-mail")}</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" required className="input h-[42px]" />
          </label>
          <label className="block">
            <span className="field-label">{t("Mot de passe maître")}</span>
            <PasswordInput value={password} onChange={setPassword} autoComplete={mode === "register" ? "new-password" : "current-password"} />
            {tooShort && <span className="help-text mt-1.5 block text-[var(--c-warn-text)]">{t("Au moins 12 caractères.")}</span>}
          </label>
          {mode === "register" && (
            <>
              <label className="block">
                <span className="field-label">{t("Confirmer")}</span>
                <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
                {mismatch && <span className="help-text mt-1.5 block text-[var(--c-warn-text)]">{t("Les deux saisies diffèrent.")}</span>}
              </label>
              <div className="callout callout-warn flex items-center gap-2">
                <span className="min-w-0 flex-1">{t("Mot de passe perdu = coffre perdu.")}</span>
                <InfoTip label={t("Pourquoi")} align="right" items={[
                  { text: t("Le serveur ne connaît jamais ce mot de passe."), tone: "ok" },
                  { text: t("Personne ne peut donc le réinitialiser : perdu, vos vaults le sont aussi."), tone: "warn" },
                  ...(health?.registration === "invite_only" ? [{ text: t("Inscription sur invitation : votre adresse doit avoir été invitée ou autorisée.") }] : []),
                ]} />
              </div>
            </>
          )}
          {error && <p className="callout callout-danger">{error}</p>}
          {mode === "login" && unreachable && offlineCopy && (
            <div className="card flex flex-col gap-2.5 p-3.5">
              <p className="text-[13px]"><b className="font-semibold">{t("Serveur injoignable.")}</b> <span className="text-[var(--c-text-muted)]">{t("Copie hors ligne du")} {new Date(offlineCopy.savedAt).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" })}{t(", en lecture seule.")}</span></p>
              <button type="button" onClick={() => void openCopy()} disabled={!password || busy !== null} className="btn btn-secondary w-full">{t("Ouvrir la copie hors ligne")}</button>
            </div>
          )}
          <button type="submit" disabled={!email.trim() || !password || busy !== null} className="btn btn-primary btn-lg w-full text-[14.5px]">
            {busy ?? (mode === "register" ? t("Créer le compte") : t("Déverrouiller"))}
          </button>
          {mode === "login" && health?.passkeys && passkeysSupported() && (
            <>
              <div className="flex items-center gap-3 text-[12.5px] text-[var(--c-text-muted)]"><span className="h-px flex-1 bg-[var(--c-border)]" />{t("ou")}<span className="h-px flex-1 bg-[var(--c-border)]" /></div>
              <button type="button" onClick={() => void withPasskey()} disabled={busy !== null} className="btn btn-secondary btn-lg w-full">
                <IconPasskey size={17} /> {t("Utiliser une passkey")}
              </button>
            </>
          )}
          {canRegister && (
            <p className="text-center text-[13px] text-[var(--c-text-muted)]">
              {mode === "login" ? t("Pas encore de compte ? ") : t("Déjà un compte ? ")}
              <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }} className="font-medium text-[var(--c-accent-text)] hover:underline">
                {mode === "login" ? t("Créer un compte") : t("Se connecter")}
              </button>
            </p>
          )}
        </form>
      )}
    </AuthShell>
  );
}
