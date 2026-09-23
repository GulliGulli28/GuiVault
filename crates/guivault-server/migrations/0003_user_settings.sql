-- Réglages synchronisés entre les appareils d'un utilisateur (apparence,
-- générateur, extension…). Un blob scellé sous la user key : le serveur ne
-- sait pas ce qu'il contient.
CREATE TABLE user_settings (
    user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    blob        bytea NOT NULL,
    revision    bigint NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
