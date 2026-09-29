import type { CreateProposalPayload, ProposalStatus } from '../shared/contracts';
import { randomToken } from './security';
import { validateManualPaymentUrl } from './payments';
import { isProposalExpired } from './payment-policy';
import type { AdminUser, ConversationRow, Env } from './types';

export type ProposalRow = {
  id: number;
  public_id: string;
  conversation_id: number;
  version: number;
  scope_summary: string;
  total_amount: number;
  deposit_amount: number;
  currency: 'BRL';
  estimated_deadline: string;
  payment_terms: string;
  max_installments: number;
  payment_mode: 'manual_payment_link' | 'c6_checkout_api';
  status: ProposalStatus;
  valid_until: string;
  accepted_at: string | null;
  acceptance_ip_hash: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
};

export type PaymentRow = {
  id: number;
  public_id: string;
  proposal_id: number;
  provider: 'manual_c6' | 'c6_checkout_api';
  provider_payment_id: string | null;
  amount: number;
  status: 'created' | 'awaiting_payment' | 'confirmed' | 'failed' | 'expired' | 'cancelled';
  payment_url: string | null;
  idempotency_key: string;
  expires_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

export const latestProposal = (env: Env, conversationId: number) => env.DB.prepare(`
  SELECT * FROM proposals WHERE conversation_id = ?1 ORDER BY version DESC LIMIT 1
`).bind(conversationId).first<ProposalRow>();

export const latestPayment = (env: Env, proposalId: number) => env.DB.prepare(`
  SELECT * FROM payments WHERE proposal_id = ?1 ORDER BY id DESC LIMIT 1
`).bind(proposalId).first<PaymentRow>();

export const expireProposalIfNeeded = async (env: Env, proposal: ProposalRow) => {
  if (!['payment_confirmed', 'cancelled', 'expired'].includes(proposal.status) && isProposalExpired(proposal.valid_until)) {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE proposals SET status = 'expired', updated_at = ?1 WHERE id = ?2 AND status NOT IN ('payment_confirmed', 'cancelled', 'expired')").bind(now, proposal.id),
      env.DB.prepare("UPDATE payments SET status = 'expired', updated_at = ?1 WHERE proposal_id = ?2 AND status IN ('created', 'awaiting_payment')").bind(now, proposal.id),
    ]);
    return { ...proposal, status: 'expired' as const, updated_at: now };
  }
  return proposal;
};

export const proposalDto = (proposal: ProposalRow, payment: PaymentRow | null, includePaymentUrl: boolean) => ({
  publicId: proposal.public_id,
  version: proposal.version,
  scopeSummary: proposal.scope_summary,
  totalAmount: proposal.total_amount,
  depositAmount: proposal.deposit_amount,
  currency: proposal.currency,
  estimatedDeadline: proposal.estimated_deadline,
  paymentTerms: proposal.payment_terms,
  maxInstallments: proposal.max_installments,
  paymentMode: proposal.payment_mode,
  status: proposal.status,
  validUntil: proposal.valid_until,
  acceptedAt: proposal.accepted_at,
  payment: payment ? {
    status: payment.status,
    paidAt: payment.paid_at,
    expiresAt: payment.expires_at,
    paymentUrl: includePaymentUrl ? payment.payment_url : null,
  } : null,
});

export const createProposal = async (
  env: Env,
  conversation: ConversationRow,
  admin: AdminUser,
  input: CreateProposalPayload,
) => {
  const validUntilMs = Date.parse(input.validUntil);
  if (validUntilMs < Date.now() + 60 * 60_000 || validUntilMs > Date.now() + 180 * 24 * 60 * 60_000) {
    throw new Error('INVALID_VALIDITY');
  }
  const manualUrl = input.paymentMode === 'manual_payment_link'
    ? validateManualPaymentUrl(input.manualPaymentUrl || '', env.C6_ALLOWED_PAYMENT_HOSTS)
    : null;
  if (input.paymentMode === 'manual_payment_link' && !manualUrl) throw new Error('INVALID_PAYMENT_URL');
  const versionRow = await env.DB.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM proposals WHERE conversation_id = ?1')
    .bind(conversation.id).first<{ next: number }>();
  const version = versionRow?.next || 1;
  const publicId = `PROP-${randomToken(12).toUpperCase()}`;
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(`
      INSERT INTO proposals
        (public_id, conversation_id, version, scope_summary, total_amount, deposit_amount, currency,
         estimated_deadline, payment_terms, max_installments, payment_mode, status, valid_until,
         created_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'BRL', ?7, ?8, ?9, ?10, 'awaiting_client_approval', ?11, ?12, ?13, ?13)
    `).bind(
      publicId, conversation.id, version, input.scopeSummary, input.totalAmount, input.depositAmount,
      input.estimatedDeadline, input.paymentTerms, input.maxInstallments, input.paymentMode,
      input.validUntil, admin.id, now,
    ),
    env.DB.prepare(`
      INSERT INTO conversation_events (conversation_id, event_type, actor_type, actor_id, metadata, created_at)
      VALUES (?1, 'proposal_created', 'admin', ?2, ?3, ?4)
    `).bind(conversation.id, admin.id, JSON.stringify({ proposalPublicId: publicId, version }), now),
  ];
  if (manualUrl) {
    statements.push(env.DB.prepare(`
      INSERT INTO payments
        (public_id, proposal_id, provider, amount, status, payment_url, idempotency_key, expires_at, created_at, updated_at)
      SELECT ?1, id, 'manual_c6', deposit_amount, 'created', ?2, ?3, valid_until, ?4, ?4
      FROM proposals WHERE public_id = ?5
    `).bind(`PAY-${randomToken(12).toUpperCase()}`, manualUrl, crypto.randomUUID(), now, publicId));
    statements.push(env.DB.prepare(`
      INSERT INTO conversation_events (conversation_id, event_type, actor_type, actor_id, metadata, created_at)
      VALUES (?1, 'payment_link_added', 'admin', ?2, ?3, ?4)
    `).bind(conversation.id, admin.id, JSON.stringify({ proposalPublicId: publicId, version }), now));
  }
  const results = await env.DB.batch(statements);
  if (results.some((result) => !result.success)) throw new Error('PERSISTENCE_FAILED');
  const created = await env.DB.prepare('SELECT * FROM proposals WHERE public_id = ?1').bind(publicId).first<ProposalRow>();
  if (!created) throw new Error('PERSISTENCE_FAILED');
  return created;
};

export const proposalAnnouncement = (proposal: ProposalRow) => {
  const money = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
  return [
    `A Cog Dev enviou a proposta v${proposal.version}.`,
    `Serviço: ${proposal.scope_summary}`,
    `Valor total: ${money(proposal.total_amount)}. Sinal: ${money(proposal.deposit_amount)}.`,
    `Prazo: ${proposal.estimated_deadline}. Condições: ${proposal.payment_terms}.`,
    `Válida até ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(proposal.valid_until))}.`,
    'Use “Revisar proposta” antes de aceitar e pagar.',
  ].join('\n');
};
