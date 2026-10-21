import { Page } from "./Page";
import { useEffect, useMemo, useState } from "react";
import type { PageContext } from "../App";
import { errorMessage } from "../lib/api";
import { indexItems } from "../lib/entities";
import { download, exportCsv, exportEncrypted, exportJson } from "../lib/exporters";
import { importFile, NeedsKeePassKey, NeedsPassword, resolveFolders, type ImportResult } from "../lib/importers";
import { attachmentLimit, uploadAttachment } from "../lib/attachments";
import { attachmentSealedSize } from "../lib/crypto";
import type { FileAttachment, Payload } from "../lib/types";
import { findVault, loadItems, payloadEntity, putPayload, type DecodedItem, type VaultView } from "../lib/session";
import { canWrite, KIND_LABELS_PLURAL, type ItemKind } from "../lib/types";
import { PasswordStrength } from "./PasswordStrength";
import { GroupSelect } from "./forms/common";
import { Field, FileButton, InfoTip, PasswordInput } from "./ui";

/** Import et export d'un vault. L'import lit le fichier dans le navigateur,
 * montre ce qu'il contient, puis chiffre et envoie item par item ; l'export
 * déchiffre tout ici et produit un fichier — en clair (à manier comme tel)
 * ou protégé par un mot de passe. */
export function ToolsPage({ ctx, vaultId }: { ctx: PageContext; vaultId: string }) {
  const vault = findVault(ctx.session, vaultId);
  if (!vault) return <p className="p-6 text-[12.5px] text-[var(--c-text-muted)]">Ce vault n'existe pas (ou plus).</p>;
  return <Body key={vault.id} ctx={ctx} vault={vault} />;
}

function Body({ ctx, vault }: { ctx: PageContext; vault: VaultView }) {
  const [items, setItems] = useState<DecodedItem[] | null>(null);
  const reload = () => loadItems(vault).then((p) => setItems(p.items)).catch((e) => ctx.error(errorMessage(e)));
  // Chargement initial ; `ctx` change à chaque notification.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [vault.id]);
  const index = useMemo(() => indexItems(items ?? []), [items]);
  const writable = canWrite(vault.role);

  return (
    <Page title={writable ? "Importer ou exporter" : "Exporter"} sub={vault.name} back={{ label: vault.name, route: { page: "vault", id: vault.id } }} width="max-w-[760px]">
      {writable ? (
        <ImportSection ctx={ctx} vault={vault} groups={index.groups} onDone={reload} />
      ) : (
        <p className="callout">{vault.emergency ? `Confié par ${vault.emergency.grantor} : lecture seule, l'export reste possible.` : "Lecteur de ce vault : l'export reste possible."}</p>
      )}
      <ExportSection ctx={ctx} vault={vault} items={items} />
    </Page>
  );
}

function ImportSection({ ctx, vault, groups, onDone }: { ctx: PageContext; vault: VaultView; groups: ReturnType<typeof indexItems>["groups"]; onDone: () => Promise<void> }) {
  const [content, setContent] = useState<Uint8Array | null>(null);
  const [filename, setFilename] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  // Une base KeePass : son fichier clé, s'il y en a un.
  const [keePass, setKeePass] = useState(false);
  const [keyFile, setKeyFile] = useState<{ name: string; data: Uint8Array } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rootId, setRootId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const parse = async (bytes: Uint8Array, pw?: string, key?: Uint8Array) => {
    setError(null);
    setBusy(true);
    try {
      setResult(await importFile(bytes, pw || undefined, key));
      setNeedsPassword(false);
    } catch (e) {
      setResult(null);
      if (e instanceof NeedsPassword) {
        setNeedsPassword(true);
        setKeePass(e instanceof NeedsKeePassKey);
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFilename(file.name);
    setPassword("");
    setKeyFile(null);
    setKeePass(false);
    setNeedsPassword(false);
    const bytes = new Uint8Array(await file.arrayBuffer());
    setContent(bytes);
    await parse(bytes);
  };

  const counts = useMemo(() => {
    const c = new Map<ItemKind, number>();
    for (const it of result?.items ?? []) c.set(it.payload.kind, (c.get(it.payload.kind) ?? 0) + 1);
    return c;
  }, [result]);

  const run = async () => {
    if (!result) return;
    const { groups: created, payloads } = resolveFolders(result, groups, rootId);
    const all: Payload[] = [...created.map((g) => ({ kind: "group" as const, group: g })), ...payloads];
    // Les pièces jointes (KeePass) suivent leur élément : `payloads[j]` est
    // `result.items[j]`.
    const filesAt = (i: number) => (i >= created.length ? result.items[i - created.length]?.files ?? [] : []);
    const fileCount = result.items.reduce((n, it) => n + (it.files?.length ?? 0), 0);
    const limit = fileCount ? await attachmentLimit() : 0;
    setProgress({ done: 0, total: all.length });
    let failed = 0;
    let filesDone = 0;
    const filesSkipped: string[] = [];
    for (let i = 0; i < all.length; i++) {
      try {
        const written = await putPayload(vault, all[i]);
        const files = filesAt(i);
        if (files.length) {
          const attached: FileAttachment[] = [];
          for (const f of files) {
            if (!limit || attachmentSealedSize(f.data.length) > limit) {
              filesSkipped.push(f.name);
              continue;
            }
            // Un élément doit exister pour recevoir un fichier : écrit
            // d'abord, puis réécrit avec ses pièces jointes.
            attached.push(await uploadAttachment(vault, written.id, new File([f.data as BlobPart], f.name)));
          }
          if (attached.length) {
            const copy = JSON.parse(JSON.stringify(all[i])) as Payload;
            payloadEntity(copy).attachments = attached;
            await putPayload(vault, copy, written.revision);
            filesDone += attached.length;
          }
        }
      } catch (e) {
        failed++;
        if (failed === 1) ctx.error(errorMessage(e));
      }
      setProgress({ done: i + 1, total: all.length });
    }
    setProgress(null);
    setResult(null);
    setContent(null);
    if (filesSkipped.length) ctx.error(`${filesSkipped.length} pièce(s) jointe(s) non importée(s) — ${limit ? "trop grosse(s) pour ce serveur" : "désactivées ici"} : ${filesSkipped.slice(0, 5).join(", ")}${filesSkipped.length > 5 ? "…" : ""}`);
    ctx.notify(`${payloads.length} élément(s) importé(s)${created.length ? ` (${created.length} dossier(s) créé(s))` : ""}${filesDone ? `, ${filesDone} pièce(s) jointe(s)` : ""}${failed ? `, ${failed} écriture(s) en échec` : ""}.`);
    await onDone();
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="section-title">Importer</h2>
      <div className="card flex flex-col items-center gap-2 border-dashed px-5 py-7 text-center">
        <FileButton label="Choisir un fichier" accept=".kdbx,.json,.csv,.txt,application/json,text/csv" small={false} onFile={(f) => void onFile(f)} />
        <p className="flex flex-wrap items-center justify-center gap-1.5 text-[12.5px] text-[var(--c-text-muted)]">
          KeePass, Bitwarden, Chrome, Firefox, LastPass, GuiVault · lu ici, rien ne part en clair
          <InfoTip label="Formats reconnus" items={[
            { text: "KeePass et KeePassXC : base .kdbx, pièces jointes et historique compris." },
            { text: "Bitwarden : JSON (en clair ou protégé) et CSV." },
            { text: "Chrome, Firefox, LastPass, KeePassXC : CSV. Et les exports GuiVault." },
          ]} />
        </p>
      </div>
      {needsPassword && content !== null && (
        <form onSubmit={(e) => { e.preventDefault(); void parse(content, password, keyFile?.data); }} className="callout space-y-2">
          <p>{keePass ? `« ${filename} » est une base KeePass : son mot de passe maître, et son fichier clé si elle en a un.` : `« ${filename} » est protégé par un mot de passe.`}</p>
          <div className="flex gap-2">
            <PasswordInput value={password} onChange={setPassword} autoFocus autoComplete="off" className="flex-1" />
            <button type="submit" disabled={(!password && !keyFile) || busy} className="btn btn-primary btn-sm">{busy ? "Déchiffrement…" : "Déchiffrer"}</button>
          </div>
          {keePass && (
            <div className="flex flex-wrap items-center gap-2">
              <FileButton label={keyFile ? `Fichier clé : ${keyFile.name}` : "Ajouter un fichier clé…"} accept=".keyx,.key,*" onFile={(f) => { if (f) void f.arrayBuffer().then((b) => setKeyFile({ name: f.name, data: new Uint8Array(b) })); }} />
              {keyFile && <button type="button" onClick={() => setKeyFile(null)} className="btn btn-ghost btn-sm">Retirer</button>}
            </div>
          )}
          {keePass && <p className="help-text">Quelques secondes de dérivation (Argon2 ou AES-KDF).</p>}
        </form>
      )}
      {error && <p className="callout callout-danger">{error}</p>}
      {result && (
        <div className="card space-y-3 p-3">
          <p className="text-[12.5px] text-[var(--c-text)]">
            <span className="font-medium">{filename}</span> — {result.format} : {result.items.length} élément(s)
            {counts.size > 0 && <span className="text-[var(--c-text-muted)]"> ({Array.from(counts).map(([k, n]) => `${n} ${KIND_LABELS_PLURAL[k].toLowerCase()}`).join(", ")})</span>}
          </p>
          {result.warnings.length > 0 && (
            <ul className="callout callout-warn list-inside list-disc space-y-0.5">
              {result.warnings.slice(0, 10).map((w, i) => <li key={i}>{w}</li>)}
              {result.warnings.length > 10 && <li>… et {result.warnings.length - 10} autre(s)</li>}
            </ul>
          )}
          <Field label="Sous le dossier" hint="Les dossiers du fichier sont recréés en dessous, ou réutilisés s'ils existent déjà.">
            <GroupSelect groups={groups} value={rootId} onChange={setRootId} />
          </Field>
          <div className="flex items-center justify-end gap-2">
            {progress && <span className="text-[11.5px] text-[var(--c-text-muted)]">{progress.done} / {progress.total}</span>}
            <button onClick={() => { setResult(null); setContent(null); }} disabled={progress !== null} className="btn btn-ghost btn-sm">Annuler</button>
            <button onClick={() => void run()} disabled={progress !== null || result.items.length === 0} className="btn btn-primary btn-sm">{progress ? "Import…" : "Importer"}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function ExportSection({ ctx, vault, items }: { ctx: PageContext; vault: VaultView; items: DecodedItem[] | null }) {
  const [format, setFormat] = useState<"json" | "encrypted" | "csv">("encrypted");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const payloads = useMemo(() => (items ?? []).flatMap((i) => (i.ok ? [i.payload] : [])), [items]);
  const unreadable = (items ?? []).filter((i) => !i.ok).length;
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `guivault-${vault.name.replace(/[^\w-]+/g, "_")}-${stamp}`;
  const csvSkipped = useMemo(() => (format === "csv" ? exportCsv(payloads).skipped : 0), [format, payloads]);

  const run = async () => {
    setBusy(true);
    try {
      if (format === "json") download(`${base}.json`, exportJson(vault, payloads));
      else if (format === "encrypted") download(`${base}.encrypted.json`, await exportEncrypted(vault, payloads, password));
      else download(`${base}.csv`, exportCsv(payloads).csv, "text/csv");
      ctx.notify("Export téléchargé.");
    } catch (e) {
      ctx.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = items !== null && (format !== "encrypted" || (password.length >= 8 && password === confirm));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="section-title">Exporter</h2>
        <span className="text-[12.5px] text-[var(--c-text-muted)]">{items ? `${payloads.length} éléments` : "Chargement…"}{unreadable ? ` · ${unreadable} illisibles laissés de côté` : ""} · sans les pièces jointes</span>
      </div>
      <div className="card flex flex-col gap-4 p-5">
      <div className="segmented self-start">
        <button type="button" data-active={format === "encrypted"} onClick={() => setFormat("encrypted")}>JSON chiffré</button>
        <button type="button" data-active={format === "json"} onClick={() => setFormat("json")}>JSON en clair</button>
        <button type="button" data-active={format === "csv"} onClick={() => setFormat("csv")}>CSV</button>
      </div>
      {format === "encrypted" && (
        <div className="space-y-2">
          <p className="help-text">Réimportable ici avec ce mot de passe, distinct du mot de passe maître et irrécupérable.</p>
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <Field label="Mot de passe du fichier"><PasswordInput value={password} onChange={setPassword} autoComplete="new-password" /></Field>
            <Field label="Confirmer"><PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" /></Field>
          </div>
          <PasswordStrength password={password} />
        </div>
      )}
      {format === "json" && <p className="callout callout-warn">En clair : tous les secrets y sont lisibles.</p>}
      {format === "csv" && <p className="callout callout-warn">En clair, format Bitwarden : identifiants et notes seulement{csvSkipped ? ` (${csvSkipped} autres éléments ignorés)` : ""}.</p>}
      <div className="flex justify-end">
        <button onClick={() => void run()} disabled={!ready || busy} className="btn btn-primary">{busy ? "Préparation…" : "Télécharger"}</button>
      </div>
      </div>
    </section>
  );
}
