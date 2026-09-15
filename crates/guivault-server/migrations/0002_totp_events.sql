-- Second facteur TOTP. Le secret doit être lisible par le serveur pour
-- vérifier un code : il est chiffré au repos sous une clé dérivée de
-- GUIVAULT_SECRET (voir `routes::totp`), ce qui protège un dump de base
-- mais pas un serveur compromis — c'est un facteur d'authentification, pas
-- une donnée du coffre.
CREATE TABLE user_totp (
    user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc  bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- NULL tant que l'utilisateur n'a pas prouvé un premier code.
    enabled_at  timestamptz
);

-- Codes de récupération : hachés, à usage unique.
CREATE TABLE user_recovery_codes (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  bytea NOT NULL,
    used_at    timestamptz,
    PRIMARY KEY (user_id, code_hash)
);

-- Mot de passe validé, code attendu : un jeton court (5 min) fait le lien
-- entre les deux requêtes de connexion.
CREATE TABLE totp_challenges (
    token_hash   bytea PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name  text,
    ip           inet,
    attempts     integer NOT NULL DEFAULT 0,
    expires_at   timestamptz NOT NULL
);
