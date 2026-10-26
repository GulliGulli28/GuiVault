-- Mode voyage (docs/ARCHITECTURE.md, « Mode voyage ») : le compte en voyage
-- ne voit plus que les vaults qu'il a marqués « sûrs en voyage » — les
-- autres disparaissent de ses appareils à leur prochaine synchronisation,
-- et le serveur répond 404 pour eux comme pour un vault inconnu.
ALTER TABLE users ADD COLUMN travel_mode boolean NOT NULL DEFAULT false;
-- Par appartenance : chacun choisit pour lui ce qu'il emporte.
ALTER TABLE vault_members ADD COLUMN travel_safe boolean NOT NULL DEFAULT false;
