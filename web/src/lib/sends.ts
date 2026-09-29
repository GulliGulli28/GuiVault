/** Les liens de partage éphémères (« Send ») : un texte, un élément ou un
 * fichier (ses morceaux sous la clé du lien, `sealSendChunk`),
 * chiffré sous une clé tirée d'un secret qui ne voyage que dans le fragment
 * de l'URL (`#/send/<id>/<secret>`) — le navigateur ne l'envoie jamais au
 * serveur. Le serveur garde le chiffré, l'expiration et le compte des vues,
 * et ne le remet qu'à qui présente la clé d'accès tirée du même secret (et
 * du mot de passe, s'il y en a un). `send_keys` côté Rust. */
import { api, baseUrl } from "./api";
import { fromBase64, fromBase64Url, randomBytes, toBase64, toBase64Url, utf8, uuid } from "./bytes";
import * as c from "./crypto";
import { isSecret } from "./items";
import type { SessionState } from "./session";
import type { Payload, SecretKind, SendSummary } from "./types";

/** Ce que contient un lien, une fois ouvert. `v` : pour faire évoluer le
 * format sans casser les liens déjà donnés. */
export type SendPayload =
  | { v: 1; kind: "text"; name: string; text: string }
  | { v: 1; kind: "item"; payload: Extract<Payload, { kind: SecretKind }> }
  /** Le fichier lui-même est à part, en morceaux ; ici, de quoi le décrire. */
  | { v: 1; kind: "file"; name: string; size: number; mime?: string | null };

/** Ce que l'auteur garde pour lui, sous sa user key : de quoi reconnaître le
 * lien dans sa liste et le recopier. */
interface OwnerNote {
  name: string;
  /** Le secret du lien (base64url). */
  secret: string;
  kind: SendPayload["kind"];
}

export interface SendOptions {
  /** Durée de vie, en secondes. */
  expiresIn: number;
  /** Ouvertures au plus ; absent : jusqu'à l'expiration. */
  maxViews?: number;
  /** Second facteur à transmettre par un autre canal que le lien. */
  password?: string;
}

/** Les durées proposées (le serveur plafonne à `send_max_days`). */
export const SEND_LIFETIMES: { label: string; secs: number }[] = [
  { label: "1 heure", secs: 3600 },
  { label: "1 jour", secs: 86_400 },
  { label: "7 jours", secs: 7 * 86_400 },
  { label: "30 jours", secs: 30 * 86_400 },
];

/** L'origine du serveur : celle de la page dans l'interface embarquée,
 * l'URL réglée dans l'extension. C'est là que le destinataire ouvre le lien. */
function serverOrigin(): string {
  const base = baseUrl();
  return base.startsWith("/") ? window.location.origin : base.replace(/\/api\/v1$/, "");
}

export function sendLink(id: string, secret: Uint8Array): string {
  return `${serverOrigin()}/#/send/${id}/${toBase64Url(secret)}`;
}

/** Ce qu'on partage d'un élément : son contenu, pas son rangement — ni le
 * dossier, ni les tags, ni le favori, ni l'icône, qui ne veulent rien dire
 * chez l'autre. */
export function shareablePayload<P extends Extract<Payload, { kind: SecretKind }>>(p: P): P {
  const copy = JSON.parse(JSON.stringify(p)) as P;
  const entity = Object.values(copy).find((v) => typeof v === "object" && v !== null && "id" in v) as Record<string, unknown> | undefined;
  if (entity) {
    entity.groupId = null;
    entity.tags = [];
    delete entity.favorite;
    delete entity.icon;
  }
  return copy;
}

export function sendName(content: SendPayload): string {
  if (content.kind === "text" || content.kind === "file") return content.name;
  const entity = Object.values(content.payload).find((v) => typeof v === "object" && v !== null && "name" in v) as { name?: string } | undefined;
  return entity?.name || "Élément";
}

/** Crée un lien. Pour un fichier (`file`, avec un contenu `kind: "file"`),
 * ses morceaux sont chiffrés et envoyés ensuite ; le lien ne s'ouvre qu'une
 * fois le dernier reçu (sinon il est supprimé). */
export async function createSend(
  state: SessionState,
  content: SendPayload,
  opts: SendOptions,
  file?: { data: Uint8Array; onProgress?: (done: number, total: number) => void },
): Promise<{ link: string; summary: SendSummary }> {
  const id = uuid();
  const secret = randomBytes(c.SEND_SECRET_LEN);
  let password: { kdf: c.KdfParams; salt: string } | undefined;
  let passwordKey: Uint8Array | undefined;
  if (opts.password) {
    const salt = randomBytes(c.SALT_LEN);
    passwordKey = await c.sendPasswordKey(opts.password, salt, c.DEFAULT_KDF);
    password = { kdf: c.DEFAULT_KDF, salt: toBase64(salt) };
  }
  const keys = c.sendKeys(secret, passwordKey);
  passwordKey?.fill(0);
  const note: OwnerNote = { name: sendName(content), secret: toBase64Url(secret), kind: content.kind };
  const chunks = file ? c.attachmentChunkCount(file.data.length) : 0;
  try {
    let summary = await api.createSend({
      id,
      ciphertext: toBase64(c.sealSend(keys, id, utf8.encode(JSON.stringify(content)))),
      access_hash: toBase64(c.sendAccessHash(keys)),
      owner_blob: toBase64(c.sealSendOwner(state.account.userKey, id, JSON.stringify(note))),
      password,
      max_views: opts.maxViews,
      expires_in_secs: opts.expiresIn,
      file: file ? { size: c.attachmentSealedSize(file.data.length), chunks } : undefined,
    });
    if (file) {
      try {
        for (let i = 0; i < chunks; i++) {
          const part = file.data.subarray(i * c.ATTACHMENT_CHUNK, Math.min(file.data.length, (i + 1) * c.ATTACHMENT_CHUNK));
          await api.putSendChunk(id, i, c.sealSendChunk(keys, id, i, i === chunks - 1, part));
          file.onProgress?.(i + 1, chunks);
        }
        summary = await api.completeSend(id);
      } catch (e) {
        void api.deleteSend(id).catch(() => {});
        throw e;
      }
    }
    return { link: sendLink(id, secret), summary };
  } finally {
    keys.enc.fill(0);
    keys.access.fill(0);
  }
}

/** Un lien de sa liste, avec ce que la fiche chiffrée en dit. */
export interface MySend extends SendSummary {
  name: string;
  kind: SendPayload["kind"] | null;
  /** `null` : fiche illisible (elle ne devrait pas l'être). */
  link: string | null;
}

export async function listSends(state: SessionState): Promise<MySend[]> {
  const rows = await api.sends();
  return rows.map((s) => {
    try {
      const note = JSON.parse(c.openSendOwner(state.account.userKey, s.id, fromBase64(s.owner_blob))) as OwnerNote;
      return { ...s, name: note.name, kind: note.kind, link: sendLink(s.id, fromBase64Url(note.secret)) };
    } catch {
      return { ...s, name: "(fiche illisible)", kind: null, link: null };
    }
  });
}

/** `#/send/<id>/<secret>` : de quoi ouvrir le lien, s'il est complet. */
export function parseSendFragment(id: string, secret: string): { id: string; secret: Uint8Array } | null {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  try {
    const bytes = fromBase64Url(secret);
    return bytes.length >= c.SEND_SECRET_LEN ? { id, secret: bytes } : null;
  } catch {
    return null;
  }
}

/** Ouvre un lien : dérive les clés (mot de passe compris), présente la clé
 * d'accès — une vue de consommée —, déchiffre. */
export async function openSend(
  id: string,
  secret: Uint8Array,
  info: { password?: { kdf: c.KdfParams; salt: string } },
  password?: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ content: SendPayload; viewsLeft: number | null; expiresAt: string; file?: Blob }> {
  let passwordKey: Uint8Array | undefined;
  if (info.password) {
    if (!password) throw new Error("Ce lien demande un mot de passe.");
    passwordKey = await c.sendPasswordKey(password, fromBase64(info.password.salt), info.password.kdf);
  }
  const keys = c.sendKeys(secret, passwordKey);
  passwordKey?.fill(0);
  try {
    const res = await api.openSend(id, toBase64(keys.access));
    let content: SendPayload;
    try {
      content = JSON.parse(utf8.decode(c.openSend(keys, id, fromBase64(res.ciphertext)))) as SendPayload;
    } catch {
      throw new Error("Le contenu de ce lien ne s'ouvre pas : le lien est incomplet, ou le contenu a été altéré.");
    }
    if (content.v !== 1 || (content.kind !== "text" && content.kind !== "file" && !(content.kind === "item" && isSecret(content.payload)))) {
      throw new Error("Ce lien contient un format inconnu de cette version de GuiVault.");
    }
    let file: Blob | undefined;
    if (content.kind === "file") {
      // La vue est consommée : on télécharge tout de suite, avec le jeton
      // qu'elle a donné (une heure).
      if (!res.download) throw new Error("Le serveur n'a pas donné de quoi télécharger le fichier.");
      const parts: Uint8Array[] = [];
      const n = res.download.chunks;
      for (let i = 0; i < n; i++) {
        const sealed = await api.sendFileChunk(id, i, res.download.token);
        try {
          parts.push(c.openSendChunk(keys, id, i, i === n - 1, sealed));
        } catch {
          throw new Error("Le fichier de ce lien ne s'ouvre pas : un morceau manque, est déplacé ou altéré.");
        }
        onProgress?.(i + 1, n);
      }
      const size = parts.reduce((t, p) => t + p.length, 0);
      if (size !== content.size) throw new Error(`Fichier incomplet : ${size} octets sur ${content.size}.`);
      file = new Blob(parts as BlobPart[], { type: content.mime || "application/octet-stream" });
    }
    return { content, viewsLeft: res.views_left, expiresAt: res.expires_at, file };
  } finally {
    keys.enc.fill(0);
    keys.access.fill(0);
  }
}
