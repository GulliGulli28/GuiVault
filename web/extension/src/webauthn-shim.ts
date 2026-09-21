/** Injecté dans le monde de la page (`world: MAIN`, avant ses scripts) :
 * remplace `navigator.credentials.create/get` pour proposer les passkeys du
 * coffre. Il ne fait que traduire la demande en JSON et la passer au script
 * isolé (`content.ts`) par `postMessage` ; la réponse est une assertion ou
 * une attestation toute faite, rendue sous la forme d'un
 * `PublicKeyCredential`. Quand GuiVault n'a rien à proposer (ou est
 * verrouillé), l'implémentation native reprend la main : la page ne voit
 * pas la différence. */

interface Reply {
  __guivault: "webauthn-reply";
  id: number;
  fallback?: boolean;
  error?: string;
  result?: Record<string, string>;
}

(() => {
  const creds = navigator.credentials;
  if (!creds || (window as unknown as { __guivaultShim?: boolean }).__guivaultShim) return;
  (window as unknown as { __guivaultShim?: boolean }).__guivaultShim = true;
  const origGet = creds.get.bind(creds);
  const origCreate = creds.create.bind(creds);

  const b64url = (b: ArrayBuffer | ArrayBufferView): string => {
    const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    let s = "";
    for (const x of u) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const fromB64url = (s: string): ArrayBuffer => {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };

  let seq = 0;
  const ask = (kind: "get" | "create", request: unknown): Promise<Reply> =>
    new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => { window.removeEventListener("message", on); resolve({ __guivault: "webauthn-reply", id, fallback: true }); }, 120_000);
      const on = (e: MessageEvent) => {
        const d = e.data as Reply | undefined;
        if (e.source !== window || !d || d.__guivault !== "webauthn-reply" || d.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", on);
        resolve(d);
      };
      window.addEventListener("message", on);
      window.postMessage({ __guivault: "webauthn", id, kind, request }, "*");
    });

  /** Un objet qui passe pour un `PublicKeyCredential` : mêmes propriétés,
   * même prototype (pour `instanceof`), `toJSON()` de la norme. */
  const credential = (id: string, response: Record<string, unknown>, responseProto: object | undefined, json: Record<string, unknown>) => {
    if (responseProto) {
      try { Object.setPrototypeOf(response, responseProto); } catch { /* prototype figé */ }
    }
    const cred: Record<string, unknown> = {
      id,
      rawId: fromB64url(id),
      type: "public-key",
      authenticatorAttachment: "platform",
      response,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({ id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {}, response: json }),
    };
    try { Object.setPrototypeOf(cred, PublicKeyCredential.prototype); } catch { /* idem */ }
    return cred as unknown as PublicKeyCredential;
  };

  creds.get = async function (options?: CredentialRequestOptions) {
    const pk = options?.publicKey;
    if (!pk || options?.mediation === "conditional" || options?.signal?.aborted) return origGet(options);
    const request = {
      rpId: pk.rpId ?? location.hostname,
      challenge: b64url(pk.challenge as ArrayBuffer),
      allowCredentials: (pk.allowCredentials ?? []).map((c) => b64url(c.id as ArrayBuffer)),
    };
    const r = await ask("get", request);
    if (r.fallback || !r.result) return origGet(options);
    if (r.error) throw new DOMException(r.error, "NotAllowedError");
    const a = r.result;
    const response = { clientDataJSON: fromB64url(a.clientDataJSON), authenticatorData: fromB64url(a.authenticatorData), signature: fromB64url(a.signature), userHandle: a.userHandle ? fromB64url(a.userHandle) : null };
    return credential(a.credentialId, response, typeof AuthenticatorAssertionResponse !== "undefined" ? AuthenticatorAssertionResponse.prototype : undefined, { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature, userHandle: a.userHandle });
  };

  creds.create = async function (options?: CredentialCreationOptions) {
    const pk = options?.publicKey;
    if (!pk || options?.signal?.aborted) return origCreate(options);
    if (!pk.pubKeyCredParams.some((p) => p.alg === -7)) return origCreate(options);
    const request = {
      rpId: pk.rp.id ?? location.hostname,
      rpName: pk.rp.name,
      userHandle: b64url(pk.user.id as ArrayBuffer),
      userName: pk.user.name,
      userDisplayName: pk.user.displayName,
      challenge: b64url(pk.challenge as ArrayBuffer),
      excludeCredentials: (pk.excludeCredentials ?? []).map((c) => b64url(c.id as ArrayBuffer)),
      discoverable: pk.authenticatorSelection?.residentKey === "required" || pk.authenticatorSelection?.residentKey === "preferred" || pk.authenticatorSelection?.requireResidentKey === true,
    };
    const r = await ask("create", request);
    if (r.fallback || !r.result) return origCreate(options);
    if (r.error) throw new DOMException(r.error, "NotAllowedError");
    const a = r.result;
    const response = {
      clientDataJSON: fromB64url(a.clientDataJSON),
      attestationObject: fromB64url(a.attestationObject),
      getTransports: () => ["internal", "hybrid"],
      getAuthenticatorData: () => fromB64url(a.authenticatorData),
      getPublicKey: () => fromB64url(a.publicKey),
      getPublicKeyAlgorithm: () => -7,
    };
    return credential(a.credentialId, response, typeof AuthenticatorAttestationResponse !== "undefined" ? AuthenticatorAttestationResponse.prototype : undefined, { clientDataJSON: a.clientDataJSON, attestationObject: a.attestationObject, transports: ["internal", "hybrid"], publicKey: a.publicKey, publicKeyAlgorithm: -7, authenticatorData: a.authenticatorData });
  };

  // Les sites vérifient ceci avant de proposer une passkey.
  if (typeof PublicKeyCredential !== "undefined") {
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
  }
})();

export {};
