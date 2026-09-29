import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, errorMessage } from "../lib/api";
import { formatSize, saveBlob } from "../lib/attachments";
import { indexItems } from "../lib/entities";
import { openSend, parseSendFragment, sendName, type SendPayload } from "../lib/sends";
import { KIND_LABELS, type SendInfo } from "../lib/types";
import { ItemView } from "./ItemView";
import { Logo } from "./Logo";
import { CopyButton, formatWhen, PasswordInput } from "./ui";

/** Un lien de partage reçu (`#/send/<id>/<secret>`), ouvert sans compte.
 * Rien n'est consommé avant « Ouvrir » : un aperçu de lien dans une
 * messagerie, qui charge la page, ne brûle pas une ouverture. */
export function SendView({ id, secret }: { id: string; secret: string }) {
  const parsed = useMemo(() => parseSendFragment(id, secret), [id, secret]);
  const [info, setInfo] = useState<SendInfo | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ content: SendPayload; viewsLeft: number | null; expiresAt: string; file?: Blob } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    if (!parsed) return;
    api.sendInfo(parsed.id).then(setInfo).catch((e) => {
      setGone(e instanceof ApiError && e.status === 404 ? "Ce lien n'existe pas, a expiré, ou a déjà été ouvert autant de fois que prévu." : errorMessage(e));
    });
  }, [parsed]);

  const reveal = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed || !info) return;
    setBusy(true);
    setError(null);
    try {
      const out = await openSend(parsed.id, parsed.secret, info, password, (done, total) =>
        setProgress(total > 1 ? `Téléchargement du fichier… ${Math.round((done / total) * 100)} %` : "Téléchargement du fichier…"));
      setOpened(out);
      // Le secret quitte la barre d'adresse (et l'historique de l'onglet) :
      // ce qu'il ouvrait est affiché, il n'a plus rien à y faire.
      window.history.replaceState(null, "", `#/send/${parsed.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setGone("Ce lien vient d'expirer, ou a déjà été ouvert autant de fois que prévu.");
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  let body;
  if (!parsed) {
    body = <p className="callout callout-danger">Ce lien est incomplet : la partie après <span className="font-mono">#/send/…/</span> contient la clé qui ouvre le contenu. Demandez à qui vous l'a envoyé de le recopier en entier.</p>;
  } else if (opened) {
    body = <Opened {...opened} />;
  } else if (gone) {
    body = <p className="callout">{gone}</p>;
  } else if (!info) {
    body = <p className="text-[12.5px] text-[var(--c-text-muted)]">Chargement…</p>;
  } else {
    body = (
      <form onSubmit={reveal} className="card space-y-3 p-4">
        <p className="text-[12.5px] leading-relaxed text-[var(--c-text-secondary)]">
          On vous a partagé un contenu chiffré de bout en bout. La clé est dans ce lien : le serveur ne l'a jamais vue et ne sait pas le lire.
        </p>
        <p className="text-[12px] text-[var(--c-text-muted)]">
          {info.views_left === null ? "Consultable" : info.views_left === 1 ? "Consultable une dernière fois" : `Consultable encore ${info.views_left} fois`} jusqu'au {formatWhen(info.expires_at)}.
        </p>
        {info.password && (
          <div>
            <label htmlFor="send-password" className="field-label">Mot de passe</label>
            <PasswordInput id="send-password" name="send-password" value={password} onChange={setPassword} autoFocus autoComplete="off" />
            <p className="help-text mt-1">Communiqué à part par la personne qui a créé le lien.</p>
          </div>
        )}
        {error && <p className="callout callout-danger">{error}</p>}
        <button type="submit" disabled={busy || (!!info.password && !password)} className="btn btn-primary w-full justify-center">
          {busy ? progress ?? (info.password ? "Dérivation de la clé…" : "Ouverture…") : "Ouvrir"}
        </button>
        {info.views_left !== null && <p className="help-text text-center">Chaque ouverture est comptée.</p>}
      </form>
    );
  }

  return (
    <div className="flex min-h-full items-start justify-center p-4 pt-[10vh]">
      <div className="w-full max-w-xl">
        <div className="mb-5 flex items-center gap-3 text-[var(--c-text)]">
          <Logo size={40} />
          <div>
            <h1 className="text-[15px] font-semibold leading-tight">Lien de partage</h1>
            <p className="text-[11.5px] text-[var(--c-text-muted)]">GuiVault — chiffré de bout en bout</p>
          </div>
        </div>
        {body}
      </div>
    </div>
  );
}

function Opened({ content, viewsLeft, expiresAt, file }: { content: SendPayload; viewsLeft: number | null; expiresAt: string; file?: Blob }) {
  const index = useMemo(() => indexItems([]), []);
  return (
    <div className="space-y-3">
      <div className="card space-y-3 p-4">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--c-text)]">{sendName(content)}</h2>
          {content.kind === "item" && <span className="tag">{KIND_LABELS[content.payload.kind]}</span>}
          {content.kind === "text" && <CopyButton value={content.text} label="Copier le texte" />}
          {content.kind === "file" && <span className="tag">fichier · {formatSize(content.size)}</span>}
        </div>
        {content.kind === "text" ? (
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--c-bg2)] p-3 font-mono text-[12.5px] text-[var(--c-text)]">{content.text}</pre>
        ) : content.kind === "file" ? (
          <div className="space-y-2">
            <p className="text-[12.5px] text-[var(--c-text-secondary)]">Le fichier a été téléchargé et déchiffré dans ce navigateur.</p>
            {file && <button type="button" onClick={() => saveBlob(file, content.name)} className="btn btn-primary">Enregistrer « {content.name} »</button>}
          </div>
        ) : (
          <ItemView payload={content.payload} index={index} shared />
        )}
      </div>
      <p className="help-text">
        {viewsLeft === 0 ? (content.kind === "file" ? "C'était la dernière ouverture : le serveur efface le fichier dans l'heure." : "C'était la dernière ouverture : le serveur a effacé le contenu.") : `Le lien reste valable jusqu'au ${formatWhen(expiresAt)}${viewsLeft === null ? "" : `, pour ${viewsLeft} ouverture${viewsLeft > 1 ? "s" : ""}`}.`}{" "}
        {content.kind === "file" ? "Enregistrez le fichier avant de fermer cette page." : "Copiez ce dont vous avez besoin avant de fermer cette page."}
      </p>
    </div>
  );
}
