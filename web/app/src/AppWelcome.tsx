import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, baseUrl, currentTokens, errorMessage, setBaseUrl } from "../../src/lib/api";
import { LocalBackups } from "../../src/components/LocalBackups";
import { createLocal, lockedTarget, openLocal, type SessionState } from "../../src/lib/session";
import { localBiometricId, serverBiometricId, touchBiometric, unlockLocalWithBiometric, unlockServerWithBiometric, useAutoPrompt, useBiometricState } from "../../src/lib/biometric";
import { IconFingerprint } from "../../src/components/secret-icons";
import { autofillBridge, coffreFileBridge } from "../../src/lib/platform";
import { AuthShell } from "../../src/components/AuthShell";
import { LoginScreen } from "../../src/components/LoginScreen";
import { InfoTip, PasswordInput } from "../../src/components/ui";
import { IconChevronRight, IconClose } from "../../src/components/ui-icons";
import { tileHue, tileInitial } from "../../src/lib/tiles";
import { pickCoffre, pickNewCoffre } from "./dialogs";
import { tauriHost } from "./tauriHost";
import { deviceCoffres, isMobile } from "./mobile";
import { coffreName, forgetCoffre, lastServer, recentCoffres, rememberCoffre, rememberServer } from "./recents";

type Step =
  | { kind: "home" }
  | { kind: "server" }
  | { kind: "login" }
  | { kind: "open"; path: string }
  | { kind: "create"; path: string }
  /** Un compte du serveur verrouillé, sa session encore ouverte. */
  | { kind: "locked"; userId: string; email: string };

/** Après un verrouillage, l'accueil rouvre ce qui vient d'être verrouillé. */
function firstStep(): Step {
  const t = lockedTarget();
  if (t?.kind === "local") return { kind: "open", path: t.path };
  if (t?.kind === "server" && currentTokens()) return { kind: "locked", userId: t.userId, email: t.email };
  return { kind: "home" };
}

/** L'écran d'accueil de l'app (`docs/APP.md`) : se connecter à un serveur
 * GuiVault — puis l'écran de connexion du web, tel quel —, ou ouvrir ou créer
 * un coffre local. Prend la place de `LoginScreen` dans `App`. */
export function AppWelcome({ onSession: done }: { onSession: (s: SessionState) => void }) {
  const [step, setStep] = useState<Step>(firstStep);
  // Ouvert par le mot de passe : le délai de la biométrie (et du
  // remplissage, qui suit les mêmes règles) repart.
  const onSession = useCallback((s: SessionState) => { touchBiometric(s); void autofillBridge()?.passwordUsed().catch(() => {}); done(s); }, [done]);
  const [recents, setRecents] = useState(recentCoffres);
  // Mobile : les coffres du dossier de l'app, récents ou non.
  const [device, setDevice] = useState<string[]>([]);
  useEffect(() => { if (isMobile()) void deviceCoffres().then(setDevice); }, [step.kind]);
  const listed = [...recents, ...device.filter((p) => !recents.includes(p))];
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
  // Android : une archive exportée d'un autre appareil (ou d'avant une
  // réinstallation) devient un coffre de celui-ci.
  const files = coffreFileBridge();
  const [importing, setImporting] = useState(false);
  const importArchive = async () => {
    if (!files) return;
    setError(null);
    setImporting(true);
    try {
      const path = await files.importArchive();
      if (path) setStep({ kind: "open", path });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  if (step.kind === "login") {
    return <LoginScreen onSession={onSession} extra={<button onClick={home} className="font-medium text-[var(--c-accent-text)] hover:underline">Coffre local ou autre serveur</button>} />;
  }
  if (step.kind === "server") return <ServerForm onBack={home} onReady={() => setStep({ kind: "login" })} />;
  if (step.kind === "open") return <UnlockForm key={step.path} path={step.path} onBack={home} onSession={onSession} onBiometric={done} onOpenCopy={(dest) => setStep({ kind: "open", path: dest })} />;
  if (step.kind === "locked") return <ServerLocked userId={step.userId} email={step.email} onSession={done} onPassword={() => setStep({ kind: "login" })} />;
  if (step.kind === "create") return <CreateForm path={step.path} onBack={home} onSession={onSession} />;

  return (
    <AuthShell title="Bienvenue" sub="Un serveur pour tous vos appareils, ou un coffre sur celui-ci." store={listed.length ? "local" : "server"} footer={<span>Chiffré sur cet appareil, avec ou sans serveur</span>}>
      {listed.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="field-label">{isMobile() ? "Coffres de cet appareil" : "Coffres récents"}</p>
          <ul className="card divide-y divide-[var(--c-border)]">
            {listed.map((path) => (
              <li key={path} className="flex min-w-0 items-center gap-1 pr-1.5">
                <button onClick={() => setStep({ kind: "open", path })} className="flex min-w-0 flex-1 items-center gap-3 rounded-[12px] py-2.5 pl-3 text-left hover:bg-[var(--c-sel)]" title={path}>
                  <CoffreTile path={path} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13.5px] font-medium">{coffreName(path)}</span>
                    <span className="truncate font-mono text-[11.5px] text-[var(--c-text-muted)]">{path}</span>
                  </span>
                  <IconChevronRight size={14} className="shrink-0 text-[var(--c-text-muted)]" />
                </button>
                {!isMobile() && <button onClick={() => { forgetCoffre(path); setRecents(recentCoffres()); }} className="btn btn-ghost btn-icon btn-sm shrink-0" title="Retirer de la liste" aria-label={`Retirer ${coffreName(path)} de la liste`}><IconClose size={13} /></button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        <button onClick={() => setStep({ kind: "server" })} className={`btn btn-lg w-full ${listed.length ? "btn-secondary" : "btn-primary"}`}>Se connecter à un serveur</button>
        <div className="flex items-center gap-3 text-[12.5px] text-[var(--c-text-muted)]"><span className="h-px flex-1 bg-[var(--c-border)]" />ou un coffre sur cet appareil<span className="h-px flex-1 bg-[var(--c-border)]" /></div>
        <div className="flex flex-wrap gap-2.5">
          {!isMobile() && <button onClick={() => void pickExisting()} className="btn btn-secondary btn-lg min-w-[160px] flex-1">Ouvrir un coffre local</button>}
          <button onClick={() => void pickNew()} className="btn btn-secondary btn-lg min-w-[160px] flex-1">Créer un coffre local</button>
          {files && <button onClick={() => void importArchive()} disabled={importing} className="btn btn-secondary btn-lg min-w-[160px] flex-1">{importing ? "Import…" : "Importer un coffre"}</button>}
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

/** Le bouton de la biométrie, et l'invite qui s'ouvre d'elle-même. */
function BiometricButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} className="btn btn-primary btn-lg w-full gap-2">
      <IconFingerprint size={20} />
      {busy ? "Déverrouillage…" : "Déverrouiller par biométrie"}
    </button>
  );
}

function Or() {
  return <div className="flex items-center gap-3 text-[12.5px] text-[var(--c-text-muted)]"><span className="h-px flex-1 bg-[var(--c-border)]" />ou<span className="h-px flex-1 bg-[var(--c-border)]" /></div>;
}

function UnlockForm({ path, onBack, onSession, onBiometric, onOpenCopy }: { path: string; onBack: () => void; onSession: (s: SessionState) => void; onBiometric: (s: SessionState) => void; onOpenCopy: (dest: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Un coffre illisible : ses sauvegardes sont le recours.
  const [corrupt, setCorrupt] = useState(false);
  const bio = useBiometricState(localBiometricId(path));
  const [bioOff, setBioOff] = useState<string | null>(null);
  const bioReady = !!bio?.ready && bioOff === null;
  const fail = (err: unknown) => {
    setCorrupt(err instanceof ApiError && err.code === "local_corrupt");
    setError(errorMessage(err));
    setBusy(false);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await openLocal(tauriHost, path, password);
      rememberCoffre(path);
      onSession(s);
    } catch (err) {
      fail(err);
    }
  };
  const biometric = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await unlockLocalWithBiometric(tauriHost, path, coffreName(path));
      if (r.kind === "ok") {
        rememberCoffre(path);
        onBiometric(r.value);
        return;
      }
      if (r.kind === "password") setBioOff(r.message);
      setBusy(false);
    } catch (err) {
      fail(err);
    }
  };
  useAutoPrompt(bioReady, () => void biometric());
  const hint = bioOff ?? bio?.password;
  return (
    <AuthShell title="Déverrouiller" sub="Le coffre se déchiffre ici, sur cet appareil." store="local" footer={<span className="truncate">Coffre local</span>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <CoffreCard path={path} onChange={onBack} />
        {bioReady && (
          <>
            <BiometricButton busy={busy} onClick={() => void biometric()} />
            <Or />
          </>
        )}
        <label className="block">
          <span className="field-label">Mot de passe maître</span>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" autoFocus={bio === null || !bioReady} />
        </label>
        {hint && <p className="callout flex items-center gap-2 text-[13px]"><IconFingerprint size={16} className="shrink-0 text-[var(--c-text-muted)]" /><span className="min-w-0 flex-1">{hint}</span></p>}
        {error && <p className="callout callout-danger">{error}</p>}
        {corrupt && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[13px]">Ce coffre ne se lit plus. Ses sauvegardes :</p>
            <LocalBackups path={path} onError={setError} onRestored={onOpenCopy} />
          </div>
        )}
        <button type="submit" disabled={!password || busy} className={`btn btn-lg w-full ${bioReady ? "btn-secondary" : "btn-primary"}`}>{busy && !bioReady ? "Déverrouillage…" : "Déverrouiller"}</button>
      </form>
    </AuthShell>
  );
}

/** Un compte du serveur verrouillé dont la session est encore ouverte : la
 * biométrie le rouvre sans nouvelle connexion ; sinon, le mot de passe
 * (l'écran de connexion). */
function ServerLocked({ userId, email, onSession, onPassword }: { userId: string; email: string; onSession: (s: SessionState) => void; onPassword: () => void }) {
  const bio = useBiometricState(serverBiometricId(userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (bio === null) onPassword(); }, [bio, onPassword]);
  const biometric = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await unlockServerWithBiometric(userId, email);
      if (r.kind === "ok") return onSession(r.value);
      if (r.kind === "password") setError(r.message);
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };
  useAutoPrompt(!!bio?.ready, () => void biometric());
  if (!bio) return null;
  return (
    <AuthShell title="Déverrouiller" sub="Vos secrets se déchiffrent ici, sur cet appareil." footer={<span className="truncate">{baseUrl() || "Serveur"}</span>}>
      <div className="flex flex-col gap-4">
        <div className="card flex min-w-0 items-center gap-3 py-2.5 pl-3 pr-2">
          <span className="tile shrink-0 rounded-full" style={{ "--tile-size": "34px", "--tile-h": 238 } as React.CSSProperties}>{tileInitial(email)}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13.5px] font-medium">{email}</span>
            <span className="truncate font-mono text-[11.5px] text-[var(--c-text-muted)]">{baseUrl().replace(/^https?:\/\//, "").replace(/\/api\/v1$/, "")}</span>
          </span>
        </div>
        {bio.ready && !error && <BiometricButton busy={busy} onClick={() => void biometric()} />}
        {(bio.password || error) && <p className="callout flex items-center gap-2 text-[13px]"><IconFingerprint size={16} className="shrink-0 text-[var(--c-text-muted)]" /><span className="min-w-0 flex-1">{error ?? bio.password}</span></p>}
        <button type="button" onClick={onPassword} className={`btn btn-lg w-full ${bio.ready && !error ? "btn-secondary" : "btn-primary"}`}>Utiliser le mot de passe</button>
      </div>
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
            { text: coffreFileBridge() ? "Exportez-le aussi de temps en temps : Paramètres › Compte." : "Sauvegardez aussi le dossier du coffre." },
          ]} />
        </div>
        {error && <p className="callout callout-danger">{error}</p>}
        <button type="submit" disabled={!password || password !== confirm || busy} className="btn btn-primary btn-lg w-full">{busy ? "Création…" : "Créer le coffre"}</button>
      </form>
    </AuthShell>
  );
}
