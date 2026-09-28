-- Sauvegardes intégrées (`src/backup.rs`) : une ligne par passage, pour que
-- l'administration sache si la dernière a réussi, et jusqu'où elle a été
-- vérifiée.
CREATE TABLE backup_runs (
    id          bigserial PRIMARY KEY,
    triggered_by text NOT NULL CHECK (triggered_by IN ('schedule', 'admin', 'shell')),
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    file        text,
    bytes       bigint,
    row_count   bigint,
    sha256      text,
    -- 'file' : relue et contrôlée ligne à ligne ; 'restore' : restaurée en
    -- plus dans une base d'essai et re-sauvegardée à l'identique.
    verified    text CHECK (verified IN ('file', 'restore')),
    error       text
);
CREATE INDEX backup_runs_started_idx ON backup_runs(started_at DESC);
