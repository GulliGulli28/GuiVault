-- Administration du serveur. Le rôle se donne depuis le shell du serveur
-- (`guivault admin grant <email>`), jamais par l'API : une session
-- d'administrateur volée ne peut pas en fabriquer d'autres.
ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- Quota de stockage : octets de chiffrés vivants dans les vaults que le
-- compte possède. NULL : celui du serveur (GUIVAULT_QUOTA_MB) ; 0 : aucun.
ALTER TABLE users ADD COLUMN quota_bytes bigint CHECK (quota_bytes >= 0);

-- Inscriptions ouvertes par un administrateur, une adresse à la fois (modes
-- `invite_only` et `closed`). Consommée à l'inscription.
CREATE TABLE registration_invites (
    email       citext PRIMARY KEY,
    invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);
