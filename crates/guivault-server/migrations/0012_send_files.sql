-- Liens de partage avec un fichier (docs/PIECES-JOINTES.md) : le fichier en
-- morceaux, chiffrés sous la clé du lien. Ouvrir le lien consomme une vue et
-- donne un jeton de téléchargement d'une heure (seul son SHA-256 est gardé) :
-- les morceaux se téléchargent sans consommer d'autre vue, et restent le
-- temps qu'un jeton vit, même après la dernière vue.
ALTER TABLE sends
    ADD COLUMN file_size     bigint CHECK (file_size IS NULL OR file_size >= 0),
    ADD COLUMN file_chunks   integer CHECK (file_chunks IS NULL OR file_chunks > 0),
    ADD COLUMN file_complete boolean NOT NULL DEFAULT false;

CREATE TABLE send_chunks (
    send_id    uuid NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
    idx        integer NOT NULL CHECK (idx >= 0),
    ciphertext bytea NOT NULL,
    PRIMARY KEY (send_id, idx)
);

CREATE TABLE send_downloads (
    token_hash bytea PRIMARY KEY,
    send_id    uuid NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX send_downloads_send_idx ON send_downloads(send_id, expires_at);
