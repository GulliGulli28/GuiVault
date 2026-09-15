-- Schéma initial GuiVault. Tout ce qui est `bytea` et nommé `protected_*`,
-- `wrapped_*`, `*_enc` ou `ciphertext` est un blob opaque chiffré côté client :
-- le serveur ne possède aucune clé capable de l'ouvrir.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id                    uuid PRIMARY KEY,
    email                 citext NOT NULL UNIQUE,
    -- Argon2id côté client : paramètres + sel, renvoyés au prelogin.
    kdf_m_cost            integer NOT NULL,
    kdf_t_cost            integer NOT NULL,
    kdf_p_cost            integer NOT NULL,
    kdf_salt              bytea NOT NULL,
    -- Chaîne PHC Argon2id de la clé d'authentification (jamais la clé elle-même).
    auth_hash             text NOT NULL,
    protected_user_key    bytea NOT NULL,
    public_key            bytea NOT NULL,
    protected_private_key bytea NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    disabled_at           timestamptz
);

-- Jetons opaques : seul leur SHA-256 est stocké. L'accès expire vite (minutes),
-- le rafraîchissement tourne à chaque usage.
CREATE TABLE sessions (
    id                  uuid PRIMARY KEY,
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_token_hash   bytea NOT NULL UNIQUE,
    refresh_token_hash  bytea NOT NULL UNIQUE,
    -- Hash du jeton de rafraîchissement précédent : le représenter après
    -- rotation trahit un vol de jeton → la session entière est révoquée.
    prev_refresh_token_hash bytea,
    device_name         text,
    user_agent          text,
    ip                  inet,
    access_expires_at   timestamptz NOT NULL,
    refresh_expires_at  timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE vaults (
    id          uuid PRIMARY KEY,
    kind        text NOT NULL CHECK (kind IN ('personal', 'shared')),
    name_enc    bytea NOT NULL,
    -- Compteur monotone par vault, avancé à chaque écriture d'item.
    revision    bigint NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vault_members (
    vault_id          uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role              text NOT NULL CHECK (role IN ('reader', 'writer', 'admin', 'owner')),
    -- Clé du vault scellée vers la clé publique de ce membre.
    wrapped_vault_key bytea NOT NULL,
    added_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    added_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, user_id)
);
CREATE INDEX vault_members_user_idx ON vault_members(user_id);
-- Un seul propriétaire par vault.
CREATE UNIQUE INDEX vault_members_one_owner ON vault_members(vault_id) WHERE role = 'owner';

-- L'identifiant d'un item est choisi par le client et n'a de sens que dans
-- son vault (il est dans l'AAD du chiffré) : clé primaire composite, pour
-- qu'un déplacement d'un vault à l'autre laisse une tombale dans l'ancien et
-- crée l'item dans le nouveau sous le même id.
CREATE TABLE items (
    id          uuid NOT NULL,
    vault_id    uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    item_type   text NOT NULL,
    -- Révision du vault au moment de la dernière écriture de cet item.
    revision    bigint NOT NULL,
    ciphertext  bytea NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- Pierre tombale : conservée pour que les autres clients suppriment aussi.
    deleted_at  timestamptz,
    PRIMARY KEY (vault_id, id)
);
CREATE INDEX items_vault_revision_idx ON items(vault_id, revision);

CREATE TABLE invitations (
    id                 uuid PRIMARY KEY,
    vault_id           uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    inviter_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_email      citext NOT NULL,
    role               text NOT NULL CHECK (role IN ('reader', 'writer', 'admin')),
    -- NULL tant que l'inviteur n'a pas pu envelopper (invité pas encore inscrit).
    wrapped_vault_key  bytea,
    status             text NOT NULL CHECK (status IN ('pending', 'awaiting_key', 'accepted', 'declined', 'expired', 'revoked')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    resolved_at        timestamptz
);
CREATE INDEX invitations_invitee_idx ON invitations(invitee_email) WHERE status IN ('pending', 'awaiting_key');
CREATE INDEX invitations_vault_idx ON invitations(vault_id);
-- Une seule invitation active par (vault, e-mail).
CREATE UNIQUE INDEX invitations_active_unique ON invitations(vault_id, invitee_email) WHERE status IN ('pending', 'awaiting_key');

-- Journal d'audit, en ajout seul. Les métadonnées ne contiennent jamais de
-- secret (il n'y en a aucun côté serveur) mais peuvent nommer des ids.
CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    actor_id    uuid,
    vault_id    uuid,
    action      text NOT NULL,
    target      text,
    ip          inet,
    metadata    jsonb
);
CREATE INDEX audit_log_vault_idx ON audit_log(vault_id, at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_id, at DESC);
