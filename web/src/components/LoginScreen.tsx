import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage } from "../lib/api";
import { loginWithPasskey, passkeysSupported } from "../lib/accountPasskeys";
import { loadOfflineCopy, type OfflineCopy } from "../lib/offline";
import { login, openOffline, register, type SessionState } from "../lib/session";
import type { HealthResponse } from "../lib/types";
import { Logo } from "./Logo";
import { InfoTip, PasswordInput } from "./ui";
import { IconPasskey } from "./secret-icons";
import { IconHosts, IconMonitor } from "./ui-icons";

/** Connexion ou inscription, puis le second facteur si le compte en a un —
 * le `ConnectForm` de Guiterm, sans le choix du serveur (c'est celui qui
 * sert cette page). */
export function LoginScreen({ onSession }: { onSession: (s: SessionState) => void }) {
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
    <div className="flex min-h-full flex-wrap bg-[var(--c-bg2)]">
      <section className="flex min-h-[100dvh] min-w-0 flex-[1_1_480px] flex-col px-8 py-7 max-sm:px-5">
        <div className="flex items-center gap-2.5">
          {/* Gris tant qu'on n'est pas connecté — comme l'icône de l'extension. */}
          <Logo size={28} locked />
          <span className="text-[16px] font-semibold">GuiVault</span>
        </div>

        <div className="flex flex-1 items-center justify-center py-10">
          <div className="flex w-full max-w-[380px] flex-col gap-5">
            <div>
              <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.025em]">{title}</h1>
              <p className="page-sub">{sub}</p>
            </div>

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
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-[var(--c-text-muted)]">
          <span className="inline-flex items-center gap-2"><span className={`dot ${health ? "dot-ok" : unreachable ? "dot-danger" : ""}`} />{health ? `Serveur joignable · ${health.server_version}` : unreachable ? "Serveur injoignable" : "Serveur…"}</span>
        </div>
      </section>

      {/* Ce que voit qui : l'explication, en schéma. */}
      <section aria-label="Ce que voit le serveur" className="flex min-w-0 flex-[1_1_480px] items-center justify-center border-l border-[var(--c-border)] bg-[var(--c-bg)] px-8 py-12 [background-image:radial-gradient(var(--c-border)_1px,transparent_1px)] [background-size:20px_20px] max-[1000px]:hidden">
        <div className="flex w-full max-w-[500px] flex-col gap-3.5">
          <div className="card flex flex-col gap-3 border-[var(--c-border-strong)] p-5">
            <span className="flex items-center gap-2 text-[13px] text-[var(--c-text-muted)]"><IconMonitor size={15} /> Cet appareil</span>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13.5px]">
              <span className="text-[var(--c-text-muted)]">Site</span><span className="truncate font-mono">github.com</span>
              <span className="text-[var(--c-text-muted)]">Utilisateur</span><span className="truncate font-mono">alice</span>
              <span className="text-[var(--c-text-muted)]">Mot de passe</span><span className="truncate font-mono">Tr0ub4dor&amp;3xyz!</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-[12.5px] text-[var(--c-text-muted)]">
            <svg width="14" height="34" viewBox="0 0 14 34" aria-hidden="true"><path d="M7 0v28M2 23l5 6 5-6" fill="none" stroke="var(--c-accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="font-mono text-[var(--c-accent-text)]">XChaCha20-Poly1305</span><span>clé dérivée du mot de passe maître</span>
          </div>
          <div className="flex flex-col gap-3 rounded-[14px] border border-dashed border-[var(--c-border-strong)] bg-[var(--c-bg2)] p-5">
            <span className="flex items-center gap-2 text-[13px] text-[var(--c-text-muted)]"><IconHosts size={15} /> Le serveur</span>
            <p className="break-all font-mono text-[12.5px] leading-relaxed text-[var(--c-text-faint)]">AQ8f3c1e9b47a0d2ef55c9a1b7e04f8d6c3a2b9e7f10d4c6a8b2e5f7a9c1d3e5f70b2d4f6a8c0e2f4b6d8a0c2e4f6a8b0d2c4e6f8a1b3d5f7e9c1a3b5d7f9e2c4</p>
            <span className="text-[13px] text-[var(--c-text-secondary)]">Ne garde que ceci : ni mot de passe, ni clé.</span>
          </div>
        </div>
      </section>
    </div>
  );
}
