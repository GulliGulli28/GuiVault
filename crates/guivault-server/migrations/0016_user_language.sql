-- La langue de l'interface du compte (`PUT /users/me/language`), réglée
-- par les clients : celle des e-mails qu'on lui envoie (`mail.rs`). Inconnue
-- (NULL) : les deux langues.
ALTER TABLE users ADD COLUMN language text CHECK (language IN ('fr', 'en'));
