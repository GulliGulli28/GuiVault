import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import { login, register, type SessionState } from "../lib/session";
import type { HealthResponse } from "../lib/types";
import { Logo } from "./Logo";
import { PasswordInput } from "./ui";

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

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

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
      setError(errorMessage(err));
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

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-3 text-[var(--c-text)]">
          {/* Gris tant qu'on n'est pas connecté — comme l'icône de l'extension. */}
          <Logo size={44} locked />
          <div>
            <h1 className="text-[15px] font-semibold leading-tight">GuiVault</h1>
            <p className="text-[11.5px] text-[var(--c-text-muted)]">Coffre chiffré de bout en bout de Guiterm</p>
          </div>
        </div>

        {/* Servie en clair, la page est modifiable par qui est sur le chemin :
            il lui suffit de remplacer ce script pour récupérer le mot de
            passe maître. Le chiffrement de bout en bout ne protège de rien
            si le code qui chiffre n'est pas celui qu'on croit. */}
        {!window.isSecureContext && (
          <p className="callout callout-danger mb-3">
            Cette page n'est pas servie en HTTPS. N'y saisissez pas votre mot de passe maître :
            n'importe qui sur le réseau peut remplacer le code de cette page et le lire.
            Mettez le serveur derrière un reverse proxy TLS (voir <span className="font-mono">README.md</span>),
            ou ouvrez-le par <span className="font-mono">http://localhost</span> à travers un tunnel SSH.
          </p>
        )}

        {totp ? (
          <form onSubmit={submitTotp} className="card space-y-3 p-4">
            <p className="text-[12.5px] text-[var(--c-text-secondary)]">Ce compte a un second facteur. Saisissez le code de votre application d'authentification, ou un code de récupération.</p>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" className="input input-mono text-center tracking-[0.2em]" />
            {error && <p className="callout callout-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setTotp(null); setCode(""); setError(null); }} className="btn btn-ghost">Annuler</button>
              <button type="submit" disabled={!code.trim() || busy !== null} className="btn btn-primary">{busy ?? "Valider"}</button>
            </div>
          </form>
        ) : (
          <form onSubmit={submit} className="card space-y-3 p-4">
            {canRegister && (
              <div className="segmented w-full">
                <button type="button" data-active={mode === "login"} onClick={() => setMode("login")} className="flex-1">Connexion</button>
                <button type="button" data-active={mode === "register"} onClick={() => setMode("register")} className="flex-1">Créer un compte</button>
              </div>
            )}
            <label className="block">
              <span className="field-label">E-mail</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" required className="input" />
            </label>
            <label className="block">
              <span className="field-label">Mot de passe maître</span>
              <PasswordInput value={password} onChange={setPassword} autoComplete={mode === "register" ? "new-password" : "current-password"} />
              {tooShort && <span className="help-text mt-1 block text-[var(--c-warn)]">Au moins 12 caractères : ce mot de passe est la seule chose qui protège vos secrets.</span>}
            </label>
            {mode === "register" && (
              <>
                <label className="block">
                  <span className="field-label">Confirmer</span>
                  <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
                  {mismatch && <span className="help-text mt-1 block text-[var(--c-warn)]">Les deux saisies diffèrent.</span>}
                </label>
                <p className="callout callout-warn">
                  Le serveur ne connaît jamais ce mot de passe et ne peut pas le réinitialiser : perdu, il est irrécupérable, et vos vaults avec.
                  {health?.registration === "invite_only" && " L'inscription est sur invitation : votre adresse doit avoir été invitée dans un vault, ou autorisée par l'administrateur."}
                </p>
              </>
            )}
            {error && <p className="callout callout-danger">{error}</p>}
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-[11px] text-[var(--c-text-faint)]">{health ? `serveur ${health.server_version}` : ""}</span>
              <button type="submit" disabled={!email.trim() || !password || busy !== null} className="btn btn-primary">
                {busy ?? (mode === "register" ? "Créer le compte" : "Se connecter")}
              </button>
            </div>
          </form>
        )}
        <p className="help-text mt-3 text-center">Le déchiffrement se fait dans ce navigateur. Rien n'est conservé après fermeture de l'onglet.</p>
      </div>
    </div>
  );
}
