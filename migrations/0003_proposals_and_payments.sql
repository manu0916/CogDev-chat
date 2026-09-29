PRAGMA foreign_keys = ON;

CREATE TABLE proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  conversation_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  scope_summary TEXT NOT NULL,
  total_amount INTEGER NOT NULL CHECK (total_amount >= 100),
  deposit_amount INTEGER NOT NULL CHECK (deposit_amount >= 100 AND deposit_amount <= total_amount),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  estimated_deadline TEXT NOT NULL,
  payment_terms TEXT NOT NULL,
  max_installments INTEGER NOT NULL CHECK (max_installments BETWEEN 1 AND 12),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('manual_payment_link', 'c6_checkout_api')),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'awaiting_client_approval', 'approved', 'awaiting_payment',
    'payment_confirmed', 'payment_failed', 'expired', 'cancelled'
  )) DEFAULT 'draft',
  valid_until TEXT NOT NULL,
  accepted_at TEXT,
  acceptance_ip_hash TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES admin_users(id) ON DELETE RESTRICT,
  UNIQUE (conversation_id, version)
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  proposal_id INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('manual_c6', 'c6_checkout_api')),
  provider_payment_id TEXT,
  amount INTEGER NOT NULL CHECK (amount >= 100),
  status TEXT NOT NULL CHECK (status IN ('created', 'awaiting_payment', 'confirmed', 'failed', 'expired', 'cancelled')) DEFAULT 'created',
  payment_url TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
);

CREATE TABLE payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
  UNIQUE (payment_id, provider_event_id)
);

CREATE INDEX idx_proposals_conversation_version ON proposals(conversation_id, version DESC);
CREATE INDEX idx_proposals_status_validity ON proposals(status, valid_until);
CREATE INDEX idx_payments_proposal_status ON payments(proposal_id, status, created_at DESC);
CREATE INDEX idx_payments_provider_id ON payments(provider, provider_payment_id);
CREATE INDEX idx_payment_events_provider_event ON payment_events(provider_event_id);
