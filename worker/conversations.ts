import type { ConversationStatus } from '../shared/contracts';
import { randomToken, sha256 } from './security';
import type { ConversationRow, Env } from './types';

export const ensureConversation = async (env: Env, quoteSessionId: number): Promise<ConversationRow> => {
  const existing = await env.DB.prepare('SELECT * FROM conversations WHERE quote_session_id = ?1')
    .bind(quoteSessionId).first<ConversationRow>();
  if (existing) return existing;
  const now = new Date().toISOString();
  const publicId = `CHAT-${randomToken(12).toUpperCase()}`;
  await env.DB.prepare(`
    INSERT INTO conversations (public_id, quote_session_id, status, created_at, updated_at)
    VALUES (?1, ?2, 'bot_collecting', ?3, ?3)
  `).bind(publicId, quoteSessionId, now).run();
  const created = await env.DB.prepare('SELECT * FROM conversations WHERE quote_session_id = ?1')
    .bind(quoteSessionId).first<ConversationRow>();
  if (!created) throw new Error('Conversation could not be created');
  return created;
};

export const roomStub = (env: Env, conversation: ConversationRow) => {
  const id = env.CONVERSATIONS.idFromName(conversation.public_id);
  return env.CONVERSATIONS.get(id);
};

const hmac = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '').slice(0, 22);
};

export const makeCursor = async (env: Env, conversationId: number, sequence: number) => {
  const payload = `${conversationId}:${sequence}`;
  const encoded = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const signature = await hmac(payload, env.RATE_LIMIT_SALT || 'local-development-only');
  return `${encoded}.${signature}`;
};

export const readCursor = async (env: Env, conversationId: number, cursor: string) => {
  if (!/^[A-Za-z0-9_-]{3,80}\.[A-Za-z0-9_-]{10,30}$/.test(cursor)) return null;
  const [encoded, signature] = cursor.split('.');
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
    const payload = atob(padded);
    const [id, sequence] = payload.split(':').map(Number);
    if (id !== conversationId || !Number.isSafeInteger(sequence) || sequence < 1) return null;
    const expected = await hmac(payload, env.RATE_LIMIT_SALT || 'local-development-only');
    if (signature.length !== expected.length) return null;
    let mismatch = 0;
    for (let index = 0; index < signature.length; index += 1) mismatch |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
    return mismatch === 0 ? sequence : null;
  } catch {
    return null;
  }
};

export type MessageDto = {
  id: string;
  sequence: number;
  senderType: 'client' | 'assistant' | 'admin' | 'system';
  senderLabel: string;
  messageType: 'text' | 'system_event';
  body: string;
  clientMessageId: string | null;
  createdAt: string;
};

export const messageDto = (row: {
  public_id: string;
  sequence: number;
  sender_type: MessageDto['senderType'];
  message_type: MessageDto['messageType'];
  body: string;
  client_message_id: string | null;
  created_at: string;
}): MessageDto => ({
  id: row.public_id,
  sequence: row.sequence,
  senderType: row.sender_type,
  senderLabel: row.sender_type === 'admin' ? 'Equipe Cog Dev' : row.sender_type === 'client' ? 'Você' : row.sender_type === 'assistant' ? 'Assistente Cog Dev' : 'Sistema',
  messageType: row.message_type,
  body: row.body,
  clientMessageId: row.client_message_id,
  createdAt: row.created_at,
});

export const loadMessages = async (
  env: Env,
  conversationId: number,
  options: { before?: string | null; after?: number | null; limit?: number },
) => {
  const limit = Math.max(1, Math.min(50, options.limit || 30));
  let rows: Array<Parameters<typeof messageDto>[0]> = [];
  if (options.after !== undefined && options.after !== null) {
    const result = await env.DB.prepare(`
      SELECT public_id, sequence, sender_type, message_type, body, client_message_id, created_at
      FROM messages WHERE conversation_id = ?1 AND sequence > ?2 AND deleted_at IS NULL
      ORDER BY sequence ASC LIMIT ?3
    `).bind(conversationId, options.after, limit).all<Parameters<typeof messageDto>[0]>();
    rows = result.results;
  } else if (options.before) {
    const sequence = await readCursor(env, conversationId, options.before);
    if (!sequence) throw new Error('INVALID_CURSOR');
    const result = await env.DB.prepare(`
      SELECT public_id, sequence, sender_type, message_type, body, client_message_id, created_at
      FROM messages WHERE conversation_id = ?1 AND sequence < ?2 AND deleted_at IS NULL
      ORDER BY sequence DESC LIMIT ?3
    `).bind(conversationId, sequence, limit).all<Parameters<typeof messageDto>[0]>();
    rows = result.results.reverse();
  } else {
    const result = await env.DB.prepare(`
      SELECT public_id, sequence, sender_type, message_type, body, client_message_id, created_at
      FROM messages WHERE conversation_id = ?1 AND deleted_at IS NULL
      ORDER BY sequence DESC LIMIT ?2
    `).bind(conversationId, limit).all<Parameters<typeof messageDto>[0]>();
    rows = result.results.reverse();
  }
  return {
    messages: rows.map(messageDto),
    nextCursor: rows.length === limit ? await makeCursor(env, conversationId, rows[0].sequence) : null,
  };
};

export const statusLabel = (status: ConversationStatus) => ({
  bot_collecting: 'Briefing em andamento',
  waiting_admin: 'Aguardando especialista',
  active: 'Atendimento iniciado',
  waiting_client: 'Aguardando sua resposta',
  resolved: 'Atendimento finalizado',
  blocked: 'Conversa bloqueada',
  expired: 'Sessão expirada',
}[status]);

export const anonymousSessionKey = (sessionId: number) => sha256(`session:${sessionId}`);
