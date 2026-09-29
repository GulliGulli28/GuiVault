-- Pièces jointes (docs/PIECES-JOINTES.md) : des fichiers chiffrés en morceaux
-- sous une clé propre à chacun, gardée dans l'item qui les porte. Le serveur
-- garde les morceaux sans pouvoir les lire ; il sait à quel item une pièce
-- jointe est rattachée (pour l'effacer avec lui) et sa taille (pour le quota).
CREATE TABLE attachments (
    vault_id    uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    -- Choisi par le client : il est dans l'AAD de chaque morceau.
    id          uuid NOT NULL,
    item_id     uuid NOT NULL,
    -- Taille chiffrée totale annoncée, vérifiée quand l'envoi est complet.
    size_bytes  bigint NOT NULL CHECK (size_bytes >= 0),
    chunk_count integer NOT NULL CHECK (chunk_count > 0),
    -- Tous les morceaux reçus : téléchargeable. Une pièce jointe restée
    -- incomplète un jour est effacée.
    complete    boolean NOT NULL DEFAULT false,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (vault_id, id)
);
CREATE INDEX attachments_item_idx ON attachments(vault_id, item_id);

CREATE TABLE attachment_chunks (
    vault_id      uuid NOT NULL,
    attachment_id uuid NOT NULL,
    idx           integer NOT NULL CHECK (idx >= 0),
    ciphertext    bytea NOT NULL,
    PRIMARY KEY (vault_id, attachment_id, idx),
    -- ON UPDATE : une pièce jointe qui suit son item dans un autre vault
    -- emmène ses morceaux.
    FOREIGN KEY (vault_id, attachment_id) REFERENCES attachments(vault_id, id)
        ON DELETE CASCADE ON UPDATE CASCADE
);
