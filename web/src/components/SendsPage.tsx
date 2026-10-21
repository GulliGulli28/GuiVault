import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { PageContext } from "../App";
import { api, errorMessage } from "../lib/api";
import { formatSize } from "../lib/attachments";
import { attachmentSealedSize } from "../lib/crypto";
import { createSend, listSends, SEND_LIFETIMES, shareablePayload, type MySend, type SendPayload } from "../lib/sends";
import type { SessionState } from "../lib/session";
import { KIND_LABELS, type Payload, type SecretKind } from "../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconCheck, IconCopy, IconKeychain, IconLock, IconPlus, IconTrash } from "./ui-icons";
import { IconShieldClock } from "./secret-icons";
import { copyText, CopyButton, Field, FileButton, formatAgo, formatWhen, Loading, Modal, PasswordInput, useDelayed } from "./ui";
import { Page } from "./Page";

/** Les liens de partage de ce compte : qui en est où (ouvertures,
 * expiration), les recopier, les supprimer — et en créer un pour un texte ou
 * un fichier. */
export function SendsPage({ ctx }: { ctx: PageContext }) {
  const [sends, setSends] = useState<MySend[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<MySend | null>(null);
  const [tab, setTab] = useState<"active" | "gone">("active");
  const slow = useDelayed(sends === null);
  const { session, error } = ctx;

  const load = useCallback(() => {
    listSends(session).then(setSends).catch((e) => { setSends([]); error(errorMessage(e)); });
  }, [session, error]);
  // Au montage seulement : `session` change d'identité à chaque `/sync`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const closeCreate = useCallback(() => { setCreating(false); load(); }, [load]);

  const shown = (sends ?? []).filter((s) => (tab === "active" ? s.available : !s.available));
  const active = (sends ?? []).filter((s) => s.available).length;

  return (
    <Page
      title="Liens de partage"
      sub="Pour transmettre un secret à quelqu'un qui n'a pas de compte."
      actions={<button onClick={() => setCreating(true)} className="btn btn-primary btn-lg"><IconPlus size={15} /> Nouveau lien</button>}
    >
      <div className="flex flex-wrap gap-2.5">
        <span className="pill"><IconLock size={15} /> Chiffré avant l'envoi</span>
        <span className="pill"><IconKeychain size={15} /> La clé reste dans le lien</span>
        <span className="pill"><IconShieldClock size={15} /> Effacé à l'expiration</span>
      </div>
      <section className="card">
        <div className="tabs px-[18px] pt-3.5" role="tablist" aria-label="Liens">
          <button role="tab" aria-selected={tab === "active"} onClick={() => setTab("active")} className="tab">Actifs <span className="text-[var(--c-text-muted)]">{active}</span></button>
          <button role="tab" aria-selected={tab === "gone"} onClick={() => setTab("gone")} className="tab">Expirés <span className="text-[var(--c-text-muted)]">{(sends?.length ?? 0) - active}</span></button>
        </div>
        {sends === null ? (slow ? <Loading /> : <div className="h-16" />) : shown.length === 0 ? (
          <div className="empty px-5 py-10 text-[13.5px] text-[var(--c-text-muted)]">
            {tab === "active" ? "Aucun lien actif." : "Aucun lien expiré."}
            {tab === "active" && <p className="mt-1 text-[12.5px]">Un élément se partage depuis sa fiche : « Partager ».</p>}
          </div>
        ) : (
          <div className="divide-y divide-[var(--c-border)]">
            {shown.map((s) => {
              const kind = s.kind === "text" ? "Texte" : s.kind === "file" ? `Fichier${s.file_size ? ` · ${formatSize(s.file_size)}` : ""}` : "Élément";
              const ratio = s.max_views ? Math.min(1, s.views / s.max_views) : 0;
              return (
                <div key={s.id} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-[18px] py-3.5">
                  <span className="tile tile-neutral" style={{ "--tile-size": "36px" } as React.CSSProperties}>{s.kind === "file" ? "F" : s.kind === "text" ? "T" : "É"}</span>
                  <span className="flex min-w-0 flex-[1_1_220px] flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-semibold">{s.name}</span>
                      {s.has_password && <span className="tag shrink-0" title="Un mot de passe est demandé à l'ouverture">Mot de passe</span>}
                    </span>
                    <span className="truncate text-[12.5px] text-[var(--c-text-muted)]">{kind}{s.last_viewed_at ? ` · ouvert ${formatAgo(s.last_viewed_at)}` : ""}</span>
                  </span>
                  <span className="flex w-[150px] flex-col gap-1.5 max-sm:hidden">
                    <span className="text-[12.5px] text-[var(--c-text-secondary)]">{s.max_views === null ? `${s.views} ouverture${s.views > 1 ? "s" : ""}` : `${s.views} / ${s.max_views} ouverture${s.max_views > 1 ? "s" : ""}`}</span>
                    {s.max_views !== null && <span className="flex h-1 rounded bg-[var(--c-bg3)]"><span className="rounded" style={{ width: `${ratio * 100}%`, background: ratio >= 0.8 ? "var(--c-warn)" : "var(--c-accent)" }} /></span>}
                  </span>
                  <span className="w-[130px] text-[13px] text-[var(--c-text-secondary)]" title={formatWhen(s.expires_at)}>{s.available ? `Expire ${formatIn(s.expires_at)}` : new Date(s.expires_at) <= new Date() ? "Expiré" : "Épuisé"}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {s.available && s.link && <CopyLinkButton link={s.link} />}
                    <button onClick={() => setRemoving(s)} className="btn btn-ghost btn-icon hover:text-[var(--c-danger)]" title="Supprimer le lien" aria-label="Supprimer le lien"><IconTrash size={15} /></button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
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
    </Page>
  );
}

/** « Copier le lien », avec la confirmation à la place du libellé. */
function CopyLinkButton({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => void copyText(link).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })} className="btn btn-secondary">
      {copied ? <IconCheck size={14} className="text-[var(--c-ok)]" /> : <IconCopy size={14} />} {copied ? "Copié" : "Copier le lien"}
    </button>
  );
}

/** « dans 23 h », « dans 3 jours » : une échéance proche. */
function formatIn(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return "maintenant";
  if (s < 3600) return `dans ${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `dans ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return `dans ${d} jour${d > 1 ? "s" : ""}`;
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
        <div className="space-y-4">
          <div className="flex items-center gap-1">
            <input readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} className="input input-mono min-w-0 flex-1 text-[12.5px]" aria-label="Lien de partage" />
            <CopyButton value={result.link} label="Copier le lien" />
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="pill">{result.views === null ? "Ouvertures illimitées" : `${result.views} ouverture${result.views > 1 ? "s" : ""} au plus`}</span>
            <span className="pill">Jusqu'au {formatWhen(result.expiresAt)}</span>
          </div>
          {result.password && <p className="callout callout-warn">Envoyez le mot de passe par un autre canal que le lien.</p>}
          <div className="flex justify-end">
            <button onClick={onClose} className="btn btn-primary">Terminé</button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {item ? (
          <p className="text-[13.5px] text-[var(--c-text-secondary)]">Une copie chiffrée de cet élément ({KIND_LABELS[item.kind]}), sans son dossier : le modifier ensuite ne change pas le lien.</p>
        ) : file ? (
          <p className="truncate text-[13.5px] text-[var(--c-text-secondary)]">« {file.name} » · {formatSize(file.size)} · chiffré avant l'envoi</p>
        ) : (
          <>
            {maxFile > 0 && (
              <div className="segmented flex w-full">
                <button type="button" className="flex-1" data-active={mode === "text"} onClick={() => setMode("text")}>Texte</button>
                <button type="button" className="flex-1" data-active={mode === "file"} onClick={() => setMode("file")}>Fichier</button>
              </div>
            )}
            {mode === "text" ? (
              <>
                <Field label="Nom" hint="Visible du destinataire.">
                  <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Code Wi-Fi" className="input" />
                </Field>
                <Field label="Texte">
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className="input input-mono min-h-[6rem]" />
                </Field>
              </>
            ) : (
              <div>
                <span className="field-label">Fichier</span>
                <FileButton label="Choisir un fichier" small={false} onFile={(f) => setPicked(f ?? null)} />
                <p className="help-text mt-1.5">{formatSize(maxFile)} max · chiffré avant l'envoi</p>
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
          <label htmlFor="send-new-password" className="field-label">Mot de passe d'ouverture <span className="font-normal text-[var(--c-text-muted)]">· facultatif</span></label>
          <PasswordInput id="send-new-password" value={password} onChange={setPassword} autoComplete="new-password" />
          <p className="help-text mt-1.5">À transmettre par un autre canal que le lien.</p>
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
