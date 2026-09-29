import type { PaymentStatus } from './payments';
import type { ProposalStatus } from '../shared/contracts';

export const isProposalExpired = (validUntil: string, now = Date.now()) => {
  const timestamp = Date.parse(validUntil);
  return !Number.isFinite(timestamp) || timestamp <= now;
};

export const canAcceptProposal = (status: ProposalStatus, validUntil: string, now = Date.now()) =>
  status === 'awaiting_client_approval' && !isProposalExpired(validUntil, now);

export const canCreateCheckout = (status: ProposalStatus) =>
  ['approved', 'awaiting_payment', 'payment_failed'].includes(status);

export const proposalStatusForProviderEvent = (
  status: Extract<PaymentStatus, 'confirmed' | 'failed' | 'expired' | 'cancelled'>,
): ProposalStatus => {
  if (status === 'confirmed') return 'payment_confirmed';
  if (status === 'failed') return 'payment_failed';
  return status;
};

// A browser redirect is navigation only. It is never payment evidence.
export const browserReturnConfirmsPayment = () => false;

export const shouldProcessProviderEvent = (eventAlreadyExists: boolean) => !eventAlreadyExists;

export const checkoutIdempotencySeed = (proposalPublicId: string, version: number) =>
  `c6-checkout:${proposalPublicId}:v${version}`;
