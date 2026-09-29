import { describe, expect, it } from 'vitest';
import {
  browserReturnConfirmsPayment,
  canAcceptProposal,
  canCreateCheckout,
  checkoutIdempotencySeed,
  isProposalExpired,
  proposalStatusForProviderEvent,
  shouldProcessProviderEvent,
} from '../../worker/payment-policy';

describe('proposal and payment state policy', () => {
  const now = Date.parse('2027-01-01T00:00:00.000Z');

  it('blocks an expired proposal and permits a valid pending proposal', () => {
    expect(isProposalExpired('2026-12-31T23:59:59.000Z', now)).toBe(true);
    expect(canAcceptProposal('awaiting_client_approval', '2026-12-31T23:59:59.000Z', now)).toBe(false);
    expect(canAcceptProposal('awaiting_client_approval', '2027-01-02T00:00:00.000Z', now)).toBe(true);
  });

  it('does not permit changing or accepting a proposal after acceptance', () => {
    expect(canAcceptProposal('approved', '2027-01-02T00:00:00.000Z', now)).toBe(false);
    expect(canCreateCheckout('approved')).toBe(true);
    expect(canCreateCheckout('awaiting_client_approval')).toBe(false);
  });

  it('never treats a success-page return as confirmation', () => {
    expect(browserReturnConfirmsPayment()).toBe(false);
  });

  it('deduplicates provider events and maps confirmed and declined outcomes', () => {
    expect(shouldProcessProviderEvent(false)).toBe(true);
    expect(shouldProcessProviderEvent(true)).toBe(false);
    expect(proposalStatusForProviderEvent('confirmed')).toBe('payment_confirmed');
    expect(proposalStatusForProviderEvent('failed')).toBe('payment_failed');
  });

  it('uses one deterministic provider key seed per proposal version', () => {
    const first = checkoutIdempotencySeed('PROP-ABC', 2);
    expect(checkoutIdempotencySeed('PROP-ABC', 2)).toBe(first);
    expect(checkoutIdempotencySeed('PROP-ABC', 3)).not.toBe(first);
  });
});
