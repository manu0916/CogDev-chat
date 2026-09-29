import { describe, expect, it } from 'vitest';
import {
  emailSchema,
  messageBodySchema,
  phoneSchema,
  quotePayloadSchema,
  submitQuoteSchema,
  createProposalSchema,
  proposalAcceptanceSchema,
} from '../../shared/contracts';

const validQuote = {
  name: 'Maria Silva',
  company: 'Acme',
  contact: { method: 'email' as const, value: 'MARIA@EXAMPLE.COM' },
  projectType: 'crm' as const,
  objective: 'Centralizar o atendimento comercial.',
  audience: 'Equipe de vendas',
  features: 'Funil, tarefas e relatórios',
  projectSpecific: 'Cinco usuários e dois funis',
  authNeeds: 'roles' as const,
  integrations: 'Nenhuma integração prevista',
  visualIdentity: 'partial' as const,
  existingProject: 'no' as const,
  deadline: '3-4-months' as const,
  budget: '15-30k' as const,
  notes: '',
  consent: true as const,
  turnstileToken: 'test-token',
};

describe('shared validation', () => {
  it('normalizes contact values', () => {
    expect(emailSchema.parse('  USER@Example.COM ')).toBe('user@example.com');
    expect(phoneSchema.parse('+55 (11) 99999-0000')).toBe('+5511999990000');
  });

  it('rejects invalid contact and missing consent', () => {
    expect(quotePayloadSchema.safeParse({ ...validQuote, contact: { method: 'email', value: 'invalid' } }).success).toBe(false);
    expect(quotePayloadSchema.safeParse({ ...validQuote, consent: false }).success).toBe(false);
  });

  it('rejects mass assignment and client-side price manipulation', () => {
    const attempted = submitQuoteSchema.safeParse({
      quote: { ...validQuote, totalAmount: 1, status: 'payment_confirmed' },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(attempted.success).toBe(false);
  });

  it('keeps HTML and SQL payloads as inert plain text', () => {
    const xss = '<img src=x onerror=alert(1)>';
    const sql = "'; DROP TABLE messages; --";
    expect(messageBodySchema.parse(xss)).toBe(xss);
    expect(messageBodySchema.parse(sql)).toBe(sql);
  });

  it('rejects empty and oversized messages', () => {
    expect(messageBodySchema.safeParse('   ').success).toBe(false);
    expect(messageBodySchema.safeParse('a'.repeat(2_001)).success).toBe(false);
  });

  it('rejects client-controlled proposal state and invalid monetary relations', () => {
    const base = {
      totalAmount: 100_000,
      depositAmount: 25_000,
      scopeSummary: 'Implementação de uma plataforma web completa.',
      estimatedDeadline: '8 semanas',
      paymentTerms: '25% de sinal e saldo por marcos.',
      maxInstallments: 4,
      validUntil: '2030-12-31T23:59:59.000Z',
      paymentMode: 'manual_payment_link' as const,
      manualPaymentUrl: 'https://checkout2.c6pay.com.br/payment-v2/example',
    };
    expect(createProposalSchema.safeParse({ ...base, depositAmount: 100_001 }).success).toBe(false);
    expect(createProposalSchema.safeParse({ ...base, status: 'payment_confirmed' }).success).toBe(false);
    expect(proposalAcceptanceSchema.safeParse({ accepted: false }).success).toBe(false);
  });
});
