-- Clés de sécurité en second facteur (docs/PASSKEYS.md, « Clé de
-- sécurité ») : une passkey sans enveloppe de la user key. Elle ne peut pas
-- ouvrir le coffre, seulement prouver qu'on la tient, après le mot de passe
-- maître, à la place du code TOTP (qui reste le recours).
ALTER TABLE passkeys ALTER COLUMN protected_user_key DROP NOT NULL;

-- Un défi de second facteur : lié au compte dont le mot de passe vient
-- d'être vérifié (le jeton du défi TOTP en cours).
ALTER TABLE webauthn_challenges DROP CONSTRAINT webauthn_challenges_purpose_check;
ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_purpose_check
    CHECK (purpose IN ('register', 'login', 'second_factor'));
