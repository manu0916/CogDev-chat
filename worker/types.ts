export interface Env {
  DB: D1Database;
  CONVERSATIONS: DurableObjectNamespace;
  ADMIN_INBOX: DurableObjectNamespace;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  WHATSAPP_NUMBER: string;
  ENABLE_SAMPLE_PRICING: string;
  RETENTION_DAYS: string;
  RATE_LIMIT_SALT?: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  CF_ACCESS_ALLOWED_DOMAIN: string;
  ADMIN_BOOTSTRAP_EMAILS: string;
  C6_ALLOWED_PAYMENT_HOSTS: string;
  C6_CHECKOUT_ADAPTER_URL: string;
  C6_WEBHOOK_AUDIENCE: string;
  C6_CLIENT_ID?: string;
  C6_CLIENT_SECRET?: string;
  C6_WEBHOOK_SECRET?: string;
}

export type SessionRow = {
  id: number;
  public_id: string;
  status: 'in_progress' | 'submitted' | 'expired';
  current_step: number;
  expires_at: string;
  csrf_token_hash?: string | null;
};

export type StoredQuoteRow = {
  public_id: string;
  project_type: string;
  submitted_at: string;
  minimum_amount: number | null;
  maximum_amount: number | null;
  estimated_days_min: number | null;
  estimated_days_max: number | null;
  pricing_version: string | null;
};

export type ConversationRow = {
  id: number;
  public_id: string;
  quote_session_id: number;
  status: import('../shared/contracts').ConversationStatus;
  assigned_admin_id: number | null;
  last_message_at: string | null;
  client_last_read_at: string | null;
  admin_last_read_at: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  blocked_at: string | null;
};

export type AdminUser = {
  id: number;
  access_subject: string;
  email: string;
  display_name: string;
  role: import('../shared/contracts').AdminRole;
  active: number;
};
