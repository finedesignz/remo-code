-- Allow multiple sessions from the same project directory.
-- Previously a unique index prevented two Claude Code instances
-- in the same folder from having separate sessions.

DROP INDEX IF EXISTS idx_sessions_user_project;

-- Keep a regular index for lookup performance (non-unique)
CREATE INDEX idx_sessions_user_project ON sessions(user_id, project_dir)
  WHERE project_dir IS NOT NULL;
