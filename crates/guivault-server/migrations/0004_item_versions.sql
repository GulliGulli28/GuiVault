-- Versions précédentes des items : l'historique (ce qu'un item était avant
-- chaque modification) et la corbeille (la dernière version d'un item
-- supprimé). Des blobs chiffrés comme les items, sous la même clé et le même
-- AAD : le serveur ne les lit pas plus.
CREATE TABLE item_versions (
    vault_id    uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    item_id     uuid NOT NULL,
    -- La révision de l'item quand cette version était la sienne.
    revision    bigint NOT NULL,
    item_type   text NOT NULL,
    ciphertext  bytea NOT NULL,
    written_at  timestamptz NOT NULL,
    -- Remplacée (ou supprimée) quand, par qui (NULL : compte supprimé).
    replaced_at timestamptz NOT NULL DEFAULT now(),
    replaced_by uuid REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (vault_id, item_id, revision)
);
