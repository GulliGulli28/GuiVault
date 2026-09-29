import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { formatSize } from "../lib/attachments";
import { attachmentSealedSize } from "../lib/crypto";
import { createSend, listSends, SEND_LIFETIMES, shareablePayload, type MySend, type SendPayload } from "../lib/sends";
import type { SessionState } from "../lib/session";
import { KIND_LABELS, type Payload, type SecretKind } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconPlus, IconTrash } from "./ui-icons";
import { CopyButton, Eyebrow, Field, formatWhen, Loading, Modal, PasswordInput, useDelayed } from "./ui";

/** Les liens de partage de ce compte : qui en est où (ouvertures,
 * expiration), les recopier, les supprimer — et en créer un pour un texte ou
 * un fichier. */
export function SendsPage({ ctx }: { ctx: PageContext }) {
  const [sends, setSends] = useState<MySend[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<MySend | null>(null);
  const slow = useDelayed(sends === null);
  const { session, error } = ctx;

  const load = useCallback(() => {
    listSends(session).then(setSends).catch((e) => { setSends([]); error(errorMessage(e)); });
  }, [session, error]);
  // Au montage seulement : `session` change d'identité à chaque `/sync`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const closeCreate = useCallback(() => { setCreating(false); load(); }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--c-border)] px-4 py-2.5 max-md:pl-14">
        <h1 className="text-[14px] font-semibold text-[var(--c-text)]">Liens de partage</h1>
        <button onClick={() => setCreating(true)} className="btn btn-primary btn-sm ml-auto"><IconPlus size={12} /> Nouveau lien</button>
      </header>
      <div className="sidebar-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <p className="help-text max-w-2xl">
          Un lien de partage transmet un secret à quelqu'un qui n'a pas de compte : il est chiffré dans votre navigateur, la clé est dans le lien, et le serveur ne garde qu'un contenu illisible qu'il efface à l'expiration ou à la dernière ouverture.
          Pour partager un élément, ouvrez-le dans son vault et choisissez « Partager par lien ».
        </p>
        <section className="max-w-2xl space-y-1.5">
          <Eyebrow>Vos liens</Eyebrow>
          {sends === null ? (slow ? <Loading /> : null) : sends.length === 0 ? (
            <p className="text-[12.5px] text-[var(--c-text-muted)]">Aucun lien pour l'instant.</p>
          ) : (
            sends.map((s) => (
              <div key={s.id} className="card flex min-w-0 flex-wrap items-center gap-2 p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--c-text)]">
                    <span className="truncate">{s.name}</span>
                    {s.kind && <span className="tag shrink-0">{s.kind === "text" ? "texte" : s.kind === "file" ? `fichier${s.file_size ? ` · ${formatSize(s.file_size)}` : ""}` : "élément"}</span>}
                    {s.has_password && <span className="tag shrink-0" title="Un mot de passe est demandé à l'ouverture">mot de passe</span>}
                    {!s.available && <span className="tag shrink-0">{new Date(s.expires_at) <= new Date() ? "expiré" : "épuisé"}</span>}
                  </p>
                  <p className="text-[11px] text-[var(--c-text-muted)]">
                    {s.max_views === null ? `${s.views} ouverture${s.views > 1 ? "s" : ""}` : `${s.views}/${s.max_views} ouverture${s.max_views > 1 ? "s" : ""}`}
                    {s.last_viewed_at ? ` · dernière le ${formatWhen(s.last_viewed_at)}` : ""}
                    {` · ${s.available ? "expire" : "effacé"} le ${formatWhen(s.expires_at)}`}
                  </p>
                </div>
                {s.available && s.link && <CopyButton value={s.link} label="Copier le lien" />}
                <button onClick={() => setRemoving(s)} className="btn btn-ghost btn-sm btn-icon hover:text-[var(--c-danger)]" title="Supprimer le lien" aria-label="Supprimer le lien"><IconTrash size={12} /></button>
              </div>
            ))
          )}
        </section>
      </div>
      {creating && <ShareLinkDialog session={session} onClose={closeCreate} />}
      {removing && (
        <ConfirmDialog
          title={`Supprimer le lien « ${removing.name} » ?`}
          message="Le serveur efface le contenu chiffré : le lien n'ouvrira plus rien, même pour qui l'a déjà reçu."
          confirmLabel="Supprimer"
          danger
          onConfirm={async () => {
            const s = removing;
            setRemoving(null);
            try {
              await api.deleteSend(s.id);
              ctx.notify("Lien supprimé.");
            } catch (e) {
              error(errorMessage(e));
            }
            load();
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

const VIEW_CHOICES: { label: string; value: number | null }[] = [
  { label: "1 fois", value: 1 },
  { label: "2 fois", value: 2 },
  { label: "5 fois", value: 5 },
  { label: "10 fois", value: 10 },
  { label: "Sans limite", value: null },
];

/** Créer un lien : pour un élément (`item`), un fichier (`file`, une pièce
 * jointe déchiffrée), ou un texte ou un fichier choisis ici. `onClose` doit
 * être stable (`useModalSurface`). */
export function ShareLinkDialog({ session, item, file, onClose }: { session: SessionState; item?: Extract<Payload, { kind: SecretKind }>; file?: File; onClose: () => void }) {
  const [maxDays, setMaxDays] = useState<number | null>(null);
  const [maxFile, setMaxFile] = useState(0);
  const [mode, setMode] = useState<"text" | "file">(file ? "file" : "text");
  const [picked, setPicked] = useState<File | null>(file ?? null);
  const [progress, setProgress] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [lifetime, setLifetime] = useState(86_400);
  const [views, setViews] = useState<number | null>(1);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ link: string; expiresAt: string; views: number | null; password: boolean } | null>(null);

  useEffect(() => {
    api.health().then((h) => {
      setMaxDays(h.send_max_days ?? 0);
      setMaxFile(h.max_attachment_bytes ?? 0);
    }).catch(() => setMaxDays(0));
  }, []);
  const lifetimes = SEND_LIFETIMES.filter((l) => maxDays === null || l.secs <= maxDays * 86_400);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const opts = { expiresIn: lifetime, maxViews: views ?? undefined, password: password || undefined };
      let out;
      if (!item && mode === "file" && picked) {
        const data = new Uint8Array(await picked.arrayBuffer());
        const content: SendPayload = { v: 1, kind: "file", name: picked.name || "fichier", size: data.length, mime: picked.type || null };
        out = await createSend(session, content, opts, {
          data,
          onProgress: (done, total) => setProgress(total > 1 ? `Envoi… ${Math.round((done / total) * 100)} %` : "Envoi…"),
        });
      } else {
        const content: SendPayload = item ? { v: 1, kind: "item", payload: shareablePayload(item) } : { v: 1, kind: "text", name: name.trim() || "Texte", text };
        out = await createSend(session, content, opts);
      }
      setResult({ link: out.link, expiresAt: out.summary.expires_at, views, password: !!password });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const title = item ? "Partager par lien" : file ? `Partager « ${file.name} » par lien` : "Nouveau lien de partage";
  const tooBig = mode === "file" && !!picked && maxFile > 0 && attachmentSealedSize(picked.size) > maxFile;
  if (maxDays === 0) {
    return (
      <Modal title={title} onClose={onClose}>
        <p className="callout">Les liens de partage sont désactivés sur ce serveur (<span className="font-mono">GUIVAULT_SEND_MAX_DAYS=0</span>), ou il est trop ancien pour les connaître.</p>
      </Modal>
    );
  }
  if (result) {
    return (
      <Modal title="Lien créé" onClose={onClose}>
        <div className="space-y-3">
          <div className="flex items-center gap-1">
            <input readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} className="input input-mono min-w-0 flex-1 text-[11.5px]" aria-label="Lien de partage" />
            <CopyButton value={result.link} label="Copier le lien" />
          </div>
          <p className="help-text">
            La clé est dans le lien : quiconque l'a peut l'ouvrir{result.views === null ? "" : ` (${result.views} fois au plus)`} jusqu'au {formatWhen(result.expiresAt)}.
            {result.password ? " Transmettez le mot de passe par un autre canal que le lien." : " Envoyez-le par un canal de confiance."}
          </p>
          <div className="flex justify-end">
            <button onClick={onClose} className="btn btn-primary">Terminé</button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {item ? (
          <p className="text-[12.5px] text-[var(--c-text-secondary)]">
            Le contenu de cet élément ({KIND_LABELS[item.kind]}, sans son dossier) est chiffré dans votre navigateur ; le lien porte la clé.
            Une copie : le modifier ensuite ne change pas ce que le lien montre.
          </p>
        ) : file ? (
          <p className="text-[12.5px] text-[var(--c-text-secondary)]">
            « {file.name} » ({formatSize(file.size)}) est chiffré dans votre navigateur sous la clé du lien, puis envoyé ; le lien porte la clé.
          </p>
        ) : (
          <>
            {maxFile > 0 && (
              <div className="segmented">
                <button type="button" data-active={mode === "text"} onClick={() => setMode("text")}>Texte</button>
                <button type="button" data-active={mode === "file"} onClick={() => setMode("file")}>Fichier</button>
              </div>
            )}
            {mode === "text" ? (
              <>
                <Field label="Nom" hint="Pour vous retrouver dans vos liens ; le destinataire le voit aussi.">
                  <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Code Wi-Fi" className="input" />
                </Field>
                <Field label="Texte">
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} className="input input-mono min-h-[6rem] py-1.5" />
                </Field>
              </>
            ) : (
              <div>
                <label htmlFor="send-file" className="field-label">Fichier</label>
                <input id="send-file" type="file" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} className="block text-[12px] text-[var(--c-text-secondary)]" />
                <p className="help-text mt-1">Chiffré dans votre navigateur avant l'envoi, {formatSize(maxFile)} au plus. Son nom est visible du destinataire, pas du serveur.</p>
              </div>
            )}
          </>
        )}
        {tooBig && <p className="callout callout-danger">Ce fichier dépasse la taille permise sur ce serveur ({formatSize(maxFile)}).</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Expire dans">
            <select value={lifetime} onChange={(e) => setLifetime(Number(e.target.value))} className="input">
              {lifetimes.map((l) => <option key={l.secs} value={l.secs}>{l.label}</option>)}
            </select>
          </Field>
          <Field label="Ouvertures">
            <select value={views ?? ""} onChange={(e) => setViews(e.target.value ? Number(e.target.value) : null)} className="input">
              {VIEW_CHOICES.map((v) => <option key={v.label} value={v.value ?? ""}>{v.label}</option>)}
            </select>
          </Field>
        </div>
        <div>
          <label htmlFor="send-new-password" className="field-label">Mot de passe (facultatif)</label>
          <PasswordInput id="send-new-password" value={password} onChange={setPassword} autoComplete="new-password" />
          <p className="help-text mt-1">Mêlé à la clé : sans lui, le lien seul n'ouvre rien — pas même pour le serveur. À transmettre par un autre canal.</p>
        </div>
        {error && <p className="callout callout-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">Annuler</button>
          <button type="submit" disabled={busy || maxDays === null || tooBig || (!item && (mode === "file" ? !picked : !text))} className="btn btn-primary">{busy ? progress ?? "Chiffrement…" : "Créer le lien"}</button>
        </div>
      </form>
    </Modal>
  );
}
