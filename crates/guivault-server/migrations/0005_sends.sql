-- Liens de partage éphémères. Le contenu est chiffré sous une clé tirée d'un
-- secret qui ne voyage que dans le fragment de l'URL : le serveur garde le
-- chiffré, l'expiration et le compte des vues, sans pouvoir le lire. Il ne
-- le remet qu'à qui présente la clé d'accès (dont il ne garde que le SHA-256).
CREATE TABLE sends (
    -- Choisi par le client : il est dans l'AAD du contenu.
    id              uuid PRIMARY KEY,
    owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- NULL une fois les vues épuisées : le serveur ne garde pas ce qu'il ne
    -- doit plus servir.
    ciphertext      bytea,
    access_hash     bytea NOT NULL,
    -- Nom et secret du lien, sous la user key de l'auteur.
    owner_blob      bytea NOT NULL,
    -- Mot de passe facultatif : de quoi le dériver côté destinataire.
    password_m_cost integer,
    password_t_cost integer,
    password_p_cost integer,
    password_salt   bytea,
    max_views       integer CHECK (max_views IS NULL OR max_views > 0),
    views           integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    last_viewed_at  timestamptz
);
CREATE INDEX sends_owner_idx ON sends(owner_id, created_at DESC);
CREATE INDEX sends_expires_idx ON sends(expires_at);
