import {
  submitQuoteSchema,
  saveAnswerSchema,
  normalizeContact,
  sendMessageSchema,
  internalNoteSchema,
  conversationTransitionSchema,
  createProposalSchema,
  proposalAcceptanceSchema,
  paymentLinkSchema,
} from '../shared/contracts';
import type { QuotePayload } from '../shared/contracts';
import { authenticateAdmin, can } from './admin-auth';
import {
  ensureConversation,
  loadMessages,
  roomStub,
  statusLabel,
  type MessageDto,
} from './conversations';
import { calculateSampleEstimate, type Estimate } from './pricing';
import { checkRateLimit } from './rate-limit';
import {
  apiError,
  getClientIpKey,
  json,
  parseJsonBody,
  parseCookies,
  randomToken,
  RequestBodyError,
  requestOriginIsAllowed,
  responseHeaders,
  sessionCookies,
  csrfCookies,
  clearSessionCookies,
  sha256,
} from './security';
import type { AdminUser, ConversationRow, Env, SessionRow, StoredQuoteRow } from './types';
import {
  createProposal,
  expireProposalIfNeeded,
  latestPayment,
  latestProposal,
  proposalAnnouncement,
  proposalDto,
  type PaymentRow,
} from './proposals';
import { PaymentProviderError, providerFor, validateManualPaymentUrl } from './payments';
import {
  canAcceptProposal,
  canCreateCheckout,
  checkoutIdempotencySeed,
  proposalStatusForProviderEvent,
  shouldProcessProviderEvent,
} from './payment-policy';

export { ConversationRoom, AdminInbox } from './durable-objects';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const projectLabels: Record<QuotePayload['projectType'], string> = {
  site: 'Site institucional',
  'landing-page': 'Landing page',
  ecommerce: 'Loja virtual',
  crm: 'CRM',
  'web-system': 'Sistema web',
  'mobile-app': 'Aplicativo mobile',
  automation: 'Automação',
  'admin-panel': 'Painel administrativo',
  integration: 'Integração entre sistemas',
  maintenance: 'Manutenção ou melhoria',
  other: 'Outro',
};

const validationDetails = (issues: Array<{ path: PropertyKey[]; message: string }>) =>
  issues.slice(0, 8).map((issue) => ({ field: issue.path.join('.'), message: issue.message }));

const enforceLimit = async (
  request: Request,
  env: Env,
  namespace: string,
  key: string,
  limit: number,
  windowSeconds: number,
) => {
  const result = await checkRateLimit(env.DB, namespace, key, limit, windowSeconds);
  if (!result.allowed) {
    return apiError(
      request,
      env,
      429,
      'RATE_LIMITED',
      'Muitas tentativas em pouco tempo. Aguarde um pouco e tente novamente.',
      { retryAfter: result.retryAfter },
    );
  }
  return null;
};

const sessionFromRequest = async (request: Request, env: Env) => {
  const token = parseCookies(request).get('cogdev_session');
  if (!token || token.length < 32 || token.length > 128) return null;
  const tokenHash = await sha256(token);
  return env.DB.prepare(`
    SELECT id, public_id, status, current_step, expires_at, csrf_token_hash
    FROM quote_sessions
    WHERE access_token_hash = ?1
    LIMIT 1
  `).bind(tokenHash).first<SessionRow>();
};

const requireCsrf = async (request: Request, env: Env, session: SessionRow) => {
  const header = request.headers.get('X-CSRF-Token');
  const cookie = parseCookies(request).get('cogdev_csrf');
  if (!header || !cookie || header !== cookie || !session.csrf_token_hash) {
    return apiError(request, env, 403, 'INVALID_CSRF', 'Não foi possível validar esta ação. Atualize a página e tente novamente.');
  }
  const hash = await sha256(header);
  if (hash !== session.csrf_token_hash) {
    return apiError(request, env, 403, 'INVALID_CSRF', 'Não foi possível validar esta ação. Atualize a página e tente novamente.');
  }
  return null;
};

const requireActiveSession = async (request: Request, env: Env) => {
  const session = await sessionFromRequest(request, env);
  if (!session) {
    return { response: apiError(request, env, 401, 'INVALID_SESSION', 'Sua sessão não pôde ser validada. Inicie um novo orçamento.') };
  }
  if (session.status === 'expired' || Date.parse(session.expires_at) <= Date.now()) {
    await env.DB.prepare("UPDATE quote_sessions SET status = 'expired', updated_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString(), session.id).run();
    return { response: apiError(request, env, 410, 'SESSION_EXPIRED', 'Esta sessão expirou. Inicie um novo orçamento para continuar.') };
  }
  return { session };
};

const handleCreateSession = async (request: Request, env: Env) => {
  const ipKey = await getClientIpKey(request, env);
  const limited = await enforceLimit(request, env, 'create-session', ipKey, 10, 3_600);
  if (limited) return limited;

  if (request.headers.get('Content-Length') && request.headers.get('Content-Type')?.startsWith('application/json')) {
    await parseJsonBody(request, 1_024);
  }

  const accessToken = randomToken();
  const tokenHash = await sha256(accessToken);
  const csrfToken = randomToken(24);
  const csrfHash = await sha256(csrfToken);
  const publicId = `COG-${randomToken(9).toUpperCase()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const result = await env.DB.prepare(`
    INSERT INTO quote_sessions
      (public_id, access_token_hash, csrf_token_hash, status, current_step, created_at, updated_at, expires_at)
    VALUES (?1, ?2, ?3, 'in_progress', 0, ?4, ?4, ?5)
  `).bind(publicId, tokenHash, csrfHash, now.toISOString(), expiresAt.toISOString()).run();

  if (!result.success) throw new Error('Failed to persist session');
  const inserted = await env.DB.prepare('SELECT id FROM quote_sessions WHERE access_token_hash = ?1').bind(tokenHash).first<{ id: number }>();
  if (!inserted) throw new Error('Created session could not be read');
  await ensureConversation(env, inserted.id);
  return json(
    request,
    env,
    { expiresAt: expiresAt.toISOString() },
    201,
    undefined,
    sessionCookies(env, accessToken, csrfToken, expiresAt),
  );
};

const handleGetSession = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const { session } = auth;
  const sessionKey = await sha256(String(session.id));
  const limited = await enforceLimit(request, env, 'read-session', sessionKey, 60, 60);
  if (limited) return limited;

  const rows = await env.DB.prepare(`
    SELECT question_key, answer_value
    FROM quote_answers
    WHERE session_id = ?1
    ORDER BY id ASC
  `).bind(session.id).all<{ question_key: string; answer_value: string }>();

  const answers: Record<string, unknown> = {};
  for (const row of rows.results) {
    try {
      answers[row.question_key] = JSON.parse(row.answer_value);
    } catch {
      // Corrupt rows are omitted instead of exposing storage details.
    }
  }

  const conversation = await ensureConversation(env, session.id);
  let quoteResult = null;
  if (session.status === 'submitted') {
    const stored = await findStoredQuote(env, session.id);
    const requestRow = await env.DB.prepare('SELECT name FROM quote_requests WHERE session_id = ?1')
      .bind(session.id).first<{ name: string }>();
    if (stored && requestRow) quoteResult = storedQuoteResponse(env, stored, requestRow.name);
  }

  // Reissue a verified legacy token at / when an existing session is restored.
  const csrfToken = parseCookies(request).get('cogdev_csrf');
  const cookies = csrfToken && await sha256(csrfToken) === session.csrf_token_hash
    ? csrfCookies(env, csrfToken, new Date(session.expires_at))
    : [];

  return json(request, env, {
    status: session.status,
    currentStep: session.current_step,
    expiresAt: session.expires_at,
    answers,
    conversation: {
      status: conversation.status,
      statusLabel: statusLabel(conversation.status),
      lastMessageAt: conversation.last_message_at,
    },
    quoteResult,
  }, 200, undefined, cookies);
};

const handleSaveAnswer = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const { session } = auth;
  const csrfError = await requireCsrf(request, env, session);
  if (csrfError) return csrfError;
  if (session.status !== 'in_progress') {
    return apiError(request, env, 409, 'ALREADY_SUBMITTED', 'Este orçamento já foi enviado e não pode mais ser alterado.');
  }

  const sessionKey = await sha256(String(session.id));
  const limited = await enforceLimit(request, env, 'save-answer', sessionKey, 30, 60);
  if (limited) return limited;

  const parsed = saveAnswerSchema.safeParse(await parseJsonBody<unknown>(request));
  if (!parsed.success) {
    return apiError(request, env, 422, 'VALIDATION_ERROR', 'Revise esta resposta e tente novamente.', validationDetails(parsed.error.issues));
  }

  const now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO quote_answers (session_id, question_key, answer_value, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT(session_id, question_key)
      DO UPDATE SET answer_value = excluded.answer_value, updated_at = excluded.updated_at
    `).bind(session.id, parsed.data.questionKey, JSON.stringify(parsed.data.answerValue), now),
    env.DB.prepare(`
      UPDATE quote_sessions
      SET current_step = ?1, updated_at = ?2
      WHERE id = ?3 AND status = 'in_progress'
    `).bind(parsed.data.currentStep, now, session.id),
  ]);
  if (result.some((entry) => !entry.success)) throw new Error('Failed to persist answer');

  return json(request, env, { saved: true });
};

const handleDeleteSession = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const { session } = auth;
  const csrfError = await requireCsrf(request, env, session);
  if (csrfError) return csrfError;
  const result = await env.DB.prepare('DELETE FROM quote_sessions WHERE id = ?1').bind(session.id).run();
  if (!result.success) throw new Error('Failed to delete session');
  const headers = responseHeaders(request, env, { 'Cache-Control': 'no-store' });
  for (const cookie of clearSessionCookies(env)) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 204, headers });
};

const conversationForSession = async (env: Env, sessionId: number) => ensureConversation(env, sessionId);

const callRoom = async (
  env: Env,
  conversation: ConversationRow,
  participant: 'client' | 'admin',
  actorId: number | null,
  path: '/message' | '/transition' | '/system',
  body: unknown,
) => roomStub(env, conversation).fetch(`https://internal${path}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Conversation-Id': String(conversation.id),
    'X-Conversation-Public-Id': conversation.public_id,
    'X-Participant': participant,
    'X-Actor-Id': actorId ? String(actorId) : '',
  },
  body: JSON.stringify(body),
});

const transitionRoom = async (
  env: Env,
  conversation: ConversationRow,
  participant: 'client' | 'admin',
  actorId: number | null,
  status: string,
) => callRoom(env, conversation, participant, actorId, '/transition', { status });

const handleConversationCurrent = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const conversation = await conversationForSession(env, auth.session.id);
  return json(request, env, {
    status: conversation.status,
    statusLabel: statusLabel(conversation.status),
    lastMessageAt: conversation.last_message_at,
    canMessage: ['waiting_admin', 'active', 'waiting_client'].includes(conversation.status),
  });
};

const handleClientMessages = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const conversation = await conversationForSession(env, auth.session.id);
  const sessionKey = await sha256(String(auth.session.id));

  if (request.method === 'GET') {
    const limited = await enforceLimit(request, env, 'client-history', sessionKey, 30, 60);
    if (limited) return limited;
    const url = new URL(request.url);
    const afterRaw = url.searchParams.get('after');
    const after = afterRaw === null ? null : Number(afterRaw);
    if (after !== null && (!Number.isSafeInteger(after) || after < 0)) {
      return apiError(request, env, 400, 'INVALID_CURSOR', 'O ponto de continuação do histórico é inválido.');
    }
    try {
      const history = await loadMessages(env, conversation.id, {
        before: url.searchParams.get('before'),
        after,
        limit: Number(url.searchParams.get('limit')) || 30,
      });
      return json(request, env, { ...history, status: conversation.status });
    } catch {
      return apiError(request, env, 400, 'INVALID_CURSOR', 'O ponto de continuação do histórico é inválido.');
    }
  }

  const csrfError = await requireCsrf(request, env, auth.session);
  if (csrfError) return csrfError;
  const body = await parseJsonBody<unknown>(request, 4_096);
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(request, env, 422, 'INVALID_MESSAGE', parsed.error.issues[0]?.message || 'Mensagem inválida.');
  }
  const roomResponse = await callRoom(env, conversation, 'client', null, '/message', parsed.data);
  const payload = await roomResponse.json();
  return json(request, env, payload, roomResponse.status);
};

const handleRequestHuman = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const csrfError = await requireCsrf(request, env, auth.session);
  if (csrfError) return csrfError;
  const conversation = await conversationForSession(env, auth.session.id);
  if (['waiting_admin', 'active', 'waiting_client'].includes(conversation.status)) {
    return json(request, env, { status: conversation.status, alreadyRequested: true });
  }
  const response = await transitionRoom(env, conversation, 'client', null, 'waiting_admin');
  const payload = await response.json();
  return json(request, env, payload, response.status);
};

const handleClientResolve = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const csrfError = await requireCsrf(request, env, auth.session);
  if (csrfError) return csrfError;
  const conversation = await conversationForSession(env, auth.session.id);
  const response = await transitionRoom(env, conversation, 'client', null, 'resolved');
  const payload = await response.json();
  return json(request, env, payload, response.status);
};

const handleClientRead = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const csrfError = await requireCsrf(request, env, auth.session);
  if (csrfError) return csrfError;
  const body = await parseJsonBody<{ lastSequence?: unknown }>(request, 1_024);
  if (!Number.isSafeInteger(body.lastSequence) || Number(body.lastSequence) < 0) {
    return apiError(request, env, 422, 'VALIDATION_ERROR', 'Leitura inválida.');
  }
  const conversation = await conversationForSession(env, auth.session.id);
  await env.DB.prepare('UPDATE conversations SET client_last_read_at = ?1 WHERE id = ?2')
    .bind(new Date().toISOString(), conversation.id).run();
  return json(request, env, { read: true });
};

const handleClientSocket = async (request: Request, env: Env) => {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return apiError(request, env, 426, 'UPGRADE_REQUIRED', 'Esta rota requer uma conexão WebSocket.');
  }
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const sessionKey = await sha256(String(auth.session.id));
  const limited = await enforceLimit(request, env, 'client-reconnect', sessionKey, 10, 60);
  if (limited) return limited;
  const conversation = await conversationForSession(env, auth.session.id);
  return roomStub(env, conversation).fetch('https://internal/socket', {
    headers: {
      Upgrade: 'websocket',
      'X-Conversation-Id': String(conversation.id),
      'X-Conversation-Public-Id': conversation.public_id,
      'X-Participant': 'client',
      'X-Actor-Id': '',
    },
  });
};

const handleClientProposal = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const conversation = await conversationForSession(env, auth.session.id);
  let proposal = await latestProposal(env, conversation.id);
  if (!proposal) return json(request, env, { proposal: null });
  proposal = await expireProposalIfNeeded(env, proposal);
  const payment = await latestPayment(env, proposal.id);
  const includePaymentUrl = ['approved', 'awaiting_payment', 'payment_failed'].includes(proposal.status);
  return json(request, env, { proposal: proposalDto(proposal, payment, includePaymentUrl) });
};

const handleAcceptProposal = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const csrfError = await requireCsrf(request, env, auth.session);
  if (csrfError) return csrfError;
  const parsed = proposalAcceptanceSchema.safeParse(await parseJsonBody<unknown>(request, 1_024));
  if (!parsed.success) return apiError(request, env, 422, 'CONSENT_REQUIRED', 'Você precisa aceitar explicitamente a proposta e as condições.');
  const conversation = await conversationForSession(env, auth.session.id);
  let proposal = await latestProposal(env, conversation.id);
  if (!proposal) return apiError(request, env, 404, 'PROPOSAL_NOT_FOUND', 'Nenhuma proposta foi encontrada para esta conversa.');
  proposal = await expireProposalIfNeeded(env, proposal);
  if (proposal.status === 'expired') return apiError(request, env, 410, 'PROPOSAL_EXPIRED', 'Esta proposta expirou. Solicite uma nova versão à Cog Dev.');
  if (!canAcceptProposal(proposal.status, proposal.valid_until)) {
    if (['approved', 'awaiting_payment', 'payment_confirmed'].includes(proposal.status)) {
      return json(request, env, { accepted: true, status: proposal.status });
    }
    return apiError(request, env, 409, 'PROPOSAL_NOT_ACCEPTABLE', 'Esta proposta não está disponível para aceite.');
  }
  const ipHash = await getClientIpKey(request, env);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    UPDATE proposals SET status = 'approved', accepted_at = ?1, acceptance_ip_hash = ?2, updated_at = ?1
    WHERE id = ?3 AND status = 'awaiting_client_approval' AND valid_until > ?1
  `).bind(now, ipHash, proposal.id).run();
  if (!result.success || Number(result.meta.changes || 0) !== 1) return apiError(request, env, 409, 'PROPOSAL_CHANGED', 'A proposta foi atualizada. Recarregue antes de continuar.');
  await env.DB.prepare(`
    INSERT INTO conversation_events (conversation_id, event_type, actor_type, actor_id, metadata, created_at)
    VALUES (?1, 'proposal_accepted', 'client', NULL, ?2, ?3)
  `).bind(conversation.id, JSON.stringify({ proposalPublicId: proposal.public_id, version: proposal.version }), now).run();
  return json(request, env, { accepted: true, status: 'approved' });
};

const checkoutResponse = (request: Request, env: Env, payment: PaymentRow) => {
  const validUrl = payment.payment_url ? validateManualPaymentUrl(payment.payment_url, env.C6_ALLOWED_PAYMENT_HOSTS) : null;
  if (!validUrl) return apiError(request, env, 503, 'CHECKOUT_UNAVAILABLE', 'O checkout seguro ainda não está disponível. Fale com a Cog Dev.');
  return json(request, env, { checkoutUrl: validUrl, paymentStatus: payment.status, expiresAt: payment.expires_at });
};

const handleCreateCheckout = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const csrfError = await requireCsrf(request, env, auth.session);
  if (csrfError) return csrfError;
  const clientKey = request.headers.get('Idempotency-Key');
  if (!clientKey || !/^[0-9a-f-]{36}$/i.test(clientKey)) return apiError(request, env, 400, 'INVALID_IDEMPOTENCY_KEY', 'Não foi possível validar esta tentativa de pagamento.');
  const sessionKey = await sha256(String(auth.session.id));
  const limited = await enforceLimit(request, env, 'create-checkout', sessionKey, 5, 3_600);
  if (limited) return limited;
  const conversation = await conversationForSession(env, auth.session.id);
  let proposal = await latestProposal(env, conversation.id);
  if (!proposal) return apiError(request, env, 404, 'PROPOSAL_NOT_FOUND', 'Nenhuma proposta foi encontrada.');
  proposal = await expireProposalIfNeeded(env, proposal);
  if (proposal.status === 'expired') return apiError(request, env, 410, 'PROPOSAL_EXPIRED', 'Esta proposta expirou. Solicite uma nova versão.');
  if (proposal.status === 'payment_confirmed') return json(request, env, { paymentStatus: 'confirmed', checkoutUrl: null });
  if (!canCreateCheckout(proposal.status)) {
    return apiError(request, env, 409, 'PROPOSAL_NOT_ACCEPTED', 'Aceite a proposta antes de iniciar o pagamento.');
  }

  const existing = await env.DB.prepare(`
    SELECT * FROM payments
    WHERE proposal_id = ?1 AND status IN ('created', 'awaiting_payment', 'confirmed', 'failed')
    ORDER BY id DESC LIMIT 1
  `).bind(proposal.id).first<PaymentRow>();
  if (existing?.status === 'confirmed') return json(request, env, { paymentStatus: 'confirmed', checkoutUrl: null });
  if (existing?.expires_at && Date.parse(existing.expires_at) <= Date.now()) {
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE payments SET status = 'expired', updated_at = ?1 WHERE id = ?2 AND status != 'confirmed'")
      .bind(now, existing.id).run();
    return apiError(request, env, 410, 'CHECKOUT_EXPIRED', 'Este link de pagamento expirou. Solicite um novo link à Cog Dev.');
  }
  if (existing?.payment_url) {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE payments SET status = 'awaiting_payment', updated_at = ?1 WHERE id = ?2 AND status IN ('created', 'failed')").bind(now, existing.id),
      env.DB.prepare("UPDATE proposals SET status = 'awaiting_payment', updated_at = ?1 WHERE id = ?2 AND status IN ('approved', 'payment_failed')").bind(now, proposal.id),
    ]);
    return checkoutResponse(request, env, { ...existing, status: 'awaiting_payment', updated_at: now });
  }

  if (proposal.payment_mode === 'manual_payment_link') {
    return apiError(request, env, 503, 'PAYMENT_LINK_MISSING', 'O link de pagamento precisa ser atualizado pela Cog Dev.');
  }

  const providerKey = await sha256(checkoutIdempotencySeed(proposal.public_id, proposal.version));
  const now = new Date().toISOString();
  const paymentPublicId = `PAY-${randomToken(12).toUpperCase()}`;
  const inserted = await env.DB.prepare(`
    INSERT OR IGNORE INTO payments
      (public_id, proposal_id, provider, amount, status, idempotency_key, created_at, updated_at)
    VALUES (?1, ?2, 'c6_checkout_api', ?3, 'created', ?4, ?5, ?5)
  `).bind(paymentPublicId, proposal.id, proposal.deposit_amount, providerKey, now).run();
  let payment = await env.DB.prepare('SELECT * FROM payments WHERE idempotency_key = ?1').bind(providerKey).first<PaymentRow>();
  if (!payment) throw new Error('Payment lock could not be created');
  if (Number(inserted.meta.changes || 0) === 0 && !payment.payment_url) {
    const lockIsFresh = payment.status === 'created' && Date.now() - Date.parse(payment.updated_at) < 30_000;
    if (lockIsFresh) {
      return apiError(request, env, 409, 'CHECKOUT_PROCESSING', 'O checkout já está sendo preparado. Tente novamente em alguns segundos.');
    }
    const claimed = await env.DB.prepare(`
      UPDATE payments SET status = 'created', updated_at = ?1
      WHERE id = ?2 AND payment_url IS NULL AND status IN ('created', 'failed') AND updated_at = ?3
    `).bind(now, payment.id, payment.updated_at).run();
    if (Number(claimed.meta.changes || 0) !== 1) {
      return apiError(request, env, 409, 'CHECKOUT_PROCESSING', 'O checkout já está sendo preparado. Tente novamente em alguns segundos.');
    }
    payment = { ...payment, status: 'created', updated_at: now };
  }

  try {
    const provider = providerFor(env, proposal.payment_mode);
    const checkout = await provider.createCheckout({
      proposalPublicId: proposal.public_id,
      amount: proposal.deposit_amount,
      currency: 'BRL',
      maxInstallments: proposal.max_installments,
      idempotencyKey: providerKey,
    });
    const safeUrl = validateManualPaymentUrl(checkout.paymentUrl, env.C6_ALLOWED_PAYMENT_HOSTS);
    if (!safeUrl) throw new PaymentProviderError('INVALID_PAYMENT_URL', 'O checkout retornou um endereço não autorizado.');
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE payments SET provider_payment_id = ?1, payment_url = ?2, status = 'awaiting_payment', expires_at = ?3, updated_at = ?4
        WHERE id = ?5 AND amount = ?6
      `).bind(checkout.providerPaymentId, safeUrl, checkout.expiresAt, now, payment.id, proposal.deposit_amount),
      env.DB.prepare("UPDATE proposals SET status = 'awaiting_payment', updated_at = ?1 WHERE id = ?2 AND status IN ('approved', 'payment_failed')").bind(now, proposal.id),
    ]);
    if (results.some((entry) => !entry.success)) throw new Error('Checkout persistence failed');
    payment = { ...payment, provider_payment_id: checkout.providerPaymentId, payment_url: safeUrl, status: 'awaiting_payment', expires_at: checkout.expiresAt, updated_at: now };
    return checkoutResponse(request, env, payment);
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      await env.DB.prepare("UPDATE payments SET status = 'failed', updated_at = ?1 WHERE id = ?2 AND status = 'created'")
        .bind(new Date().toISOString(), payment.id).run();
      return apiError(request, env, 503, error.code, error.message);
    }
    throw error;
  }
};

const handleC6Webhook = async (request: Request, env: Env) => {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 65_536) return apiError(request, env, 413, 'PAYLOAD_TOO_LARGE', 'Evento muito grande.');
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > 65_536) return apiError(request, env, 413, 'PAYLOAD_TOO_LARGE', 'Evento muito grande.');
  let provider;
  try { provider = providerFor(env, 'c6_checkout_api'); } catch (error) {
    return apiError(request, env, 503, 'PROVIDER_NOT_CONFIGURED', 'Integração indisponível.');
  }
  if (!await provider.verifyWebhookSignature(rawBody, request.headers)) {
    return apiError(request, env, 401, 'INVALID_WEBHOOK', 'Notificação inválida.');
  }
  const event = await provider.processWebhook(rawBody, request.headers);
  const payment = await env.DB.prepare("SELECT * FROM payments WHERE provider = 'c6_checkout_api' AND provider_payment_id = ?1")
    .bind(event.providerPaymentId).first<PaymentRow>();
  if (!payment) return json(request, env, { received: true }, 202);
  const now = new Date().toISOString();
  const proposalStatus = proposalStatusForProviderEvent(event.status);
  const payloadHash = await sha256(rawBody);
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO payment_events (payment_id, provider_event_id, event_type, payload_hash, processed_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    `).bind(payment.id, event.providerEventId, event.eventType, payloadHash, now),
    env.DB.prepare(`
      UPDATE payments
      SET status = ?1, paid_at = CASE WHEN ?1 = 'confirmed' THEN ?2 ELSE paid_at END, updated_at = ?2
      WHERE id = ?3 AND (status != 'confirmed' OR ?1 = 'confirmed')
    `).bind(event.status, now, payment.id),
    env.DB.prepare(`
      UPDATE proposals SET status = ?1, updated_at = ?2
      WHERE id = ?3 AND (status != 'payment_confirmed' OR ?1 = 'payment_confirmed')
    `).bind(proposalStatus, now, payment.proposal_id),
  ]);
  if (results.some((entry) => !entry.success)) throw new Error('Webhook event could not be persisted');
  if (!shouldProcessProviderEvent(Number(results[0].meta.changes || 0) === 0)) {
    return json(request, env, { received: true, duplicate: true });
  }
  const context = await env.DB.prepare(`
    SELECT c.* FROM conversations c JOIN proposals p ON p.conversation_id = c.id WHERE p.id = ?1
  `).bind(payment.proposal_id).first<ConversationRow>();
  if (context) {
    const body = event.status === 'confirmed'
      ? 'Pagamento do valor inicial confirmado com segurança. A equipe Cog Dev dará continuidade ao projeto.'
      : event.status === 'failed' ? 'O pagamento do valor inicial não foi confirmado. Revise o checkout ou fale com a equipe Cog Dev.' : 'O checkout desta proposta não está mais ativo.';
    await callRoom(env, context, 'admin', null, '/system', { body, eventType: event.status === 'confirmed' ? 'payment_confirmed' : 'payment_failed' });
  }
  return json(request, env, { received: true });
};

type TurnstileResult = { success: boolean; action?: string; hostname?: string; 'error-codes'?: string[] };

const validateTurnstile = async (
  request: Request,
  env: Env,
  token: string,
  idempotencyKey: string,
): Promise<boolean> => {
  if (!env.TURNSTILE_SECRET_KEY) return env.ENVIRONMENT !== 'production';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: request.headers.get('CF-Connecting-IP') || undefined,
        idempotency_key: idempotencyKey,
      }),
      signal: controller.signal,
    });
    if (!verification.ok) return false;
    const result = await verification.json<TurnstileResult>();
    if (!result.success || (result.action && result.action !== 'quote_submit')) return false;
    if (env.ENVIRONMENT === 'production' && result.hostname) {
      const validHosts = env.ALLOWED_ORIGINS.split(',').map((origin) => {
        try { return new URL(origin.trim()).hostname; } catch { return ''; }
      });
      if (!validHosts.includes(result.hostname)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const whatsappUrl = (env: Env, name: string, publicId: string, projectType: QuotePayload['projectType']) => {
  const number = env.WHATSAPP_NUMBER.replace(/\D/g, '');
  if (number.length < 10 || number.length > 15) return null;
  const safeName = name.slice(0, 80);
  const message = `Olá! Sou ${safeName}. Enviei o briefing ${publicId} para um projeto de ${projectLabels[projectType]}.`;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
};

const storedQuoteResponse = (env: Env, row: StoredQuoteRow, name: string) => ({
  publicCode: row.public_id,
  submittedAt: row.submitted_at,
  estimate: row.minimum_amount === null ? null : {
    minimumAmount: row.minimum_amount,
    maximumAmount: row.maximum_amount,
    estimatedDaysMin: row.estimated_days_min,
    estimatedDaysMax: row.estimated_days_max,
    pricingVersion: row.pricing_version,
    label: 'Estimativa preliminar',
    disclaimer: 'O valor final depende de análise técnica da Cog Dev.',
  },
  whatsappUrl: whatsappUrl(env, name, row.public_id, row.project_type as QuotePayload['projectType']),
});

const findStoredQuote = async (env: Env, sessionId: number) => env.DB.prepare(`
  SELECT s.public_id, r.project_type, r.submitted_at,
         e.minimum_amount, e.maximum_amount, e.estimated_days_min, e.estimated_days_max, e.pricing_version
  FROM quote_requests r
  JOIN quote_sessions s ON s.id = r.session_id
  LEFT JOIN quote_estimates e ON e.session_id = r.session_id
  WHERE r.session_id = ?1
`).bind(sessionId).first<StoredQuoteRow>();

const requireAdmin = async (request: Request, env: Env, permission?: Parameters<typeof can>[1]) => {
  const ipKey = await getClientIpKey(request, env);
  const limited = await enforceLimit(request, env, 'admin-access', ipKey, 60, 60);
  if (limited) return { response: limited };
  const admin = await authenticateAdmin(request, env);
  if (!admin) return { response: apiError(request, env, 401, 'ADMIN_AUTH_REQUIRED', 'Autenticação administrativa necessária.') };
  if (permission && !can(admin, permission)) {
    return { response: apiError(request, env, 403, 'ADMIN_FORBIDDEN', 'Você não tem permissão para realizar esta ação.') };
  }
  return { admin };
};

const validConversationPublicId = (value: string) => /^CHAT-[A-Z0-9_-]{12,32}$/.test(value);

const adminConversationByPublicId = async (env: Env, publicId: string) => {
  if (!validConversationPublicId(publicId)) return null;
  return env.DB.prepare('SELECT * FROM conversations WHERE public_id = ?1 LIMIT 1')
    .bind(publicId).first<ConversationRow>();
};

const handleAdminList = async (request: Request, env: Env, admin: AdminUser) => {
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  const validFilters = new Set(['waiting', 'active', 'waiting_client', 'unread', 'resolved', 'blocked', 'all']);
  if (!validFilters.has(filter)) return apiError(request, env, 400, 'INVALID_FILTER', 'Filtro inválido.');
  const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const page = Math.max(0, Math.min(1_000, Number(url.searchParams.get('page')) || 0));
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  const add = (clause: string, value?: unknown) => {
    clauses.push(clause.replace('?x', `?${bindings.length + 1}`));
    if (value !== undefined) bindings.push(value);
  };
  const statusByFilter: Record<string, string> = {
    waiting: 'waiting_admin', active: 'active', waiting_client: 'waiting_client', resolved: 'resolved', blocked: 'blocked',
  };
  if (statusByFilter[filter]) add('c.status = ?x', statusByFilter[filter]);
  if (filter === 'unread') clauses.push("EXISTS (SELECT 1 FROM messages um WHERE um.conversation_id = c.id AND um.sender_type = 'client' AND (c.admin_last_read_at IS NULL OR um.created_at > c.admin_last_read_at))");
  if (query) {
    const escaped = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    bindings.push(escaped);
    const marker = `?${bindings.length}`;
    const contactSearch = can(admin, 'viewPii') ? ` OR qr.email_normalized LIKE ${marker} ESCAPE '\\' OR qr.phone_normalized LIKE ${marker} ESCAPE '\\'` : '';
    clauses.push(`(COALESCE(qr.name, json_extract((SELECT answer_value FROM quote_answers qa WHERE qa.session_id = s.id AND qa.question_key = 'name'), '$')) LIKE ${marker} ESCAPE '\\'
      OR COALESCE(qr.company, json_extract((SELECT answer_value FROM quote_answers qa WHERE qa.session_id = s.id AND qa.question_key = 'company'), '$')) LIKE ${marker} ESCAPE '\\'
      OR s.public_id LIKE ${marker} ESCAPE '\\'${contactSearch})`);
  }
  bindings.push(50, page * 50);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await env.DB.prepare(`
    SELECT
      c.public_id, c.status, c.last_message_at, c.created_at,
      COALESCE(qr.name, json_extract((SELECT answer_value FROM quote_answers qa WHERE qa.session_id = s.id AND qa.question_key = 'name'), '$'), 'Visitante') AS client_name,
      COALESCE(qr.company, json_extract((SELECT answer_value FROM quote_answers qa WHERE qa.session_id = s.id AND qa.question_key = 'company'), '$')) AS company,
      COALESCE(qr.project_type, json_extract((SELECT answer_value FROM quote_answers qa WHERE qa.session_id = s.id AND qa.question_key = 'projectType'), '$'), 'other') AS project_type,
      au.display_name AS assigned_to,
      (SELECT body FROM messages lm WHERE lm.conversation_id = c.id AND lm.deleted_at IS NULL ORDER BY lm.sequence DESC LIMIT 1) AS last_message,
      (SELECT COUNT(*) FROM messages um WHERE um.conversation_id = c.id AND um.sender_type = 'client' AND (c.admin_last_read_at IS NULL OR um.created_at > c.admin_last_read_at)) AS unread_count
    FROM conversations c
    JOIN quote_sessions s ON s.id = c.quote_session_id
    LEFT JOIN quote_requests qr ON qr.session_id = s.id
    LEFT JOIN admin_users au ON au.id = c.assigned_admin_id
    ${where}
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
    LIMIT ?${bindings.length - 1} OFFSET ?${bindings.length}
  `).bind(...bindings).all<{
    public_id: string; status: string; last_message_at: string | null; created_at: string;
    client_name: string; company: string | null; project_type: string; assigned_to: string | null;
    last_message: string | null; unread_count: number;
  }>();
  return json(request, env, {
    conversations: result.results.map((row) => ({
      publicId: row.public_id,
      status: row.status,
      name: row.client_name,
      company: row.company,
      projectType: row.project_type,
      assignedTo: row.assigned_to,
      lastMessage: row.last_message,
      lastMessageAt: row.last_message_at || row.created_at,
      unreadCount: row.unread_count,
      clientPresence: row.last_message_at && Date.now() - Date.parse(row.last_message_at) < 5 * 60_000 ? 'seen_recently' : 'offline',
    })),
    page,
    hasMore: result.results.length === 50,
  });
};

const handleAdminDetail = async (request: Request, env: Env, admin: AdminUser, publicId: string) => {
  const conversation = await adminConversationByPublicId(env, publicId);
  if (!conversation) return apiError(request, env, 404, 'NOT_FOUND', 'Conversa não encontrada.');
  const row = await env.DB.prepare(`
    SELECT s.public_id AS quote_code, s.current_step, s.created_at AS session_created_at,
           qr.name, qr.company, qr.email_normalized, qr.phone_normalized, qr.project_type,
           qr.summary, qr.submitted_at, au.display_name AS assigned_to,
           e.minimum_amount, e.maximum_amount, e.estimated_days_min, e.estimated_days_max, e.pricing_version
    FROM conversations c
    JOIN quote_sessions s ON s.id = c.quote_session_id
    LEFT JOIN quote_requests qr ON qr.session_id = s.id
    LEFT JOIN quote_estimates e ON e.session_id = s.id
    LEFT JOIN admin_users au ON au.id = c.assigned_admin_id
    WHERE c.id = ?1
  `).bind(conversation.id).first<Record<string, unknown>>();
  const answers = await env.DB.prepare('SELECT question_key, answer_value FROM quote_answers WHERE session_id = ?1 ORDER BY id')
    .bind(conversation.quote_session_id).all<{ question_key: string; answer_value: string }>();
  const briefing: Record<string, unknown> = {};
  for (const answer of answers.results) {
    try { briefing[answer.question_key] = JSON.parse(answer.answer_value); } catch { /* Omit corrupt data. */ }
  }
  const safeRow = { ...row };
  if (!can(admin, 'viewPii')) {
    delete safeRow.email_normalized;
    delete safeRow.phone_normalized;
  }
  return json(request, env, {
    conversation: {
      publicId: conversation.public_id,
      status: conversation.status,
      assignedAdminId: conversation.assigned_admin_id,
      lastMessageAt: conversation.last_message_at,
      createdAt: conversation.created_at,
      ...safeRow,
    },
    briefing,
  });
};

const handleAdminMessages = async (request: Request, env: Env, admin: AdminUser, conversation: ConversationRow) => {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const afterRaw = url.searchParams.get('after');
    const after = afterRaw === null ? null : Number(afterRaw);
    if (after !== null && (!Number.isSafeInteger(after) || after < 0)) return apiError(request, env, 400, 'INVALID_CURSOR', 'Cursor inválido.');
    try {
      const history = await loadMessages(env, conversation.id, {
        before: url.searchParams.get('before'), after, limit: Number(url.searchParams.get('limit')) || 50,
      });
      const notes = can(admin, 'readNotes') ? await env.DB.prepare(`
        SELECT n.id, n.body, n.created_at, a.display_name
        FROM internal_notes n JOIN admin_users a ON a.id = n.admin_id
        WHERE n.conversation_id = ?1 ORDER BY n.created_at ASC
      `).bind(conversation.id).all<{ id: number; body: string; created_at: string; display_name: string }>() : { results: [] };
      return json(request, env, {
        ...history,
        notes: notes.results.map((note) => ({ id: `NOTE-${note.id}`, body: note.body, createdAt: note.created_at, author: note.display_name })),
        status: conversation.status,
      });
    } catch {
      return apiError(request, env, 400, 'INVALID_CURSOR', 'Cursor inválido.');
    }
  }
  const body = await parseJsonBody<unknown>(request, 4_096);
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) return apiError(request, env, 422, 'INVALID_MESSAGE', parsed.error.issues[0]?.message || 'Mensagem inválida.');
  const response = await callRoom(env, conversation, 'admin', admin.id, '/message', parsed.data);
  return json(request, env, await response.json(), response.status);
};

const handleAdminNote = async (request: Request, env: Env, admin: AdminUser, conversation: ConversationRow) => {
  const parsed = internalNoteSchema.safeParse(await parseJsonBody<unknown>(request, 4_096));
  if (!parsed.success) return apiError(request, env, 422, 'VALIDATION_ERROR', parsed.error.issues[0]?.message || 'Anotação inválida.');
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare('INSERT INTO internal_notes (conversation_id, admin_id, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
      .bind(conversation.id, admin.id, parsed.data.body, now),
    env.DB.prepare(`
      INSERT INTO conversation_events (conversation_id, event_type, actor_type, actor_id, metadata, created_at)
      VALUES (?1, 'internal_note_created', 'admin', ?2, NULL, ?3)
    `).bind(conversation.id, admin.id, now),
  ]);
  if (results.some((entry) => !entry.success)) throw new Error('Failed to save internal note');
  return json(request, env, { saved: true, createdAt: now }, 201);
};

const handleAdminSocket = async (request: Request, env: Env, admin: AdminUser, conversation?: ConversationRow) => {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return apiError(request, env, 426, 'UPGRADE_REQUIRED', 'WebSocket necessário.');
  if (!conversation) {
    const id = env.ADMIN_INBOX.idFromName('cogdev-admin-inbox');
    return env.ADMIN_INBOX.get(id).fetch('https://internal/socket', {
      headers: { Upgrade: 'websocket', 'X-Actor-Id': String(admin.id) },
    });
  }
  return roomStub(env, conversation).fetch('https://internal/socket', {
    headers: {
      Upgrade: 'websocket',
      'X-Conversation-Id': String(conversation.id),
      'X-Conversation-Public-Id': conversation.public_id,
      'X-Participant': 'admin',
      'X-Actor-Id': String(admin.id),
    },
  });
};

const handleAdminProposal = async (request: Request, env: Env, admin: AdminUser, conversation: ConversationRow) => {
  if (request.method === 'GET') {
    let proposal = await latestProposal(env, conversation.id);
    if (!proposal) return json(request, env, { proposal: null });
    proposal = await expireProposalIfNeeded(env, proposal);
    const payment = await latestPayment(env, proposal.id);
    return json(request, env, { proposal: proposalDto(proposal, payment, true) });
  }
  if (!can(admin, 'manageProposals')) return apiError(request, env, 403, 'ADMIN_FORBIDDEN', 'Sem permissão para definir valores e propostas.');
  const parsed = createProposalSchema.safeParse(await parseJsonBody<unknown>(request, 12_000));
  if (!parsed.success) return apiError(request, env, 422, 'VALIDATION_ERROR', 'Revise os dados da proposta.', validationDetails(parsed.error.issues));
  try {
    const proposal = await createProposal(env, conversation, admin, parsed.data);
    const announcement = proposalAnnouncement(proposal);
    const event = await callRoom(env, conversation, 'admin', admin.id, '/system', { body: announcement, eventType: 'proposal_sent' });
    if (!event.ok) throw new Error('Proposal announcement failed');
    const payment = await latestPayment(env, proposal.id);
    return json(request, env, { proposal: proposalDto(proposal, payment, true) }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_PAYMENT_URL') {
      return apiError(request, env, 422, 'INVALID_PAYMENT_URL', 'Use somente um link HTTPS de um domínio C6 autorizado.');
    }
    if (error instanceof Error && error.message === 'INVALID_VALIDITY') {
      return apiError(request, env, 422, 'INVALID_VALIDITY', 'A validade deve ficar entre uma hora e 180 dias.');
    }
    throw error;
  }
};

const handleAdminPaymentLink = async (request: Request, env: Env, admin: AdminUser, conversation: ConversationRow) => {
  if (!can(admin, 'manageProposals')) return apiError(request, env, 403, 'ADMIN_FORBIDDEN', 'Sem permissão para gerenciar pagamentos.');
  const parsed = paymentLinkSchema.safeParse(await parseJsonBody<unknown>(request, 4_096));
  if (!parsed.success) return apiError(request, env, 422, 'VALIDATION_ERROR', 'Link de pagamento inválido.');
  const paymentUrl = validateManualPaymentUrl(parsed.data.paymentUrl, env.C6_ALLOWED_PAYMENT_HOSTS);
  if (!paymentUrl) return apiError(request, env, 422, 'INVALID_PAYMENT_URL', 'Use somente um link HTTPS de um domínio C6 autorizado.');
  let proposal = await latestProposal(env, conversation.id);
  if (!proposal || proposal.payment_mode !== 'manual_payment_link') return apiError(request, env, 409, 'INVALID_PAYMENT_MODE', 'Esta proposta não usa link manual.');
  proposal = await expireProposalIfNeeded(env, proposal);
  if (['expired', 'cancelled'].includes(proposal.status)) return apiError(request, env, 409, 'PROPOSAL_NOT_ACTIVE', 'Envie uma nova proposta antes de cadastrar outro link.');
  if (proposal.status === 'payment_confirmed') return apiError(request, env, 409, 'PAYMENT_ALREADY_CONFIRMED', 'O pagamento desta proposta já foi confirmado.');
  const now = new Date().toISOString();
  const expiresAt = parsed.data.expiresAt || proposal.valid_until;
  const expiresAtMs = Date.parse(expiresAt);
  if (expiresAtMs <= Date.now() || expiresAtMs > Date.parse(proposal.valid_until)) {
    return apiError(request, env, 422, 'INVALID_PAYMENT_EXPIRY', 'A validade do link deve estar no futuro e não pode superar a validade da proposta.');
  }
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE payments SET status = 'expired', updated_at = ?1 WHERE proposal_id = ?2 AND status IN ('created', 'awaiting_payment', 'failed')")
      .bind(now, proposal.id),
    env.DB.prepare(`
      INSERT INTO payments
        (public_id, proposal_id, provider, amount, status, payment_url, idempotency_key, expires_at, created_at, updated_at)
      VALUES (?1, ?2, 'manual_c6', ?3, 'created', ?4, ?5, ?6, ?7, ?7)
    `).bind(`PAY-${randomToken(12).toUpperCase()}`, proposal.id, proposal.deposit_amount, paymentUrl, crypto.randomUUID(), expiresAt, now),
    env.DB.prepare(`
      INSERT INTO conversation_events (conversation_id, event_type, actor_type, actor_id, metadata, created_at)
      VALUES (?1, 'payment_link_updated', 'admin', ?2, ?3, ?4)
    `).bind(conversation.id, admin.id, JSON.stringify({ proposalPublicId: proposal.public_id, version: proposal.version }), now),
  ]);
  if (results.some((entry) => !entry.success)) throw new Error('Payment link could not be replaced');
  await callRoom(env, conversation, 'admin', admin.id, '/system', {
    body: 'O link de pagamento seguro desta proposta foi atualizado pela equipe Cog Dev.',
    eventType: 'payment_link_updated',
  });
  return json(request, env, { updated: true });
};

const handleAdminPaymentStatus = async (request: Request, env: Env, admin: AdminUser, conversation: ConversationRow) => {
  if (!can(admin, 'manageProposals')) return apiError(request, env, 403, 'ADMIN_FORBIDDEN', 'Sem permissão para confirmar pagamentos.');
  const body = await parseJsonBody<{ status?: unknown }>(request, 1_024);
  if (!['confirmed', 'failed'].includes(String(body.status))) return apiError(request, env, 422, 'INVALID_PAYMENT_STATUS', 'Status de pagamento inválido.');
  const proposal = await latestProposal(env, conversation.id);
  if (!proposal || proposal.payment_mode !== 'manual_payment_link') return apiError(request, env, 409, 'INVALID_PAYMENT_MODE', 'A confirmação manual não se aplica a esta proposta.');
  if (proposal.status === 'payment_confirmed') return json(request, env, { status: 'payment_confirmed', alreadyConfirmed: true });
  if (!['approved', 'awaiting_payment', 'payment_failed'].includes(proposal.status)) return apiError(request, env, 409, 'PAYMENT_NOT_PENDING', 'Esta proposta não aguarda pagamento.');
  const payment = await latestPayment(env, proposal.id);
  if (!payment) return apiError(request, env, 409, 'PAYMENT_NOT_FOUND', 'Nenhuma cobrança foi encontrada.');
  const now = new Date().toISOString();
  const confirmed = body.status === 'confirmed';
  const providerEventId = `manual-${crypto.randomUUID()}`;
  const results = await env.DB.batch([
    env.DB.prepare('UPDATE payments SET status = ?1, paid_at = ?2, updated_at = ?3 WHERE id = ?4')
      .bind(confirmed ? 'confirmed' : 'failed', confirmed ? now : null, now, payment.id),
    env.DB.prepare('UPDATE proposals SET status = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(confirmed ? 'payment_confirmed' : 'payment_failed', now, proposal.id),
    env.DB.prepare(`
      INSERT INTO payment_events (payment_id, provider_event_id, event_type, payload_hash, processed_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    `).bind(payment.id, providerEventId, confirmed ? 'manual_payment_confirmed' : 'manual_payment_failed', await sha256(`${payment.public_id}:${body.status}:${now}`), now),
    env.DB.prepare(`
      INSERT INTO conversation_events (conversation_id, event_type, actor_type, actor_id, metadata, created_at)
      VALUES (?1, ?2, 'admin', ?3, ?4, ?5)
    `).bind(conversation.id, confirmed ? 'payment_confirmed' : 'payment_failed', admin.id, JSON.stringify({ proposalPublicId: proposal.public_id }), now),
  ]);
  if (results.some((entry) => !entry.success)) throw new Error('Payment status could not be persisted');
  await callRoom(env, conversation, 'admin', admin.id, '/system', {
    body: confirmed ? 'Pagamento do valor inicial confirmado com segurança. A equipe Cog Dev dará continuidade ao projeto.' : 'O pagamento do valor inicial não foi confirmado. Fale com a equipe Cog Dev para revisar o checkout.',
    eventType: confirmed ? 'payment_confirmed' : 'payment_failed',
  });
  return json(request, env, { status: confirmed ? 'payment_confirmed' : 'payment_failed' });
};

const handleAdminRoutes = async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const path = url.pathname;
  const permission = path === '/api/admin/conversations' ? 'listConversations' : 'viewConversation';
  const auth = await requireAdmin(request, env, permission);
  if (auth.response) return auth.response;
  const { admin } = auth;

  if (path === '/api/admin/me' && request.method === 'GET') {
    return json(request, env, { displayName: admin.display_name, email: admin.email, role: admin.role });
  }
  if (path === '/api/admin/socket' && request.method === 'GET') return handleAdminSocket(request, env, admin);
  if (path === '/api/admin/conversations' && request.method === 'GET') return handleAdminList(request, env, admin);

  const match = path.match(/^\/api\/admin\/conversations\/([^/]+)(?:\/(messages|assign|status|read|notes|socket|proposals|payment-link|payment-status))?$/);
  if (!match) return apiError(request, env, 404, 'NOT_FOUND', 'Recurso administrativo não encontrado.');
  const publicId = decodeURIComponent(match[1]);
  const action = match[2] || 'detail';
  const conversation = await adminConversationByPublicId(env, publicId);
  if (!conversation) return apiError(request, env, 404, 'NOT_FOUND', 'Conversa não encontrada.');

  if (action === 'detail' && request.method === 'GET') return handleAdminDetail(request, env, admin, publicId);
  if (action === 'messages') {
    if (request.method === 'POST' && !can(admin, 'reply')) return apiError(request, env, 403, 'ADMIN_FORBIDDEN', 'Sem permissão para responder.');
    return handleAdminMessages(request, env, admin, conversation);
  }
  if (action === 'socket' && request.method === 'GET') return handleAdminSocket(request, env, admin, conversation);
  if (action === 'proposals' && ['GET', 'POST'].includes(request.method)) return handleAdminProposal(request, env, admin, conversation);
  if (action === 'payment-link' && request.method === 'POST') return handleAdminPaymentLink(request, env, admin, conversation);
  if (action === 'payment-status' && request.method === 'POST') return handleAdminPaymentStatus(request, env, admin, conversation);
  if (action === 'assign' && request.method === 'POST') {
    if (!can(admin, 'assign')) return apiError(request, env, 403, 'ADMIN_FORBIDDEN', 'Sem permissão para assumir atendimentos.');
    const response = await transitionRoom(env, conversation, 'admin', admin.id, 'active');
    return json(request, env, await response.json(), response.status);
  }
  if (action === 'status' && request.method === 'POST') {
    if (!can(admin, 'changeStatus')) return apiError(request, env, 403, 'ADMIN_FORBIDDEN', 'Sem permissão para alterar o estado.');
    const parsed = conversationTransitionSchema.safeParse(await parseJsonBody<unknown>(request, 1_024));
    if (!parsed.success) return apiError(request, env, 422, 'INVALID_STATUS', 'Estado inválido.');
    if (parsed.data.status === 'blocked' && !can(admin, 'block')) return apiError(request, env, 403, 'ADMIN_FORBIDDEN', 'Sem permissão para bloquear.');
    const response = await transitionRoom(env, conversation, 'admin', admin.id, parsed.data.status);
    return json(request, env, await response.json(), response.status);
  }
  if (action === 'read' && request.method === 'POST') {
    await env.DB.prepare('UPDATE conversations SET admin_last_read_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), conversation.id).run();
    return json(request, env, { read: true });
  }
  if (action === 'notes' && request.method === 'POST') {
    if (!can(admin, 'writeNotes')) return apiError(request, env, 403, 'ADMIN_FORBIDDEN', 'Sem permissão para criar anotações.');
    return handleAdminNote(request, env, admin, conversation);
  }
  return apiError(request, env, 405, 'METHOD_NOT_ALLOWED', 'Ação não permitida.');
};

const handleSubmitQuote = async (request: Request, env: Env) => {
  const auth = await requireActiveSession(request, env);
  if (auth.response) return auth.response;
  const { session } = auth;
  const csrfError = await requireCsrf(request, env, session);
  if (csrfError) return csrfError;

  const parsed = submitQuoteSchema.safeParse(await parseJsonBody<unknown>(request));
  if (!parsed.success) {
    return apiError(request, env, 422, 'VALIDATION_ERROR', 'Há informações que precisam ser revisadas antes do envio.', validationDetails(parsed.error.issues));
  }
  const idempotencyHeader = request.headers.get('Idempotency-Key');
  if (idempotencyHeader !== parsed.data.idempotencyKey) {
    return apiError(request, env, 400, 'INVALID_IDEMPOTENCY_KEY', 'Não foi possível validar este envio. Atualize a página e tente novamente.');
  }

  if (session.status === 'submitted') {
    const existingKey = await env.DB.prepare('SELECT idempotency_key FROM quote_requests WHERE session_id = ?1')
      .bind(session.id).first<{ idempotency_key: string }>();
    if (!existingKey || existingKey.idempotency_key !== parsed.data.idempotencyKey) {
      return apiError(request, env, 409, 'ALREADY_SUBMITTED', 'Este orçamento já foi enviado.');
    }
    const stored = await findStoredQuote(env, session.id);
    const conversation = await conversationForSession(env, session.id);
    if (conversation.status === 'bot_collecting') {
      await transitionRoom(env, conversation, 'client', null, 'waiting_admin');
    }
    return stored
      ? json(request, env, storedQuoteResponse(env, stored, parsed.data.quote.name))
      : apiError(request, env, 503, 'TEMPORARY_ERROR', 'Não conseguimos recuperar a confirmação agora. Tente novamente em alguns segundos.');
  }

  const ipKey = await getClientIpKey(request, env);
  const ipLimited = await enforceLimit(request, env, 'submit-ip', ipKey, 3, 3_600);
  if (ipLimited) return ipLimited;
  const sessionKey = await sha256(String(session.id));
  const sessionLimited = await enforceLimit(request, env, 'submit-session', sessionKey, 3, 3_600);
  if (sessionLimited) return sessionLimited;

  const turnstileValid = await validateTurnstile(
    request,
    env,
    parsed.data.quote.turnstileToken,
    parsed.data.idempotencyKey,
  );
  if (!turnstileValid) {
    return apiError(request, env, 403, 'BOT_CHECK_FAILED', 'A verificação de segurança expirou ou falhou. Faça a verificação novamente.');
  }

  const quote = parsed.data.quote;
  const normalized = normalizeContact(quote.contact.method, quote.contact.value);
  if (!normalized) {
    return apiError(request, env, 422, 'VALIDATION_ERROR', 'Revise a forma de contato informada.');
  }

  const now = new Date().toISOString();
  const estimate: Estimate | null = env.ENABLE_SAMPLE_PRICING === 'true'
    ? calculateSampleEstimate(quote)
    : null;
  const { turnstileToken: _discarded, ...safeQuote } = quote;
  const statements = [
    env.DB.prepare(`
      INSERT INTO quote_requests
        (session_id, idempotency_key, name, company, email_normalized, phone_normalized,
         project_type, summary, status, consent_at, submitted_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'received', ?9, ?9)
    `).bind(
      session.id,
      parsed.data.idempotencyKey,
      quote.name,
      quote.company || null,
      quote.contact.method === 'email' ? normalized : null,
      quote.contact.method === 'whatsapp' ? normalized : null,
      quote.projectType,
      JSON.stringify(safeQuote),
      now,
    ),
    env.DB.prepare(`
      UPDATE quote_sessions
      SET status = 'submitted', updated_at = ?1, pricing_version = ?2
      WHERE id = ?3 AND status = 'in_progress'
    `).bind(now, estimate?.pricingVersion || null, session.id),
  ];
  if (estimate) {
    statements.push(env.DB.prepare(`
      INSERT INTO quote_estimates
        (session_id, minimum_amount, maximum_amount, estimated_days_min, estimated_days_max, pricing_version, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).bind(
      session.id,
      estimate.minimumAmount,
      estimate.maximumAmount,
      estimate.estimatedDaysMin,
      estimate.estimatedDaysMax,
      estimate.pricingVersion,
      now,
    ));
  }

  const results = await env.DB.batch(statements);
  if (results.some((entry) => !entry.success)) throw new Error('Failed to persist quote');
  const stored = await findStoredQuote(env, session.id);
  if (!stored) throw new Error('Persisted quote could not be read');

  const conversation = await conversationForSession(env, session.id);
  if (conversation.status === 'bot_collecting') {
    const queued = await transitionRoom(env, conversation, 'client', null, 'waiting_admin');
    if (!queued.ok) throw new Error('Quote persisted but conversation could not be queued');
  }

  console.log(JSON.stringify({ event: 'quote_submitted', projectType: quote.projectType, hasEstimate: Boolean(estimate) }));
  return json(request, env, storedQuoteResponse(env, stored, quote.name), 201);
};

const handleApi = async (request: Request, env: Env) => {
  if (!requestOriginIsAllowed(request, env)) {
    return apiError(request, env, 403, 'ORIGIN_NOT_ALLOWED', 'Esta origem não está autorizada a usar o serviço.');
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: responseHeaders(request, env, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, Idempotency-Key',
        'Access-Control-Max-Age': '600',
      }),
    });
  }

  const url = new URL(request.url);
  if (url.pathname === '/api/config' && request.method === 'GET') {
    return json(request, env, {
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
      turnstileRequired: env.ENVIRONMENT === 'production' || Boolean(env.TURNSTILE_SECRET_KEY),
      pricingEnabled: env.ENABLE_SAMPLE_PRICING === 'true',
      retentionDays: Math.max(1, Math.min(730, Number(env.RETENTION_DAYS) || 180)),
    });
  }
  if (url.pathname.startsWith('/api/admin/')) return handleAdminRoutes(request, env);
  if (url.pathname === '/api/payments/webhooks/c6' && request.method === 'POST') return handleC6Webhook(request, env);
  if (url.pathname === '/api/session' && request.method === 'POST') return handleCreateSession(request, env);
  if (url.pathname === '/api/session' && request.method === 'GET') return handleGetSession(request, env);
  if (url.pathname === '/api/session' && request.method === 'DELETE') return handleDeleteSession(request, env);
  if (url.pathname === '/api/session/answer' && request.method === 'PUT') return handleSaveAnswer(request, env);
  if (url.pathname === '/api/quote' && request.method === 'POST') return handleSubmitQuote(request, env);
  if (url.pathname === '/api/conversations/current' && request.method === 'GET') return handleConversationCurrent(request, env);
  if (url.pathname === '/api/conversations/current/messages' && ['GET', 'POST'].includes(request.method)) return handleClientMessages(request, env);
  if (url.pathname === '/api/conversations/current/request-human' && request.method === 'POST') return handleRequestHuman(request, env);
  if (url.pathname === '/api/conversations/current/read' && request.method === 'POST') return handleClientRead(request, env);
  if (url.pathname === '/api/conversations/current/resolve' && request.method === 'POST') return handleClientResolve(request, env);
  if (url.pathname === '/api/conversations/current/socket' && request.method === 'GET') return handleClientSocket(request, env);
  if (url.pathname === '/api/proposals/current' && request.method === 'GET') return handleClientProposal(request, env);
  if (url.pathname === '/api/proposals/current/accept' && request.method === 'POST') return handleAcceptProposal(request, env);
  if (url.pathname === '/api/proposals/current/checkout' && request.method === 'POST') return handleCreateCheckout(request, env);

  return apiError(request, env, 404, 'NOT_FOUND', 'O recurso solicitado não foi encontrado.');
};

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env);
      return new Response('Recurso não encontrado.', {
        status: 404,
        headers: responseHeaders(request, env, { 'Content-Type': 'text/plain; charset=utf-8' }),
      });
    } catch (error) {
      if (error instanceof RequestBodyError) {
        const status = error.code === 'PAYLOAD_TOO_LARGE' ? 413 : error.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : 400;
        const message = error.code === 'PAYLOAD_TOO_LARGE'
          ? 'A solicitação excedeu o tamanho permitido.'
          : 'Não foi possível interpretar esta solicitação.';
        return apiError(request, env, status, error.code, message);
      }
      console.error(JSON.stringify({ event: 'unhandled_error', path: new URL(request.url).pathname }));
      return apiError(request, env, 503, 'TEMPORARY_ERROR', 'Não conseguimos registrar sua resposta agora. Tente novamente em alguns segundos.');
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const now = new Date();
      const retentionDays = Math.max(1, Math.min(730, Number(env.RETENTION_DAYS) || 180));
      const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE quote_sessions SET status = 'expired', updated_at = ?1 WHERE status = 'in_progress' AND expires_at <= ?1").bind(now.toISOString()),
        env.DB.prepare("UPDATE proposals SET status = 'expired', updated_at = ?1 WHERE valid_until <= ?1 AND status NOT IN ('payment_confirmed', 'cancelled', 'expired')").bind(now.toISOString()),
        env.DB.prepare("UPDATE payments SET status = 'expired', updated_at = ?1 WHERE status IN ('created', 'awaiting_payment') AND (expires_at <= ?1 OR proposal_id IN (SELECT id FROM proposals WHERE status = 'expired'))").bind(now.toISOString()),
        env.DB.prepare("DELETE FROM quote_sessions WHERE status = 'expired' AND expires_at <= ?1").bind(now.toISOString()),
        env.DB.prepare('DELETE FROM quote_sessions WHERE id IN (SELECT session_id FROM quote_requests WHERE submitted_at < ?1)').bind(cutoff),
        env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?1').bind(Math.floor(now.getTime() / 1_000)),
      ]);
    })());
  },
};

export default worker;
