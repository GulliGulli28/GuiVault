/** Le déverrouillage biométrique de l'application Android (`platform.ts`,
 * `BiometricBridge`, `docs/ANDROID.md`).
 *
 * Ce qui est confié au Keystore : la user key et le compte enveloppé
 * (`AccountBlobs`, déjà chiffré) — de quoi rouvrir sans mot de passe. Un
 * coffre local se rouvre ainsi même après avoir quitté l'application ; un
 * compte du serveur, tant que sa session (les jetons) est vivante. Le mot de
 * passe maître reste demandé après un redémarrage du téléphone et au bout
 * de 14 jours sans lui (`BiometricPlugin.kt`). */
import { useCallback, useEffect, useRef, useState } from "react";
import { baseUrl } from "./api";
import { fromBase64, toBase64, utf8 } from "./bytes";
import type { LocalHost } from "./localHost";
import { biometricBridge, type BiometricPasswordReason } from "./platform";
import { openLocalWithUserKey, resumeWithUserKey, type AccountBlobs, type LockedTarget, type SessionState } from "./session";
import { t, translated } from "./i18n";

export { biometricBridge };

/** La clé d'un coffre local, ou d'un compte sur un serveur. */
export function localBiometricId(path: string): string {
  return `local:${path}`;
}

export function serverBiometricId(userId: string): string {
  return `server:${baseUrl()}:${userId}`;
}

export function biometricId(state: SessionState): string | null {
  if (state.offline) return null;
  return state.local ? localBiometricId(state.local.path) : serverBiometricId(state.user.id);
}

export function targetBiometricId(t: LockedTarget): string {
  return t.kind === "local" ? localBiometricId(t.path) : serverBiometricId(t.userId);
}

interface Sealed {
  v: 1;
  user_key: string;
  blobs: AccountBlobs;
}

/** Après un déverrouillage par mot de passe : le délai avant de le
 * redemander repart. */
export function touchBiometric(state: SessionState): void {
  const b = biometricBridge();
  const id = biometricId(state);
  if (b && id) void b.touch(id).catch(() => {});
}

export const PASSWORD_REASONS: Record<BiometricPasswordReason, string> = translated({
  reboot: "Mot de passe requis après un redémarrage",
  age: "Mot de passe requis tous les 14 jours",
});

export type BiometricUnlock<T> = { kind: "ok"; value: T } | { kind: "cancel" } | { kind: "password"; message: string };

const FAILURES: Record<string, string> = translated({
  lockout: "Trop d'essais : utilisez le mot de passe maître.",
  invalidated: "Les empreintes du téléphone ont changé : le mot de passe maître, puis réactivez la biométrie.",
  none: "La biométrie n'est plus activée pour ce coffre.",
  password: "Le mot de passe maître est requis.",
});

async function openSealed(id: string, subtitle?: string): Promise<BiometricUnlock<Sealed>> {
  const b = biometricBridge();
  if (!b) return { kind: "password", message: FAILURES.none };
  const r = await b.unlock(id, subtitle);
  if (!r.ok) {
    if (r.reason === "cancel") return { kind: "cancel" };
    if (r.reason === "password") return { kind: "password", message: PASSWORD_REASONS[r.message as BiometricPasswordReason] ?? FAILURES.password };
    return { kind: "password", message: FAILURES[r.reason] ?? r.message ?? t("Échec de la biométrie.") };
  }
  const bytes = fromBase64(r.secret);
  try {
    return { kind: "ok", value: JSON.parse(utf8.decode(bytes)) as Sealed };
  } finally {
    bytes.fill(0);
  }
}

/** Rouvre un coffre local par la biométrie. */
export async function unlockLocalWithBiometric(host: LocalHost, path: string, subtitle?: string): Promise<BiometricUnlock<SessionState>> {
  const r = await openSealed(localBiometricId(path), subtitle);
  if (r.kind !== "ok") return r;
  const key = fromBase64(r.value.user_key);
  return { kind: "ok", value: await openLocalWithUserKey(host, path, key) };
}

/** Rouvre un compte du serveur verrouillé (jetons encore valides). */
export async function unlockServerWithBiometric(userId: string, subtitle?: string): Promise<BiometricUnlock<SessionState>> {
  const r = await openSealed(serverBiometricId(userId), subtitle);
  if (r.kind !== "ok") return r;
  const key = fromBase64(r.value.user_key);
  return { kind: "ok", value: await resumeWithUserKey(key, r.value.blobs) };
}

/** L'état d'un coffre vu de l'écran de déverrouillage : `undefined` tant
 * qu'on ne sait pas, `null` sans biométrie ; sinon prête, ou le mot de
 * passe d'abord (et pourquoi). */
export function useBiometricState(id: string | null): { ready: boolean; password?: string } | null | undefined {
  const [state, setState] = useState<{ ready: boolean; password?: string } | null | undefined>(() => (biometricBridge() && id ? undefined : null));
  useEffect(() => {
    const b = biometricBridge();
    if (!b || !id) return;
    let alive = true;
    void Promise.all([b.status(), b.state(id)]).then(([status, s]) => {
      if (!alive) return;
      if (!s.enabled || status !== "ready") setState(null);
      else setState(s.password ? { ready: false, password: PASSWORD_REASONS[s.password] } : { ready: true });
    }, () => { if (alive) setState(null); });
    return () => { alive = false; };
  }, [id]);
  return state;
}

/** L'invite s'ouvre d'elle-même dès que l'écran est visible — et de nouveau
 * en revenant dans l'application. */
export function useAutoPrompt(ready: boolean, run: () => void): void {
  const asked = useRef(false);
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!ready) return;
    const go = () => {
      if (document.visibilityState === "hidden") {
        asked.current = false;
      } else if (!asked.current) {
        asked.current = true;
        latest.current();
      }
    };
    go();
    document.addEventListener("visibilitychange", go);
    return () => document.removeEventListener("visibilitychange", go);
  }, [ready]);
}

/** Le réglage, pour la session ouverte : `null` hors de l'app Android. */
export function useBiometricSetting(session: SessionState): {
  status: "ready" | "not-enrolled" | "unavailable";
  enabled: boolean;
  busy: boolean;
  toggle: () => Promise<string | null>;
} | null {
  const id = biometricId(session);
  const [status, setStatus] = useState<"ready" | "not-enrolled" | "unavailable" | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => {
    const b = biometricBridge();
    if (!b || !id) return;
    void Promise.all([b.status(), b.state(id)]).then(([st, s]) => { setStatus(st); setEnabled(s.enabled); }, () => {});
  }, [id]);
  useEffect(() => {
    read();
    // Une empreinte ajoutée dans les réglages d'Android, entre-temps.
    const onVisible = () => { if (document.visibilityState === "visible") read(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [read]);
  const toggle = useCallback(async (): Promise<string | null> => {
    const b = biometricBridge();
    if (!b || !id) return null;
    setBusy(true);
    try {
      if (enabled) {
        await b.disable(id);
        setEnabled(false);
        return null;
      }
      if (!session.blobs) return t("Reconnectez-vous avec le mot de passe maître pour l'activer.");
      const sealed: Sealed = { v: 1, user_key: toBase64(session.account.userKey), blobs: session.blobs };
      const bytes = utf8.encode(JSON.stringify(sealed));
      const r = await b.enable(id, toBase64(bytes));
      bytes.fill(0);
      if (r.ok) {
        setEnabled(true);
        return null;
      }
      return r.reason === "cancel" ? null : FAILURES[r.reason] ?? r.message ?? t("Échec de la biométrie.");
    } finally {
      setBusy(false);
    }
  }, [enabled, id, session]);
  if (!biometricBridge() || !id || status === null) return null;
  return { status, enabled, busy, toggle };
}
