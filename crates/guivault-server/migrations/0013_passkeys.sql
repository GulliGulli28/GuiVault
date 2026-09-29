-- Connexion par passkey (docs/PASSKEYS.md). Le serveur garde la clé publique
-- de chaque passkey (pour vérifier ses signatures WebAuthn) et la user key
-- enveloppée sous une clé que seule la PRF de l'authentificateur donne : il
-- ne peut pas l'ouvrir.
CREATE TABLE passkeys (
    id                 uuid PRIMARY KEY,
    user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id      bytea NOT NULL UNIQUE,
    -- La clé publique en COSE, telle que l'authentificateur l'a donnée.
    public_key         bytea NOT NULL,
    sign_count         bigint NOT NULL DEFAULT 0,
    name               text NOT NULL,
    protected_user_key bytea NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_used_at       timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);

-- Les défis WebAuthn en cours : à usage unique, cinq minutes.
CREATE TABLE webauthn_challenges (
    id         uuid PRIMARY KEY,
    -- Le compte qui enregistre une passkey ; NULL pour une connexion.
    user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
    purpose    text NOT NULL CHECK (purpose IN ('register', 'login')),
    challenge  bytea NOT NULL,
    expires_at timestamptz NOT NULL
);
