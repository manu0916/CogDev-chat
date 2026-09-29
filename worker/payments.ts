import { z } from 'zod';
import type { Env } from './types';

export type PaymentStatus = 'created' | 'awaiting_payment' | 'confirmed' | 'failed' | 'expired' | 'cancelled';

export type CheckoutInput = {
  proposalPublicId: string;
  amount: number;
  currency: 'BRL';
  maxInstallments: number;
  idempotencyKey: string;
};

export type CheckoutResult = {
  providerPaymentId: string | null;
  paymentUrl: string;
  expiresAt: string | null;
  status: PaymentStatus;
};

export type WebhookResult = {
  providerPaymentId: string;
  providerEventId: string;
  status: Extract<PaymentStatus, 'confirmed' | 'failed' | 'expired' | 'cancelled'>;
  eventType: string;
};

export interface PaymentProvider {
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  getPaymentStatus(providerPaymentId: string): Promise<PaymentStatus>;
  expireCheckout(providerPaymentId: string): Promise<void>;
  verifyWebhookSignature(rawBody: string, headers: Headers): Promise<boolean>;
  processWebhook(rawBody: string, headers: Headers): Promise<WebhookResult>;
}

export class PaymentProviderError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const checkoutResultSchema = z.object({
  providerPaymentId: z.string().min(1).max(200),
  paymentUrl: z.string().url().max(2_048),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(['created', 'awaiting_payment']),
}).strict();

const webhookResultSchema = z.object({
  providerPaymentId: z.string().min(1).max(200),
  providerEventId: z.string().min(1).max(200),
  status: z.enum(['confirmed', 'failed', 'expired', 'cancelled']),
  eventType: z.string().min(1).max(100),
}).strict();

const normalizeHostPattern = (value: string) => value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

export const validateManualPaymentUrl = (rawUrl: string, allowedHosts: string) => {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) return null;
  const host = url.hostname.toLowerCase();
  const patterns = allowedHosts.split(',').map(normalizeHostPattern).filter(Boolean);
  const allowed = patterns.some((pattern) => pattern.startsWith('*.')
    ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2)
    : host === pattern);
  return allowed ? url.toString() : null;
};

export class ManualPaymentLinkProvider implements PaymentProvider {
  constructor(private readonly paymentUrl: string, private readonly expiresAt: string | null) {}

  async createCheckout(): Promise<CheckoutResult> {
    return { providerPaymentId: null, paymentUrl: this.paymentUrl, expiresAt: this.expiresAt, status: 'awaiting_payment' };
  }
  async getPaymentStatus(): Promise<PaymentStatus> { return 'awaiting_payment'; }
  async expireCheckout(): Promise<void> { /* Expiration is persisted by the repository layer. */ }
  async verifyWebhookSignature(): Promise<boolean> { return false; }
  async processWebhook(): Promise<WebhookResult> { throw new PaymentProviderError('WEBHOOK_UNSUPPORTED', 'O modo manual não processa webhooks.'); }
}

const safeAdapterUrl = (raw: string) => {
  let url: URL;
  try { url = new URL(raw); } catch { throw new PaymentProviderError('PROVIDER_NOT_CONFIGURED', 'O adaptador C6 não está configurado.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new PaymentProviderError('PROVIDER_NOT_CONFIGURED', 'O adaptador C6 precisa usar HTTPS.');
  }
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) {
    throw new PaymentProviderError('PROVIDER_NOT_CONFIGURED', 'O endereço do adaptador C6 não é permitido.');
  }
  return url.toString().replace(/\/$/, '');
};

export class C6CheckoutApiProvider implements PaymentProvider {
  private readonly baseUrl: string;

  constructor(private readonly env: Env) {
    if (!env.C6_CLIENT_ID || !env.C6_CLIENT_SECRET || !env.C6_CHECKOUT_ADAPTER_URL) {
      throw new PaymentProviderError('PROVIDER_NOT_CONFIGURED', 'A integração C6 Checkout API ainda não foi configurada.');
    }
    this.baseUrl = safeAdapterUrl(env.C6_CHECKOUT_ADAPTER_URL);
  }

  private headers(idempotencyKey?: string) {
    const headers = new Headers({
      'Content-Type': 'application/json',
      Authorization: `Basic ${btoa(`${this.env.C6_CLIENT_ID}:${this.env.C6_CLIENT_SECRET}`)}`,
    });
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
    return headers;
  }

  private async request(path: string, init?: RequestInit) {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) throw new PaymentProviderError('PROVIDER_ERROR', 'O C6 não pôde concluir a operação agora.');
    return response;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const response = await this.request('/checkouts', {
      method: 'POST',
      headers: this.headers(input.idempotencyKey),
      body: JSON.stringify(input),
    });
    const parsed = checkoutResultSchema.safeParse(await response.json());
    if (!parsed.success) throw new PaymentProviderError('INVALID_PROVIDER_RESPONSE', 'A resposta do C6 não pôde ser validada.');
    return { ...parsed.data, expiresAt: parsed.data.expiresAt || null };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatus> {
    const response = await this.request(`/checkouts/${encodeURIComponent(providerPaymentId)}`, { headers: this.headers() });
    const parsed = z.object({ status: z.enum(['created', 'awaiting_payment', 'confirmed', 'failed', 'expired', 'cancelled']) }).strict().safeParse(await response.json());
    if (!parsed.success) throw new PaymentProviderError('INVALID_PROVIDER_RESPONSE', 'A resposta do C6 não pôde ser validada.');
    return parsed.data.status;
  }

  async expireCheckout(providerPaymentId: string): Promise<void> {
    await this.request(`/checkouts/${encodeURIComponent(providerPaymentId)}/expire`, { method: 'POST', headers: this.headers() });
  }

  async verifyWebhookSignature(rawBody: string, headers: Headers): Promise<boolean> {
    if (!this.env.C6_WEBHOOK_SECRET) return false;
    const response = await fetch(`${this.baseUrl}/webhooks/verify`, {
      method: 'POST',
      headers: new Headers({
        ...Object.fromEntries([...headers.entries()].filter(([name]) => name.toLowerCase().startsWith('x-c6-'))),
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.env.C6_WEBHOOK_SECRET}`,
      }),
      body: rawBody,
    });
    return response.ok;
  }

  async processWebhook(rawBody: string, headers: Headers): Promise<WebhookResult> {
    const response = await this.request('/webhooks/process', {
      method: 'POST',
      headers: new Headers({
        ...Object.fromEntries([...headers.entries()].filter(([name]) => name.toLowerCase().startsWith('x-c6-'))),
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.env.C6_WEBHOOK_SECRET || ''}`,
      }),
      body: rawBody,
    });
    const parsed = webhookResultSchema.safeParse(await response.json());
    if (!parsed.success) throw new PaymentProviderError('INVALID_PROVIDER_RESPONSE', 'O evento do C6 não pôde ser validado.');
    return parsed.data;
  }
}

export const providerFor = (
  env: Env,
  mode: 'manual_payment_link' | 'c6_checkout_api',
  manual?: { paymentUrl: string; expiresAt: string | null },
): PaymentProvider => {
  if (mode === 'manual_payment_link') {
    if (!manual) throw new PaymentProviderError('PAYMENT_LINK_MISSING', 'O link de pagamento ainda não foi cadastrado.');
    return new ManualPaymentLinkProvider(manual.paymentUrl, manual.expiresAt);
  }
  return new C6CheckoutApiProvider(env);
};
