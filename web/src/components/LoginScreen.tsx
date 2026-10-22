import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errorMessage } from "../lib/api";
import { loginWithPasskey, passkeysSupported } from "../lib/accountPasskeys";
import { loadOfflineCopy, type OfflineCopy } from "../lib/offline";
import { login, openOffline, register, type SessionState } from "../lib/session";
import type { HealthResponse } from "../lib/types";
import { AuthShell } from "./AuthShell";
import { InfoTip, PasswordInput } from "./ui";
import { IconPasskey } from "./secret-icons";

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
  const [totp, setTotp] = useState<{ verify: (code: string) => Promise<SessionState> } | null>(null);
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
    setBusy("Ouverture de la copie…");
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
    setBusy(mode === "register" ? "Création des clés…" : "Dérivation de la clé…");
    try {
      if (mode === "register") {
        onSession(await register(email, password));
      } else {
        const out = await login(email, password);
        if (out.kind === "ok") onSession(out.session);
        else setTotp({ verify: out.verify });
      }
    } catch (err) {
      const down = !(err instanceof ApiError) || err.status >= 500;
      if (down) setUnreachable(true);
      setError(down && !(err instanceof ApiError) ? "Serveur injoignable." : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  /** Sans mot de passe maître : la passkey signe, sa PRF rouvre le coffre. */
  const withPasskey = async () => {
    setError(null);
    setBusy("Passkey…");
    try {
      onSession(await loginWithPasskey());
    } catch (err) {
      setError(err instanceof DOMException && err.name === "NotAllowedError" ? "Connexion par passkey annulée, ou aucune passkey de ce coffre sur cet appareil." : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const submitTotp = async (e: FormEvent) => {
    e.preventDefault();
    if (!totp) return;
    setError(null);
    setBusy("Vérification…");
    try {
      onSession(await totp.verify(code));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const title = totp ? "Second facteur" : mode === "register" ? "Créer un compte" : "Déverrouiller";
  const sub = totp ? "Le code de votre application d'authentification." : mode === "register" ? "Vos secrets seront chiffrés sur cet appareil." : "Vos secrets se déchiffrent ici, sur cet appareil.";

  return (
    <AuthShell
      title={title}
      sub={sub}
      footer={<>
        <span className="inline-flex items-center gap-2"><span className={`dot ${health ? "dot-ok" : unreachable ? "dot-danger" : ""}`} />{health ? `Serveur joignable · ${health.server_version}` : unreachable ? "Serveur injoignable" : "Serveur…"}</span>
        {extra && <><span className="flex-1" />{extra}</>}
      </>}
    >
      {/* Servie en clair, la page est modifiable par qui est sur le
          chemin : il lui suffit de remplacer ce script pour récupérer
          le mot de passe maître. */}
      {!window.isSecureContext && (
        <div className="callout callout-danger flex items-start gap-2">
          <span className="min-w-0 flex-1">Page servie sans HTTPS : n'y tapez pas votre mot de passe maître.</span>
          <InfoTip label="Pourquoi, et comment faire" align="right" items={[
            { text: "N'importe qui sur le réseau peut remplacer le code de cette page et lire le mot de passe.", tone: "warn" },
            { text: <>Mettez le serveur derrière un reverse proxy TLS (voir <span className="font-mono">README.md</span>).</> },
            { text: <>Ou ouvrez-le par <span className="font-mono">http://localhost</span> à travers un tunnel SSH.</> },
          ]} />
        </div>
      )}

      {totp ? (
        <form onSubmit={submitTotp} className="flex flex-col gap-4">
          <label className="block">
            <span className="field-label">Code, ou code de récupération</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" className="input input-mono h-[42px] text-center text-[16px] tracking-[0.2em]" />
          </label>
          {error && <p className="callout callout-danger">{error}</p>}
          <button type="submit" disabled={!code.trim() || busy !== null} className="btn btn-primary btn-lg w-full">{busy ?? "Valider"}</button>
          <button type="button" onClick={() => { setTotp(null); setCode(""); setError(null); }} className="btn btn-ghost w-full">Revenir</button>
        </form>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="block">
            <span className="field-label">E-mail</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" required className="input h-[42px]" />
          </label>
          <label className="block">
            <span className="field-label">Mot de passe maître</span>
            <PasswordInput value={password} onChange={setPassword} autoComplete={mode === "register" ? "new-password" : "current-password"} />
            {tooShort && <span className="help-text mt-1.5 block text-[var(--c-warn-text)]">Au moins 12 caractères.</span>}
          </label>
          {mode === "register" && (
            <>
              <label className="block">
                <span className="field-label">Confirmer</span>
                <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
                {mismatch && <span className="help-text mt-1.5 block text-[var(--c-warn-text)]">Les deux saisies diffèrent.</span>}
              </label>
              <div className="callout callout-warn flex items-center gap-2">
                <span className="min-w-0 flex-1">Mot de passe perdu = coffre perdu.</span>
                <InfoTip label="Pourquoi" align="right" items={[
                  { text: "Le serveur ne connaît jamais ce mot de passe.", tone: "ok" },
                  { text: "Personne ne peut donc le réinitialiser : perdu, vos vaults le sont aussi.", tone: "warn" },
                  ...(health?.registration === "invite_only" ? [{ text: "Inscription sur invitation : votre adresse doit avoir été invitée ou autorisée." }] : []),
                ]} />
              </div>
            </>
          )}
          {error && <p className="callout callout-danger">{error}</p>}
          {mode === "login" && unreachable && offlineCopy && (
            <div className="card flex flex-col gap-2.5 p-3.5">
              <p className="text-[13px]"><b className="font-semibold">Serveur injoignable.</b> <span className="text-[var(--c-text-muted)]">Copie hors ligne du {new Date(offlineCopy.savedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}, en lecture seule.</span></p>
              <button type="button" onClick={() => void openCopy()} disabled={!password || busy !== null} className="btn btn-secondary w-full">Ouvrir la copie hors ligne</button>
            </div>
          )}
          <button type="submit" disabled={!email.trim() || !password || busy !== null} className="btn btn-primary btn-lg w-full text-[14.5px]">
            {busy ?? (mode === "register" ? "Créer le compte" : "Déverrouiller")}
          </button>
          {mode === "login" && health?.passkeys && passkeysSupported() && (
            <>
              <div className="flex items-center gap-3 text-[12.5px] text-[var(--c-text-muted)]"><span className="h-px flex-1 bg-[var(--c-border)]" />ou<span className="h-px flex-1 bg-[var(--c-border)]" /></div>
              <button type="button" onClick={() => void withPasskey()} disabled={busy !== null} className="btn btn-secondary btn-lg w-full">
                <IconPasskey size={17} /> Utiliser une passkey
              </button>
            </>
          )}
          {canRegister && (
            <p className="text-center text-[13px] text-[var(--c-text-muted)]">
              {mode === "login" ? "Pas encore de compte ? " : "Déjà un compte ? "}
              <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }} className="font-medium text-[var(--c-accent-text)] hover:underline">
                {mode === "login" ? "Créer un compte" : "Se connecter"}
              </button>
            </p>
          )}
        </form>
      )}
    </AuthShell>
  );
}
