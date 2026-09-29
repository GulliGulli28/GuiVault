/** Interopérabilité avec `guivault-crypto`. Les vecteurs viennent du crate
 * Rust (`cargo run -p guivault-crypto --example vectors`) ; dans l'autre
 * sens, `GUIVAULT_WRITE_VECTORS=1 npx vitest run` écrit
 * `crates/guivault-crypto/tests/web-vectors.json`, que le test Rust
 * `web_interop` ouvre. */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { fromHex, randomBytes, toHex, utf8, uuid } from "./bytes";
import * as c from "./crypto";
import { itemDigest, manifestOf, openManifest, sealManifest, verifyManifest } from "./manifest";
import vectors from "./crypto.vectors.json";

describe("guivault-crypto interop", () => {
  it("dérive les mêmes clés qu'Argon2id + HKDF côté Rust", async () => {
    const v = vectors.kdf;
    const m = await c.deriveMasterKey(v.password, fromHex(v.salt), v.params);
    expect(toHex(m.stretchedKey)).toBe(v.stretched_key);
    expect(toHex(m.authKey)).toBe(v.auth_key);
  });

  it("ouvre une enveloppe symétrique Rust et refuse un mauvais AAD", () => {
    const v = vectors.seal;
    const key = fromHex(v.key);
    expect(utf8.decode(c.open(key, fromHex(v.blob), utf8.encode(v.aad)))).toBe(v.plaintext);
    expect(() => c.open(key, fromHex(v.blob), utf8.encode("ctx-b"))).toThrow(c.CryptoError);
    const bad = fromHex(v.blob);
    bad[0] = 0x7f;
    expect(() => c.open(key, bad, utf8.encode(v.aad))).toThrowError(/format/);
  });

  it("ouvre une boîte scellée Rust et calcule la même empreinte", () => {
    const v = vectors.sealed_box;
    const kp = { privateKey: fromHex(v.private), publicKey: fromHex(v.public) };
    expect(toHex(c.generateKeyPair().publicKey)).toHaveLength(64);
    expect(utf8.decode(c.unseal(kp, fromHex(v.blob)))).toBe(v.plaintext);
    expect(c.fingerprint(kp.publicKey)).toBe(v.fingerprint);
  });

  it("déverrouille un compte créé par Rust", async () => {
    const v = vectors.account;
    const m = await c.deriveMasterKey(v.password, fromHex(v.kdf_salt), v.kdf);
    expect(toHex(m.authKey)).toBe(v.auth_key);
    const acc = c.unlockAccount(m.stretchedKey, fromHex(v.protected_user_key), fromHex(v.protected_private_key));
    expect(toHex(acc.userKey)).toBe(v.user_key);
    expect(toHex(acc.keypair.privateKey)).toBe(v.private_key);
    expect(toHex(acc.keypair.publicKey)).toBe(v.public_key);
    // Format 2 : la clé, et qui l'a enveloppée ; lié à son vault.
    const opened = c.unwrapVaultKey(acc, v.wrap_vault_id, fromHex(v.wrapped_vault_key));
    expect(toHex(opened.key)).toBe(vectors.item.vault_key);
    expect(opened.sender && toHex(opened.sender)).toBe(v.wrap_sender_public);
    expect(() => c.unwrapVaultKey(acc, "autre-vault", fromHex(v.wrapped_vault_key))).toThrow(c.CryptoError);
    // Format 1 (boîte scellée anonyme) : encore lisible, sans expéditeur.
    const legacy = c.unwrapVaultKey(acc, v.wrap_vault_id, fromHex(v.wrapped_vault_key_v1));
    expect(toHex(legacy.key)).toBe(vectors.item.vault_key);
    expect(legacy.sender).toBeNull();
    // Enveloppe d'urgence : même clé, même expéditeur, contexte à part.
    const emergency = c.unwrapEmergencyKey(acc, v.wrap_vault_id, fromHex(v.emergency_key));
    expect(toHex(emergency.key)).toBe(vectors.item.vault_key);
    expect(emergency.sender && toHex(emergency.sender)).toBe(v.wrap_sender_public);
    expect(() => c.unwrapVaultKey(acc, v.wrap_vault_id, fromHex(v.emergency_key))).toThrow(c.CryptoError);
    expect(() => c.unwrapEmergencyKey(acc, v.wrap_vault_id, fromHex(v.wrapped_vault_key))).toThrow(c.CryptoError);
    expect(() => c.unwrapEmergencyKey(acc, v.wrap_vault_id, fromHex(v.wrapped_vault_key_v1))).toThrowError(/format/);
  }, 30_000);

  it("ouvre un lien de partage Rust, avec et sans mot de passe", async () => {
    const v = vectors.send;
    const keys = c.sendKeys(fromHex(v.secret));
    expect(toHex(keys.access)).toBe(v.access_key);
    expect(toHex(c.sendAccessHash(keys))).toBe(v.access_hash);
    expect(utf8.decode(c.openSend(keys, v.id, fromHex(v.blob)))).toBe(v.plaintext);
    expect(() => c.openSend(keys, "autre-lien", fromHex(v.blob))).toThrow(c.CryptoError);
    const pw = await c.sendPasswordKey(v.password, fromHex(v.password_salt), v.password_kdf);
    const locked = c.sendKeys(fromHex(v.secret), pw);
    expect(toHex(locked.access)).toBe(v.locked_access_key);
    expect(utf8.decode(c.openSend(locked, v.id, fromHex(v.locked_blob)))).toBe(v.plaintext);
    expect(() => c.openSend(keys, v.id, fromHex(v.locked_blob))).toThrow(c.CryptoError);
    expect(c.openSendOwner(fromHex(v.owner_key), v.id, fromHex(v.owner_blob))).toBe(v.owner_plaintext);
    expect(() => c.sendKeys(new Uint8Array(8))).toThrow(c.CryptoError);
    await expect(c.sendPasswordKey("x", new Uint8Array(16), { m_cost: 8, t_cost: 1, p_cost: 1 })).rejects.toThrowError(/refusés/);
  }, 30_000);

  it("ouvre un item et un nom de vault chiffrés par Rust", () => {
    const v = vectors.item;
    const key = fromHex(v.vault_key);
    expect(utf8.decode(c.openItem(key, v.vault_id, v.item_id, v.item_type, fromHex(v.blob)))).toBe(v.plaintext);
    expect(() => c.openItem(key, v.vault_id, v.item_id, "group", fromHex(v.blob))).toThrow();
    expect(c.openVaultName(key, v.vault_id, fromHex(v.name_blob))).toBe(v.name);
  });

  it("ouvre et vérifie un manifeste scellé par Rust", () => {
    const v = vectors.manifest;
    const key = fromHex(v.vault_key);
    const blob = fromHex(v.blob);
    const m = openManifest(key, v.vault_id, blob);
    expect(m).toEqual({ v: 1, counter: v.counter, items: v.items });
    const served = [{ id: v.item_id, ciphertext: fromHex(v.item_blob) }, { id: v.other_id, ciphertext: fromHex(v.other_ciphertext) }];
    // Les empreintes d'ici sont celles de Rust (`item_digest`).
    for (const it of served) expect(itemDigest(it.ciphertext)).toBe((v.items as Record<string, string>)[it.id]);
    expect(verifyManifest(key, v.vault_id, { revision: v.counter, ciphertext: blob }, served, v.counter).problems).toEqual([]);
    expect(verifyManifest(key, v.vault_id, { revision: v.counter, ciphertext: blob }, served.slice(0, 1), null).problems).toEqual([{ kind: "withheld", itemId: v.other_id }]);
    expect(() => openManifest(key, "autre-vault", blob)).toThrow();
  });

  it("fait l'aller-retour sur ses propres primitives", async () => {
    const { material, account } = await c.createAccount("pw");
    const m = await c.deriveMasterKey("pw", material.kdfSalt, material.kdf);
    const again = c.unlockAccount(m.stretchedKey, material.protectedUserKey, material.protectedPrivateKey);
    expect(toHex(again.userKey)).toBe(toHex(account.userKey));
    const vk = new Uint8Array(32).fill(3);
    const own = c.unwrapVaultKey(again, "v-1", c.wrapVaultKey(again.keypair, material.publicKey, "v-1", vk));
    expect(toHex(own.key)).toBe(toHex(vk));
    expect(own.sender && toHex(own.sender)).toBe(toHex(material.publicKey));
    const rekey = await c.rekeyAccount(account, "pw2");
    const m2 = await c.deriveMasterKey("pw2", rekey.kdfSalt, rekey.kdf);
    expect(toHex(c.open(m2.stretchedKey, rekey.protectedUserKey, utf8.encode("guivault/v1/user-key")))).toBe(toHex(account.userKey));
  }, 60_000);

  it("refuse de dériver hors des bornes de `KdfParams::is_sane`", async () => {
    // Les cas du test Rust `kdf_params_bounds`, plus des valeurs non entières.
    expect(c.kdfParamsSane(c.DEFAULT_KDF)).toBe(true);
    expect(c.kdfParamsSane({ m_cost: 19_456, t_cost: 2, p_cost: 1 })).toBe(true);
    expect(c.kdfParamsSane({ m_cost: 1024, t_cost: 1, p_cost: 1 })).toBe(false);
    expect(c.kdfParamsSane({ m_cost: 65536, t_cost: 1, p_cost: 1 })).toBe(false);
    expect(c.kdfParamsSane({ m_cost: 65536.5, t_cost: 3, p_cost: 1 })).toBe(false);
    // Ce qu'un serveur compromis renverrait au prelogin, et de quoi figer l'onglet.
    const salt = new Uint8Array(16);
    for (const bad of [{ m_cost: 8, t_cost: 1, p_cost: 1 }, { m_cost: 4 * 1_048_576, t_cost: 3, p_cost: 1 }]) {
      await expect(c.deriveMasterKey("pw", salt, bad)).rejects.toThrowError(/refusés/);
      await expect(c.deriveExportKey("pw", salt, bad)).rejects.toThrowError(/refusés/);
    }
  });

  it("écrit des vecteurs pour le test Rust (GUIVAULT_WRITE_VECTORS)", async () => {
    if (!process.env.GUIVAULT_WRITE_VECTORS) return;
    const kdf = { m_cost: 19_456, t_cost: 2, p_cost: 1 };
    const password = "web → rust";
    const salt = utf8.encode("fedcba9876543210");
    const master = await c.deriveMasterKey(password, salt, kdf);
    const key = new Uint8Array(32).fill(5);
    const recipient = c.generateKeyPair();
    const sender = c.generateKeyPair();
    const vaultKey = new Uint8Array(32).fill(6);
    const vaultId = uuid();
    const itemId = uuid();
    const sendSecret = randomBytes(c.SEND_SECRET_LEN);
    const sendId = uuid();
    const sendSalt = randomBytes(16);
    const sendPassword = "lien du navigateur";
    const sendLocked = c.sendKeys(sendSecret, await c.sendPasswordKey(sendPassword, sendSalt, kdf));
    const ownerKey = new Uint8Array(32).fill(8);
    const itemBlob = c.sealItem(vaultKey, vaultId, itemId, "snippet", utf8.encode("{\"kind\":\"snippet\"}"));
    const otherId = uuid();
    const other = utf8.encode("abc");
    const manifest = manifestOf(7, [{ id: itemId, ciphertext: itemBlob }, { id: otherId, ciphertext: other }]);
    const out = {
      kdf: { password, salt: toHex(salt), params: kdf, stretched_key: toHex(master.stretchedKey), auth_key: toHex(master.authKey) },
      seal: { key: toHex(key), aad: "ctx-web", plaintext: "from the browser", blob: toHex(c.seal(key, utf8.encode("from the browser"), utf8.encode("ctx-web"))) },
      sealed_box: { private: toHex(recipient.privateKey), public: toHex(recipient.publicKey), fingerprint: c.fingerprint(recipient.publicKey), plaintext: "sealed by the browser", blob: toHex(c.sealFor(recipient.publicKey, utf8.encode("sealed by the browser"))) },
      vault_envelope: { sender_public: toHex(sender.publicKey), recipient_private: toHex(recipient.privateKey), vault_id: vaultId, vault_key: toHex(vaultKey), blob: toHex(c.wrapVaultKey(sender, recipient.publicKey, vaultId, vaultKey)), emergency_blob: toHex(c.wrapEmergencyKey(sender, recipient.publicKey, vaultId, vaultKey)) },
      send: {
        secret: toHex(sendSecret), id: sendId, plaintext: "partagé depuis le navigateur",
        access_hash: toHex(c.sendAccessHash(c.sendKeys(sendSecret))),
        blob: toHex(c.sealSend(c.sendKeys(sendSecret), sendId, utf8.encode("partagé depuis le navigateur"))),
        password: sendPassword, password_salt: toHex(sendSalt), password_kdf: kdf,
        locked_access_hash: toHex(c.sendAccessHash(sendLocked)),
        locked_blob: toHex(c.sealSend(sendLocked, sendId, utf8.encode("partagé depuis le navigateur"))),
        owner_key: toHex(ownerKey), owner_plaintext: "{\"name\":\"Clé\"}", owner_blob: toHex(c.sealSendOwner(ownerKey, sendId, "{\"name\":\"Clé\"}")),
      },
      item: { vault_key: toHex(vaultKey), vault_id: vaultId, item_id: itemId, item_type: "snippet", plaintext: "{\"kind\":\"snippet\"}", blob: toHex(itemBlob), name: "Équipe réseau", name_blob: toHex(c.sealVaultName(vaultKey, vaultId, "Équipe réseau")) },
      manifest: {
        vault_key: toHex(vaultKey), vault_id: vaultId, counter: manifest.counter, items: manifest.items,
        blob: toHex(sealManifest(vaultKey, vaultId, manifest)),
        item_id: itemId, item_blob: toHex(itemBlob), other_id: otherId, other_ciphertext: toHex(other),
      },
    };
    writeFileSync(new URL("../../../crates/guivault-crypto/tests/web-vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
  });
});
