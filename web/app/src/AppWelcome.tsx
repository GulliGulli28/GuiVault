import { useState, type FormEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, setBaseUrl } from "../../src/lib/api";
import { createLocal, openLocal, type SessionState } from "../../src/lib/session";
import { LoginScreen } from "../../src/components/LoginScreen";
import { Logo } from "../../src/components/Logo";
import { PasswordInput } from "../../src/components/ui";
import { tauriHost } from "./tauriHost";
import { coffreName, forgetCoffre, lastServer, recentCoffres, rememberCoffre, rememberServer } from "./recents";

type Step =
  | { kind: "home" }
  | { kind: "server" }
  | { kind: "login" }
  | { kind: "open"; path: string }
  | { kind: "create"; path: string };

/** L'écran d'accueil de l'app (`docs/APP.md`) : se connecter à un serveur
 * GuiVault — puis l'écran de connexion du web, tel quel —, ou ouvrir ou créer
 * un coffre local. Prend la place de `LoginScreen` dans `App`. */
export function AppWelcome({ onSession }: { onSession: (s: SessionState) => void }) {
  const [step, setStep] = useState<Step>({ kind: "home" });
  const [recents, setRecents] = useState(recentCoffres);
  const [error, setError] = useState<string | null>(null);
  const home = () => {
    setError(null);
    setRecents(recentCoffres());
    setStep({ kind: "home" });
  };

  const pickExisting = async () => {
    setError(null);
    const path = await open({ directory: true, title: "Ouvrir un coffre local" });
    if (typeof path === "string") setStep({ kind: "open", path });
  };
  const pickNew = async () => {
    setError(null);
    const path = await save({ title: "Créer un coffre local", defaultPath: "Mon coffre.guivault" });
    if (path) setStep({ kind: "create", path });
  };

  if (step.kind === "login") {
    return (
      <div>
        <div className="px-4 pt-4">
          <button onClick={home} className="btn btn-ghost btn-sm">← Accueil</button>
        </div>
        <LoginScreen onSession={onSession} />
      </div>
    );
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-3 text-[var(--c-text)]">
          <Logo size={44} locked />
          <div>
            <h1 className="text-[15px] font-semibold leading-tight">GuiVault</h1>
            <p className="text-[11.5px] text-[var(--c-text-muted)]">Coffre chiffré de bout en bout, avec ou sans serveur</p>
          </div>
        </div>

        {step.kind === "home" && (
          <div className="space-y-3">
            <div className="card space-y-2 p-4">
              <button onClick={() => setStep({ kind: "server" })} className="btn btn-primary w-full justify-center">Se connecter à un serveur</button>
              <button onClick={() => void pickExisting()} className="btn btn-secondary w-full justify-center">Ouvrir un coffre local</button>
              <button onClick={() => void pickNew()} className="btn btn-secondary w-full justify-center">Créer un coffre local</button>
            </div>
            {recents.length > 0 && (
              <div className="card p-2">
                <p className="field-label px-2 pt-1">Coffres récents</p>
                <ul>
                  {recents.map((path) => (
                    <li key={path} className="list-row flex items-center gap-2">
                      <button onClick={() => setStep({ kind: "open", path })} className="min-w-0 flex-1 text-left" title={path}>
                        <span className="block truncate text-[12.5px]">{coffreName(path)}</span>
                        <span className="block truncate font-mono text-[10.5px] text-[var(--c-text-faint)]">{path}</span>
                      </button>
                      <button onClick={() => { forgetCoffre(path); setRecents(recentCoffres()); }} className="btn btn-ghost btn-sm" aria-label={`Retirer ${coffreName(path)} de la liste`}>Retirer</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {error && <p className="callout callout-danger">{error}</p>}
            <p className="help-text text-center">
              Un coffre local est un dossier sur cet appareil, chiffré avec votre mot de passe maître. Pour retrouver vos secrets sur plusieurs appareils, utilisez un serveur.
            </p>
          </div>
        )}

        {step.kind === "server" && <ServerForm onBack={home} onReady={() => setStep({ kind: "login" })} />}
        {step.kind === "open" && <UnlockForm path={step.path} onBack={home} onSession={onSession} />}
        {step.kind === "create" && <CreateForm path={step.path} onBack={home} onSession={onSession} />}
      </div>
    </div>
  );
}

function ServerForm({ onBack, onReady }: { onBack: () => void; onReady: () => void }) {
  const [url, setUrl] = useState(lastServer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = url.trim().replace(/\/+$/, "");
    setBusy(true);
    setError(null);
    try {
      setBaseUrl(clean);
      await api.health();
      rememberServer(clean);
      onReady();
    } catch (err) {
      setError(`Aucun serveur GuiVault ne répond à cette adresse (${errorMessage(err)}).`);
    } finally {
      setBusy(false);
    }
  };
  const insecure = /^http:\/\//i.test(url.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url.trim());
  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <label className="block">
        <span className="field-label">Adresse du serveur</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} autoFocus required placeholder="https://vault.exemple.fr" className="input input-mono" />
      </label>
      {insecure && <p className="callout callout-warn">Sans HTTPS, qui est sur le réseau voit passer vos jetons de session. Les secrets restent chiffrés, mais préférez une adresse en https://.</p>}
      {error && <p className="callout callout-danger">{error}</p>}
      <div className="flex justify-between gap-2">
        <button type="button" onClick={onBack} className="btn btn-ghost">Retour</button>
        <button type="submit" disabled={!url.trim() || busy} className="btn btn-primary">{busy ? "Connexion…" : "Continuer"}</button>
      </div>
    </form>
  );
}

function UnlockForm({ path, onBack, onSession }: { path: string; onBack: () => void; onSession: (s: SessionState) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await openLocal(tauriHost, path, password);
      rememberCoffre(path);
      onSession(s);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div>
        <p className="text-[13px] font-medium">{coffreName(path)}</p>
        <p className="truncate font-mono text-[10.5px] text-[var(--c-text-faint)]" title={path}>{path}</p>
      </div>
      <label className="block">
        <span className="field-label">Mot de passe maître</span>
        <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
      </label>
      {error && <p className="callout callout-danger">{error}</p>}
      <div className="flex justify-between gap-2">
        <button type="button" onClick={onBack} className="btn btn-ghost">Retour</button>
        <button type="submit" disabled={!password || busy} className="btn btn-primary">{busy ? "Déverrouillage…" : "Déverrouiller"}</button>
      </div>
    </form>
  );
}

function CreateForm({ path, onBack, onSession }: { path: string; onBack: () => void; onSession: (s: SessionState) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = password.length > 0 && password.length < 12;
  const mismatch = confirm.length > 0 && confirm !== password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      const s = await createLocal(tauriHost, path, password);
      rememberCoffre(path);
      onSession(s);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div>
        <p className="text-[13px] font-medium">Nouveau coffre : {coffreName(path)}</p>
        <p className="truncate font-mono text-[10.5px] text-[var(--c-text-faint)]" title={path}>{path}</p>
      </div>
      <label className="block">
        <span className="field-label">Mot de passe maître</span>
        <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
      </label>
      {tooShort && <p className="help-text text-[var(--c-warn)]">Au moins 12 caractères : ce mot de passe est la seule chose qui protège vos secrets.</p>}
      <label className="block">
        <span className="field-label">Confirmer</span>
        <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
      </label>
      {mismatch && <p className="help-text text-[var(--c-warn)]">Les deux saisies diffèrent.</p>}
      <p className="callout callout-warn">Personne ne peut réinitialiser ce mot de passe : perdu, il est irrécupérable, et le coffre avec. Pensez aussi à sauvegarder le dossier.</p>
      {error && <p className="callout callout-danger">{error}</p>}
      <div className="flex justify-between gap-2">
        <button type="button" onClick={onBack} className="btn btn-ghost">Retour</button>
        <button type="submit" disabled={!password || password !== confirm || busy} className="btn btn-primary">{busy ? "Création…" : "Créer le coffre"}</button>
      </div>
    </form>
  );
}
