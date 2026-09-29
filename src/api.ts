import type { AnswerValue, QuestionKey, SubmitQuotePayload } from '../shared/contracts';

export type ApiConfig = {
  turnstileSiteKey: string | null;
  turnstileRequired: boolean;
  pricingEnabled: boolean;
  retentionDays: number;
};

export type RestoredSession = {
  status: 'in_progress' | 'submitted';
  currentStep: number;
  expiresAt: string;
  answers: Record<string, AnswerValue>;
  conversation: ConversationSummary;
  quoteResult: QuoteResult | null;
};

export type ConversationStatus = 'bot_collecting' | 'waiting_admin' | 'active' | 'waiting_client' | 'resolved' | 'blocked' | 'expired';

export type ConversationSummary = {
  status: ConversationStatus;
  statusLabel: string;
  lastMessageAt: string | null;
  canMessage?: boolean;
};

export type ChatMessage = {
  id: string;
  sequence: number;
  senderType: 'client' | 'assistant' | 'admin' | 'system';
  senderLabel: string;
  messageType: 'text' | 'system_event';
  body: string;
  clientMessageId: string | null;
  createdAt: string;
};

export type Proposal = {
  publicId: string;
  version: number;
  scopeSummary: string;
  totalAmount: number;
  depositAmount: number;
  currency: 'BRL';
  estimatedDeadline: string;
  paymentTerms: string;
  maxInstallments: number;
  paymentMode: 'manual_payment_link' | 'c6_checkout_api';
  status: 'draft' | 'awaiting_client_approval' | 'approved' | 'awaiting_payment' | 'payment_confirmed' | 'payment_failed' | 'expired' | 'cancelled';
  validUntil: string;
  acceptedAt: string | null;
  payment: null | { status: string; paidAt: string | null; expiresAt: string | null; paymentUrl: string | null };
};

export type QuoteResult = {
  publicCode: string;
  submittedAt: string;
  estimate: null | {
    minimumAmount: number;
    maximumAmount: number;
    estimatedDaysMin: number;
    estimatedDaysMax: number;
    pricingVersion: string;
    label: string;
    disclaimer: string;
  };
  whatsappUrl: string | null;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const request = async <T>(
  path: string,
  options: RequestInit = {},
  onSlow?: (slow: boolean) => void,
): Promise<T> => {
  const controller = new AbortController();
  const slowTimer = window.setTimeout(() => onSlow?.(true), 3_000);
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', ...options, signal: controller.signal });
    const body = (response.status === 204 ? null : await response.json().catch(() => null)) as
      | { error?: { message?: string; code?: string; details?: unknown } }
      | null;
    if (!response.ok) {
      const error = body?.error;
      throw new ApiError(
        error?.message || 'Não foi possível concluir esta ação agora.',
        error?.code || 'REQUEST_FAILED',
        response.status,
        error?.details,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('A conexão demorou mais que o esperado. Tente novamente.', 'TIMEOUT', 0);
    }
    throw new ApiError('Não foi possível conectar. Verifique sua internet e tente novamente.', 'NETWORK_ERROR', 0);
  } finally {
    window.clearTimeout(slowTimer);
    window.clearTimeout(timeout);
    onSlow?.(false);
  }
};

const jsonHeaders = { 'Content-Type': 'application/json' };

const readCookie = (name: string) => {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return '';
};

const protectedHeaders = () => ({ ...jsonHeaders, 'X-CSRF-Token': readCookie('cogdev_csrf') });

export const api = {
  config: () => request<ApiConfig>('/api/config'),

  createSession: () => request<{ expiresAt: string }>('/api/session', {
    method: 'POST',
    headers: jsonHeaders,
    body: '{}',
  }),

  restoreSession: () => request<RestoredSession>('/api/session'),

  saveAnswer: (
    questionKey: QuestionKey,
    answerValue: AnswerValue,
    currentStep: number,
    onSlow?: (slow: boolean) => void,
  ) => request<{ saved: boolean }>('/api/session/answer', {
    method: 'PUT',
    headers: protectedHeaders(),
    body: JSON.stringify({ questionKey, answerValue, currentStep }),
  }, onSlow),

  deleteSession: () => request<void>('/api/session', {
    method: 'DELETE',
    headers: protectedHeaders(),
  }),

  submitQuote: (
    payload: SubmitQuotePayload,
    onSlow?: (slow: boolean) => void,
  ) => request<QuoteResult>('/api/quote', {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      'X-CSRF-Token': readCookie('cogdev_csrf'),
      'Idempotency-Key': payload.idempotencyKey,
    },
    body: JSON.stringify(payload),
  }, onSlow),

  conversation: () => request<ConversationSummary>('/api/conversations/current'),

  messages: (options?: { after?: number; before?: string }) => {
    const params = new URLSearchParams();
    if (options?.after !== undefined) params.set('after', String(options.after));
    if (options?.before) params.set('before', options.before);
    return request<{ messages: ChatMessage[]; nextCursor: string | null; status: ConversationStatus }>(
      `/api/conversations/current/messages${params.size ? `?${params}` : ''}`,
    );
  },

  sendMessage: (body: string, clientMessageId: string) => request<{ message: ChatMessage; duplicate: boolean }>(
    '/api/conversations/current/messages',
    { method: 'POST', headers: protectedHeaders(), body: JSON.stringify({ clientMessageId, body }) },
  ),

  requestHuman: () => request<{ status: ConversationStatus }>('/api/conversations/current/request-human', {
    method: 'POST', headers: protectedHeaders(), body: '{}',
  }),

  resolveConversation: () => request<{ status: ConversationStatus }>('/api/conversations/current/resolve', {
    method: 'POST', headers: protectedHeaders(), body: '{}',
  }),

  markRead: (lastSequence: number) => request<{ read: boolean }>('/api/conversations/current/read', {
    method: 'POST', headers: protectedHeaders(), body: JSON.stringify({ lastSequence }),
  }),

  proposal: () => request<{ proposal: Proposal | null }>('/api/proposals/current'),

  acceptProposal: () => request<{ accepted: boolean; status: Proposal['status'] }>('/api/proposals/current/accept', {
    method: 'POST', headers: protectedHeaders(), body: JSON.stringify({ accepted: true }),
  }),

  createCheckout: (idempotencyKey: string) => request<{ checkoutUrl: string | null; paymentStatus: string; expiresAt?: string | null }>(
    '/api/proposals/current/checkout',
    { method: 'POST', headers: { ...protectedHeaders(), 'Idempotency-Key': idempotencyKey }, body: '{}' },
  ),
};

export const websocketUrl = (path: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
};
