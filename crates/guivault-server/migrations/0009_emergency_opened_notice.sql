-- L'accès d'urgence qui s'ouvre à la fin du délai : prévenu une fois
-- (`routes::emergency::notify_opened`), remis à zéro à chaque demande.
ALTER TABLE emergency_grants ADD COLUMN opened_notice_at timestamptz;
