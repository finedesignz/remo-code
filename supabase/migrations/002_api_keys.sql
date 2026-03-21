-- API Keys: user-level keys for plugin auto-registration

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

-- One active key per user
CREATE UNIQUE INDEX idx_api_keys_user_active ON api_keys(user_id) WHERE revoked_at IS NULL;
-- Fast lookup by hash for auth
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;

-- Unique constraint on sessions for upsert by project_dir
CREATE UNIQUE INDEX idx_sessions_user_project ON sessions(user_id, project_dir) WHERE project_dir IS NOT NULL;

-- RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY api_keys_select ON api_keys FOR SELECT USING (user_id = auth.uid());
CREATE POLICY api_keys_insert ON api_keys FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY api_keys_update ON api_keys FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY api_keys_delete ON api_keys FOR DELETE USING (user_id = auth.uid());
