PRAGMA foreign_keys = ON;

CREATE TABLE quote_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  access_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted', 'expired')) DEFAULT 'in_progress',
  current_step INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  pricing_version TEXT
);

CREATE TABLE quote_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  question_key TEXT NOT NULL,
  answer_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES quote_sessions(id) ON DELETE CASCADE,
  UNIQUE (session_id, question_key)
);

CREATE TABLE quote_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  company TEXT,
  email_normalized TEXT,
  phone_normalized TEXT,
  project_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'reviewing', 'contacted', 'closed')) DEFAULT 'received',
  consent_at TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES quote_sessions(id) ON DELETE CASCADE
);

CREATE TABLE quote_estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL UNIQUE,
  minimum_amount INTEGER NOT NULL,
  maximum_amount INTEGER NOT NULL,
  estimated_days_min INTEGER NOT NULL,
  estimated_days_max INTEGER NOT NULL,
  pricing_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES quote_sessions(id) ON DELETE CASCADE
);

CREATE TABLE rate_limits (
  rate_key TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (rate_key, bucket_start)
);

CREATE INDEX idx_quote_sessions_status_expires
  ON quote_sessions(status, expires_at);
CREATE INDEX idx_quote_answers_session
  ON quote_answers(session_id);
CREATE INDEX idx_quote_requests_submitted
  ON quote_requests(submitted_at);
CREATE INDEX idx_rate_limits_expires
  ON rate_limits(expires_at);
