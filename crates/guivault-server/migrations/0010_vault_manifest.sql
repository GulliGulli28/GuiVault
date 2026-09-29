-- Le manifeste d'un vault (`guivault_crypto::manifest`) : un blob chiffré
-- sous la clé du vault, que le serveur ne lit pas. NULL : vault d'avant les
-- manifestes (un client capable l'y met). `manifest_revision` : verrou
-- optimiste, égal au compteur scellé dedans.
ALTER TABLE vaults ADD COLUMN manifest bytea;
ALTER TABLE vaults ADD COLUMN manifest_revision bigint NOT NULL DEFAULT 0;
