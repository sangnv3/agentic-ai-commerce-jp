-- Chat history: sessions survive Redis expiry (state = full agent conversation, used to resume),
-- and chat_messages holds the transcript shown in the UI.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS state JSONB;

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'event')),
  text TEXT,
  data JSONB,                         -- item cards, quick replies, confirmation / order references
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages (session_id, message_id);
CREATE INDEX IF NOT EXISTS chat_sessions_user_idx ON chat_sessions (user_id, last_activity_at DESC);
