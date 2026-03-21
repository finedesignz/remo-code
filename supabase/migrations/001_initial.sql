-- Remo Code: Initial schema
-- Run this in Supabase SQL Editor

-- Claude Code sessions (one per connected project)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  project_dir TEXT,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'thinking')),
  token_hash TEXT NOT NULL,
  last_activity TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);

-- Row Level Security
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Users can only see/manage their own sessions
CREATE POLICY sessions_select ON sessions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY sessions_insert ON sessions FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY sessions_update ON sessions FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY sessions_delete ON sessions FOR DELETE USING (user_id = auth.uid());

-- Users can only see/manage messages in their own sessions
CREATE POLICY messages_select ON messages FOR SELECT
  USING (session_id IN (SELECT id FROM sessions WHERE user_id = auth.uid()));
CREATE POLICY messages_insert ON messages FOR INSERT
  WITH CHECK (session_id IN (SELECT id FROM sessions WHERE user_id = auth.uid()));
CREATE POLICY messages_delete ON messages FOR DELETE
  USING (session_id IN (SELECT id FROM sessions WHERE user_id = auth.uid()));
