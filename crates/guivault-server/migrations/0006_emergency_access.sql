-- Accès d'urgence : un utilisateur (le donneur) désigne un proche (le
-- contact) et lui enveloppe la clé de certains de ses vaults. Le serveur ne
-- remet ces enveloppes qu'après une demande du contact suivie du délai
-- d'attente sans refus (ou d'un accord anticipé du donneur).
CREATE TABLE emergency_grants (
    id           uuid PRIMARY KEY,
    grantor_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    grantee_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wait_days    integer NOT NULL CHECK (wait_days BETWEEN 1 AND 90),
    created_at   timestamptz NOT NULL DEFAULT now(),
    -- NULL tant que le contact n'a pas accepté.
    accepted_at  timestamptz,
    -- Demande d'accès en cours ; l'accès est ouvert à requested_at + wait_days,
    -- ou dès approved_at si le donneur accorde plus tôt.
    requested_at timestamptz,
    approved_at  timestamptz,
    UNIQUE (grantor_id, grantee_id),
    CHECK (grantor_id <> grantee_id)
);
CREATE INDEX emergency_grants_grantee_idx ON emergency_grants(grantee_id);

CREATE TABLE emergency_vault_keys (
    grant_id          uuid NOT NULL REFERENCES emergency_grants(id) ON DELETE CASCADE,
    vault_id          uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    -- `wrap_emergency_key` du donneur vers le contact ; NULL quand la clé du
    -- vault a tourné sans que le donneur ré-enveloppe (à renouveler).
    wrapped_vault_key bytea,
    PRIMARY KEY (grant_id, vault_id)
);
CREATE INDEX emergency_vault_keys_vault_idx ON emergency_vault_keys(vault_id);
