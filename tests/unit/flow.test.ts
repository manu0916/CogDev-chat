import { describe, expect, it } from 'vitest';
import { buildFlow, toQuotePayload } from '../../src/flow';

describe('adaptive quote flow', () => {
  it('asks ecommerce-specific details only for ecommerce', () => {
    expect(buildFlow({ projectType: 'ecommerce' }).some((question) => question.key === 'projectSpecific')).toBe(true);
    expect(buildFlow({ projectType: 'other' }).some((question) => question.key === 'projectSpecific')).toBe(false);
  });

  it('does not trust a browser price when creating the quote payload', () => {
    const payload = toQuotePayload({
      name: 'João', company: '', contactMethod: 'email', contactValue: 'joao@example.com', projectType: 'site',
      objective: 'Criar presença digital profissional', audience: 'Clientes', features: 'Páginas institucionais',
      authNeeds: 'none', integrations: 'Nenhuma integração prevista', visualIdentity: 'ready', existingProject: 'no',
      deadline: 'flexible', budget: 'not-sure', notes: '', consent: true,
    } as any, 'token');
    expect(payload).not.toHaveProperty('price');
    expect(payload).not.toHaveProperty('totalAmount');
    expect(payload.consent).toBe(true);
  });
});
