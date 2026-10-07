import type { ChatMessage, ConversationStatus } from './api';
import { websocketUrl } from './api';

export type AdminMe = { displayName: string; email: string; role: 'owner' | 'admin' | 'agent' | 'viewer' };

export type InboxConversation = {
  publicId: string;
  status: ConversationStatus;
  name: string;
  company: string | null;
  projectType: string;
  assignedTo: string | null;
  lastMessage: string | null;
  lastMessageAt: string;
  unreadCount: number;
  clientPresence: 'seen_recently' | 'offline';
};

export type AdminConversationDetail = {
  conversation: Record<string, any> & {
    publicId: string;
    status: ConversationStatus;
    assignedAdminId: number | null;
    assigned_to: string | null;
    quote_code: string;
    name?: string;
    company?: string;
    project_type?: string;
    email_normalized?: string;
    phone_normalized?: string;
    minimum_amount?: number;
    maximum_amount?: number;
  };
  briefing: Record<string, unknown>;
};

export type InternalNote = { id: string; body: string; createdAt: string; author: string };

export type ProposalInput = {
  totalAmount: number;
  depositAmount: number;
  scopeSummary: string;
  estimatedDeadline: string;
  paymentTerms: string;
  maxInstallments: number;
  validUntil: string;
  paymentMode: 'manual_payment_link' | 'c6_checkout_api';
  manualPaymentUrl?: string;
};

export type AdminApiFieldError = { field: string; message: string };

export class AdminApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public details?: AdminApiFieldError[],
  ) { super(message); }
}

const call = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => null) as { error?: { message?: string; code?: string; details?: AdminApiFieldError[] } } | null;
  if (!response.ok) throw new AdminApiError(body?.error?.message || 'Não foi possível concluir esta ação.', body?.error?.code || 'REQUEST_FAILED', response.status, body?.error?.details);
  return body as T;
};

export const adminApi = {
  me: () => call<AdminMe>('/api/admin/me'),
  list: (filter: string, query: string, page = 0) => {
    const params = new URLSearchParams({ filter, page: String(page) });
    if (query.trim()) params.set('q', query.trim());
    return call<{ conversations: InboxConversation[]; page: number; hasMore: boolean }>(`/api/admin/conversations?${params}`);
  },
  detail: (publicId: string) => call<AdminConversationDetail>(`/api/admin/conversations/${encodeURIComponent(publicId)}`),
  messages: (publicId: string, options?: { after?: number; before?: string }) => {
    const params = new URLSearchParams();
    if (options?.after !== undefined) params.set('after', String(options.after));
    if (options?.before) params.set('before', options.before);
    return call<{ messages: ChatMessage[]; notes: InternalNote[]; nextCursor: string | null; status: ConversationStatus }>(
      `/api/admin/conversations/${encodeURIComponent(publicId)}/messages${params.size ? `?${params}` : ''}`,
    );
  },
  send: (publicId: string, body: string, clientMessageId: string) => call<{ message: ChatMessage }>(
    `/api/admin/conversations/${encodeURIComponent(publicId)}/messages`,
    { method: 'POST', body: JSON.stringify({ body, clientMessageId }) },
  ),
  assign: (publicId: string) => call<{ status: ConversationStatus }>(`/api/admin/conversations/${encodeURIComponent(publicId)}/assign`, { method: 'POST', body: '{}' }),
  status: (publicId: string, status: ConversationStatus) => call<{ status: ConversationStatus }>(
    `/api/admin/conversations/${encodeURIComponent(publicId)}/status`,
    { method: 'POST', body: JSON.stringify({ status }) },
  ),
  read: (publicId: string) => call<{ read: boolean }>(`/api/admin/conversations/${encodeURIComponent(publicId)}/read`, { method: 'POST', body: '{}' }),
  note: (publicId: string, body: string) => call<{ saved: boolean; createdAt: string }>(
    `/api/admin/conversations/${encodeURIComponent(publicId)}/notes`,
    { method: 'POST', body: JSON.stringify({ body }) },
  ),
  proposal: (publicId: string) => call<{ proposal: import('./api').Proposal | null }>(`/api/admin/conversations/${encodeURIComponent(publicId)}/proposals`),
  createProposal: (publicId: string, input: ProposalInput) => call<{ proposal: import('./api').Proposal }>(
    `/api/admin/conversations/${encodeURIComponent(publicId)}/proposals`,
    { method: 'POST', body: JSON.stringify(input) },
  ),
  replacePaymentLink: (publicId: string, paymentUrl: string, expiresAt?: string) => call<{ updated: boolean }>(
    `/api/admin/conversations/${encodeURIComponent(publicId)}/payment-link`,
    { method: 'POST', body: JSON.stringify({ paymentUrl, ...(expiresAt ? { expiresAt } : {}) }) },
  ),
  setPaymentStatus: (publicId: string, status: 'confirmed' | 'failed') => call<{ status: string }>(
    `/api/admin/conversations/${encodeURIComponent(publicId)}/payment-status`,
    { method: 'POST', body: JSON.stringify({ status }) },
  ),
  socketUrl: (publicId?: string) => websocketUrl(publicId
    ? `/api/admin/conversations/${encodeURIComponent(publicId)}/socket`
    : '/api/admin/socket'),
};
