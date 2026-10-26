import type { ReactNode } from "react";
import type { VaultIndex } from "../lib/entities";
import { groupPath } from "../lib/entities";
import { estimateStrength } from "../lib/generator";
import { STRENGTH_LABELS } from "./PasswordStrength";
import { passwordSince, secretsOf } from "../lib/health";
import type { DecodedItem, VaultView } from "../lib/session";
import { payloadEntity } from "../lib/session";
import type { VaultItem } from "../lib/allItems";
import { formatAgo, formatWhen } from "./ui";
import { IconCheck, IconWarning } from "./ui-icons";
import { t } from "../lib/i18n";

/** La colonne de droite de la fiche (maquette « Coffre ») : ce que dit la
 * santé de cet élément — force, réutilisation, 2FA, âge du mot de passe —,
 * puis son dossier, ses tags et ses versions. Calculée ici, comme la page
 * Santé ; les fuites restent sur la page Santé (elles demandent le relais). */
export function ItemAside({ vault, item, index, all, onHistory }: {
  vault: VaultView;
  item: DecodedItem & { ok: true };
  index: VaultIndex;
  all: VaultItem[];
  onHistory?: () => void;
}) {
  const p = item.payload;
  const entity = payloadEntity(p);
  const groupId = typeof entity.groupId === "string" ? entity.groupId : null;
  const tags = Array.isArray(entity.tags) ? (entity.tags as string[]) : [];
  const groups = new Map(index.groups.map((g) => [g.id, g]));

  const checks: { ok: boolean | null; text: ReactNode }[] = [];
  for (const s of secretsOf({ vault, item })) {
    const strength = estimateStrength(s.value);
    checks.push({ ok: strength.score >= 3 ? true : strength.score <= 1 ? false : null, text: `${capitalize(s.label)} ${STRENGTH_LABELS[strength.score]}` });
    const elsewhere = all.filter((o) => o.item.id !== item.id && secretsOf(o).some((x) => x.value === s.value));
    checks.push(elsewhere.length
      ? { ok: false, text: <>{t("Aussi utilisé par «")} {nameOf(elsewhere[0])} »{elsewhere.length > 1 ? t(" et {0} autre{1}", elsewhere.length - 1, elsewhere.length > 2 ? "s" : "") : ""}</> }
      : { ok: true, text: t("Utilisé nulle part ailleurs") });
  }
  if (p.kind === "login" && p.login.password) {
    checks.push(p.login.totp ? { ok: true, text: t("2FA enregistrée") } : { ok: null, text: t("Pas de code 2FA") });
    const since = passwordSince({ vault, item });
    if (since) {
      const old = Date.now() - since.getTime() > 365 * 86_400_000;
      checks.push({ ok: old ? false : null, text: t("Mot de passe changé {0}", formatAgo(since.toISOString())) });
    }
  }

  return (
    <div className="grid content-start gap-4 sm:grid-cols-2 min-[1500px]:grid-cols-1">
      {checks.length > 0 && (
        <div className="card flex flex-col gap-3 p-4">
          <span className="text-[13.5px] font-medium">{t("Sécurité")}</span>
          {checks.map((c, i) => (
            <span key={i} className="flex min-w-0 items-start gap-2.5 text-[13px] text-[var(--c-text-secondary)]">
              <span className={`mt-px shrink-0 ${c.ok === true ? "text-[var(--c-ok)]" : c.ok === false ? "text-[var(--c-warn)]" : "text-[var(--c-text-faint)]"}`}>
                {c.ok === false ? <IconWarning size={15} /> : <IconCheck size={15} />}
              </span>
              <span className="min-w-0 break-words">{c.text}</span>
            </span>
          ))}
        </div>
      )}
      <div className="card grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 p-4 text-[13px]">
        <span className="text-[var(--c-text-muted)]">{t("Dossier")}</span>
        <span className="truncate">{groupId ? groupPath(groups, groupId) || t("dossier inconnu") : <span className="text-[var(--c-text-muted)]">{t("racine")}</span>}</span>
        <span className="text-[var(--c-text-muted)]">{t("Tags")}</span>
        {tags.length ? <span className="flex min-w-0 flex-wrap gap-1">{tags.map((t) => <span key={t} className="tag">{t}</span>)}</span> : <span className="text-[var(--c-text-muted)]">—</span>}
        {item.createdAt && <><span className="text-[var(--c-text-muted)]">{t("Créé")}</span><span className="truncate">{formatWhen(item.createdAt)}</span></>}
        <span className="text-[var(--c-text-muted)]">{t("Version")}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span>{item.revision}</span>
          {onHistory && <button onClick={onHistory} className="font-medium text-[var(--c-accent-text)] hover:underline">{t("historique")}</button>}
        </span>
      </div>
    </div>
  );
}

function nameOf(v: VaultItem): string {
  const e = payloadEntity(v.item.payload);
  return String(e.name ?? e.label ?? t("sans nom"));
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
