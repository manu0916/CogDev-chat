PRAGMA foreign_keys = ON;

ALTER TABLE quote_sessions ADD COLUMN csrf_token_hash TEXT;

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  quote_session_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'bot_collecting', 'waiting_admin', 'active', 'waiting_client',
    'resolved', 'blocked', 'expired'
  )) DEFAULT 'bot_collecting',
  assigned_admin_id INTEGER,
  last_message_at TEXT,
  client_last_read_at TEXT,
  admin_last_read_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  blocked_at TEXT,
  FOREIGN KEY (quote_session_id) REFERENCES quote_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_admin_id) REFERENCES admin_users(id) ON DELETE SET NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('client', 'assistant', 'admin', 'system')),
  sender_id INTEGER,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'system_event')) DEFAULT 'text',
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  client_message_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, sender_type, client_message_id)
);

CREATE TABLE internal_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  admin_id INTEGER NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE RESTRICT
);

CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'agent', 'viewer')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)) DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('client', 'admin', 'system')),
  actor_id INTEGER,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversations_status_activity ON conversations(status, last_message_at DESC);
CREATE INDEX idx_conversations_assignee ON conversations(assigned_admin_id, status);
CREATE INDEX idx_messages_conversation_sequence ON messages(conversation_id, sequence DESC);
CREATE INDEX idx_messages_client_id ON messages(conversation_id, client_message_id);
CREATE INDEX idx_internal_notes_conversation ON internal_notes(conversation_id, created_at DESC);
CREATE INDEX idx_events_conversation ON conversation_events(conversation_id, created_at DESC);
