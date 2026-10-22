import { useState, type FormEvent } from "react";
import { api, ApiError, errorMessage, setBaseUrl } from "../../src/lib/api";
import { LocalBackups } from "../../src/components/LocalBackups";
import { createLocal, openLocal, type SessionState } from "../../src/lib/session";
import { AuthShell } from "../../src/components/AuthShell";
import { LoginScreen } from "../../src/components/LoginScreen";
import { InfoTip, PasswordInput } from "../../src/components/ui";
import { IconChevronRight, IconClose } from "../../src/components/ui-icons";
import { tileHue, tileInitial } from "../../src/lib/tiles";
import { pickCoffre, pickNewCoffre } from "./dialogs";
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
    const path = await pickCoffre();
    if (path) setStep({ kind: "open", path });
  };
  const pickNew = async () => {
    setError(null);
    const path = await pickNewCoffre();
    if (path) setStep({ kind: "create", path });
  };

  if (step.kind === "login") {
    return <LoginScreen onSession={onSession} extra={<button onClick={home} className="font-medium text-[var(--c-accent-text)] hover:underline">Coffre local ou autre serveur</button>} />;
  }
  if (step.kind === "server") return <ServerForm onBack={home} onReady={() => setStep({ kind: "login" })} />;
  if (step.kind === "open") return <UnlockForm key={step.path} path={step.path} onBack={home} onSession={onSession} onOpenCopy={(dest) => setStep({ kind: "open", path: dest })} />;
  if (step.kind === "create") return <CreateForm path={step.path} onBack={home} onSession={onSession} />;

  return (
    <AuthShell title="Bienvenue" sub="Un serveur pour tous vos appareils, ou un coffre sur celui-ci." store={recents.length ? "local" : "server"} footer={<span>Chiffré sur cet appareil, avec ou sans serveur</span>}>
      {recents.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="field-label">Coffres récents</p>
          <ul className="card divide-y divide-[var(--c-border)]">
            {recents.map((path) => (
              <li key={path} className="flex min-w-0 items-center gap-1 pr-1.5">
                <button onClick={() => setStep({ kind: "open", path })} className="flex min-w-0 flex-1 items-center gap-3 rounded-[12px] py-2.5 pl-3 text-left hover:bg-[var(--c-sel)]" title={path}>
                  <CoffreTile path={path} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] font-medium">{coffreName(path)}</span>
                    <span className="truncate font-mono text-[11.5px] text-[var(--c-text-muted)]">{path}</span>
                  </span>
                  <IconChevronRight size={14} className="shrink-0 text-[var(--c-text-muted)]" />
                </button>
                <button onClick={() => { forgetCoffre(path); setRecents(recentCoffres()); }} className="btn btn-ghost btn-icon btn-sm shrink-0" title="Retirer de la liste" aria-label={`Retirer ${coffreName(path)} de la liste`}><IconClose size={13} /></button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        <button onClick={() => setStep({ kind: "server" })} className={`btn btn-lg w-full ${recents.length ? "btn-secondary" : "btn-primary"}`}>Se connecter à un serveur</button>
        <div className="flex items-center gap-3 text-[12.5px] text-[var(--c-text-muted)]"><span className="h-px flex-1 bg-[var(--c-border)]" />ou un coffre sur cet appareil<span className="h-px flex-1 bg-[var(--c-border)]" /></div>
        <div className="flex flex-wrap gap-2.5">
          <button onClick={() => void pickExisting()} className="btn btn-secondary btn-lg min-w-[160px] flex-1">Ouvrir un coffre local</button>
          <button onClick={() => void pickNew()} className="btn btn-secondary btn-lg min-w-[160px] flex-1">Créer un coffre local</button>
        </div>
      </div>
      {error && <p className="callout callout-danger">{error}</p>}
    </AuthShell>
  );
}

/** Le coffre choisi : sa tuile, son nom, son dossier, et de quoi en changer. */
function CoffreCard({ path, onChange }: { path: string; onChange: () => void }) {
  return (
    <div className="card flex min-w-0 items-center gap-3 py-2.5 pl-3 pr-2" title={path}>
      <CoffreTile path={path} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13.5px] font-medium">{coffreName(path)}</span>
        <span className="truncate font-mono text-[11.5px] text-[var(--c-text-muted)]">{path}</span>
      </span>
      <button type="button" onClick={onChange} className="btn btn-ghost text-[var(--c-accent-text)]">Changer</button>
    </div>
  );
}

function CoffreTile({ path }: { path: string }) {
  const name = coffreName(path);
  return <span className="tile shrink-0" style={{ "--tile-size": "34px", "--tile-h": tileHue(name) } as React.CSSProperties}>{tileInitial(name)}</span>;
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
    <AuthShell title="Se connecter" sub="L'adresse de votre serveur GuiVault." footer={<span>Chiffré sur cet appareil, avant l'envoi</span>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="block">
          <span className="field-label">Adresse du serveur</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} autoFocus required placeholder="https://vault.exemple.fr" className="input input-mono h-[42px]" />
        </label>
        {insecure && (
          <div className="callout callout-warn flex items-center gap-2">
            <span className="min-w-0 flex-1">Sans HTTPS : préférez une adresse en https://.</span>
            <InfoTip label="Pourquoi" align="right" items={[
              { text: "Qui est sur le réseau voit passer vos jetons de session.", tone: "warn" },
              { text: "Vos secrets, eux, restent chiffrés.", tone: "ok" },
            ]} />
          </div>
        )}
        {error && <p className="callout callout-danger">{error}</p>}
        <button type="submit" disabled={!url.trim() || busy} className="btn btn-primary btn-lg w-full">{busy ? "Connexion…" : "Continuer"}</button>
        <button type="button" onClick={onBack} className="btn btn-ghost w-full">Retour</button>
      </form>
    </AuthShell>
  );
}

function UnlockForm({ path, onBack, onSession, onOpenCopy }: { path: string; onBack: () => void; onSession: (s: SessionState) => void; onOpenCopy: (dest: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Un coffre illisible : ses sauvegardes sont le recours.
  const [corrupt, setCorrupt] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await openLocal(tauriHost, path, password);
      rememberCoffre(path);
      onSession(s);
    } catch (err) {
      setCorrupt(err instanceof ApiError && err.code === "local_corrupt");
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Déverrouiller" sub="Le coffre se déchiffre ici, sur cet appareil." store="local" footer={<span className="truncate">Coffre local</span>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <CoffreCard path={path} onChange={onBack} />
        <label className="block">
          <span className="field-label">Mot de passe maître</span>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" autoFocus />
        </label>
        {error && <p className="callout callout-danger">{error}</p>}
        {corrupt && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[13px]">Ce coffre ne se lit plus. Ses sauvegardes :</p>
            <LocalBackups path={path} onError={setError} onRestored={onOpenCopy} />
          </div>
        )}
        <button type="submit" disabled={!password || busy} className="btn btn-primary btn-lg w-full">{busy ? "Déverrouillage…" : "Déverrouiller"}</button>
      </form>
    </AuthShell>
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
    <AuthShell title="Nouveau coffre" sub="Un dossier sur cet appareil, chiffré par votre mot de passe maître." store="local" footer={<span className="truncate">Coffre local</span>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <CoffreCard path={path} onChange={onBack} />
        <label className="block">
          <span className="field-label">Mot de passe maître</span>
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
          {tooShort && <span className="help-text mt-1.5 block text-[var(--c-warn-text)]">Au moins 12 caractères.</span>}
        </label>
        <label className="block">
          <span className="field-label">Confirmer</span>
          <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {mismatch && <span className="help-text mt-1.5 block text-[var(--c-warn-text)]">Les deux saisies diffèrent.</span>}
        </label>
        <div className="callout callout-warn flex items-center gap-2">
          <span className="min-w-0 flex-1">Mot de passe perdu = coffre perdu.</span>
          <InfoTip label="Pourquoi" align="right" items={[
            { text: "Personne ne peut réinitialiser ce mot de passe.", tone: "warn" },
            { text: "Sauvegardez aussi le dossier du coffre." },
          ]} />
        </div>
        {error && <p className="callout callout-danger">{error}</p>}
        <button type="submit" disabled={!password || password !== confirm || busy} className="btn btn-primary btn-lg w-full">{busy ? "Création…" : "Créer le coffre"}</button>
      </form>
    </AuthShell>
  );
}
