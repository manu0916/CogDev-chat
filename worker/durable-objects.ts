import { DurableObject } from 'cloudflare:workers';
import {
  conversationTransitionSchema,
  readEventSchema,
  sendMessageSchema,
  typingEventSchema,
  type ConversationStatus,
} from '../shared/contracts';
import { messageDto } from './conversations';
import { randomToken } from './security';
import type { ConversationRow, Env } from './types';
import { z } from 'zod';
import { canTransition, type Participant } from './conversation-policy';

type SocketAttachment = {
  participant: Participant;
  actorId: number | null;
  connectionId: string;
  conversationId: number;
  publicId: string;
};

const eventCopy: Record<ConversationStatus, string> = {
  bot_collecting: 'O briefing voltou para o assistente.',
  waiting_admin: 'Recebemos seu pedido. Um especialista da Cog Dev responderá por aqui.',
  active: 'Um especialista da Cog Dev entrou na conversa.',
  waiting_client: 'A equipe Cog Dev está aguardando sua resposta.',
  resolved: 'Este atendimento foi finalizado.',
  blocked: 'Esta conversa foi encerrada por segurança.',
  expired: 'Esta sessão expirou.',
};

export class ConversationRoom extends DurableObject<Env> {
  private send(ws: WebSocket, payload: unknown) {
    try { ws.send(JSON.stringify(payload)); } catch { /* Connection will be cleaned up by the runtime. */ }
  }

  private broadcast(payload: unknown, except?: WebSocket) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) this.send(socket, payload);
    }
  }

  private async notifyInbox(payload: unknown) {
    const id = this.env.ADMIN_INBOX.idFromName('cogdev-admin-inbox');
    await this.env.ADMIN_INBOX.get(id).fetch('https://internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  private async consume(key: string, limit: number, windowSeconds = 60) {
    const bucket = Math.floor(Date.now() / 1_000 / windowSeconds) * windowSeconds;
    const storageKey = `rate:${key}:${bucket}`;
    const count = (await this.ctx.storage.get<number>(storageKey)) || 0;
    if (count >= limit) return false;
    await this.ctx.storage.put(storageKey, count + 1);
    return true;
  }

  private attachment(ws: WebSocket) {
    return ws.deserializeAttachment() as SocketAttachment | null;
  }

  private async currentConversation(conversationId: number) {
    return this.env.DB.prepare('SELECT * FROM conversations WHERE id = ?1')
      .bind(conversationId).first<ConversationRow>();
  }

  private async persistMessage(
    attachment: SocketAttachment,
    raw: unknown,
  ) {
    const parsed = sendMessageSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, status: 422, code: 'INVALID_MESSAGE', message: parsed.error.issues[0]?.message || 'Mensagem inválida.' };
    const limit = attachment.participant === 'client' ? 20 : 60;
    if (!await this.consume(`message:${attachment.participant}:${attachment.actorId || attachment.conversationId}`, limit)) {
      return { ok: false as const, status: 429, code: 'RATE_LIMITED', message: 'Muitas mensagens em pouco tempo. Aguarde alguns instantes.' };
    }

    const senderType = attachment.participant;
    const existing = await this.env.DB.prepare(`
      SELECT public_id, sequence, sender_type, message_type, body, client_message_id, created_at
      FROM messages
      WHERE conversation_id = ?1 AND sender_type = ?2 AND client_message_id = ?3
    `).bind(attachment.conversationId, senderType, parsed.data.clientMessageId)
      .first<Parameters<typeof messageDto>[0]>();
    if (existing) return { ok: true as const, message: messageDto(existing), duplicate: true };

    const conversation = await this.currentConversation(attachment.conversationId);
    if (!conversation) return { ok: false as const, status: 404, code: 'NOT_FOUND', message: 'Conversa não encontrada.' };
    if (conversation.status === 'blocked') return { ok: false as const, status: 403, code: 'BLOCKED', message: 'Esta conversa está bloqueada.' };
    if (conversation.status === 'resolved' || conversation.status === 'expired' || conversation.status === 'bot_collecting') {
      return { ok: false as const, status: 409, code: 'CONVERSATION_CLOSED', message: 'O atendimento não está aberto para novas mensagens.' };
    }
    if (attachment.participant === 'admin' && !conversation.assigned_admin_id) {
      return { ok: false as const, status: 409, code: 'NOT_ASSIGNED', message: 'Assuma o atendimento antes de responder.' };
    }
    if (attachment.participant === 'admin' && conversation.assigned_admin_id !== attachment.actorId) {
      return { ok: false as const, status: 403, code: 'NOT_ASSIGNED', message: 'Este atendimento está atribuído a outro especialista.' };
    }

    const sequenceRow = await this.env.DB.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE conversation_id = ?1')
      .bind(attachment.conversationId).first<{ next: number }>();
    const sequence = sequenceRow?.next || 1;
    const now = new Date().toISOString();
    const publicId = `MSG-${randomToken(12).toUpperCase()}`;
    const nextStatus: ConversationStatus = attachment.participant === 'admin'
      ? 'waiting_client'
      : conversation.status === 'waiting_client' ? 'active' : conversation.status;
    const statements = [
      this.env.DB.prepare(`
        INSERT INTO messages
          (conversation_id, public_id, sequence, sender_type, sender_id, message_type, body, client_message_id, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'text', ?6, ?7, ?8)
      `).bind(
        attachment.conversationId,
        publicId,
        sequence,
        senderType,
        attachment.actorId,
        parsed.data.body,
        parsed.data.clientMessageId,
        now,
      ),
      this.env.DB.prepare(`
        UPDATE conversations
        SET status = ?1, last_message_at = ?2, updated_at = ?2
        WHERE id = ?3
      `).bind(nextStatus, now, attachment.conversationId),
    ];
    const results = await this.env.DB.batch(statements);
    if (results.some((entry) => !entry.success)) {
      return { ok: false as const, status: 503, code: 'PERSISTENCE_FAILED', message: 'Não foi possível enviar agora. Tente novamente.' };
    }
    const message = messageDto({
      public_id: publicId,
      sequence,
      sender_type: senderType,
      message_type: 'text',
      body: parsed.data.body,
      client_message_id: parsed.data.clientMessageId,
      created_at: now,
    });
    this.broadcast({ type: 'message', message, status: nextStatus });
    await this.notifyInbox({
      type: 'conversation_update',
      publicId: attachment.publicId,
      status: nextStatus,
      lastMessageAt: now,
      senderType,
      preview: parsed.data.body.slice(0, 120),
    });
    return { ok: true as const, message, duplicate: false };
  }

  private async transition(attachment: SocketAttachment, raw: unknown) {
    const parsed = conversationTransitionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, status: 422, code: 'INVALID_STATUS', message: 'Estado inválido.' };
    const conversation = await this.currentConversation(attachment.conversationId);
    if (!conversation) return { ok: false as const, status: 404, code: 'NOT_FOUND', message: 'Conversa não encontrada.' };
    if (!canTransition(attachment.participant, conversation.status, parsed.data.status)) {
      return { ok: false as const, status: 409, code: 'INVALID_TRANSITION', message: 'Esta mudança de estado não é permitida.' };
    }
    const sequenceRow = await this.env.DB.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE conversation_id = ?1')
      .bind(attachment.conversationId).first<{ next: number }>();
    const sequence = sequenceRow?.next || 1;
    const now = new Date().toISOString();
    const messageId = `MSG-${randomToken(12).toUpperCase()}`;
    const resolvedAt = parsed.data.status === 'resolved' ? now : null;
    const blockedAt = parsed.data.status === 'blocked' ? now : null;
    const assignId = attachment.participant === 'admin' && parsed.data.status === 'active' ? attachment.actorId : conversation.assigned_admin_id;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        UPDATE conversations
        SET status = ?1, assigned_admin_id = ?2, updated_at = ?3, last_message_at = ?3,
            resolved_at = ?4, blocked_at = ?5
        WHERE id = ?6
      `).bind(parsed.data.status, assignId, now, resolvedAt, blockedAt, attachment.conversationId),
      this.env.DB.prepare(`
        INSERT INTO messages
          (conversation_id, public_id, sequence, sender_type, sender_id, message_type, body, created_at)
        VALUES (?1, ?2, ?3, 'system', ?4, 'system_event', ?5, ?6)
      `).bind(attachment.conversationId, messageId, sequence, attachment.actorId, eventCopy[parsed.data.status], now),
      this.env.DB.prepare(`
        INSERT INTO conversation_events (conversation_id, event_type, actor_type, actor_id, metadata, created_at)
        VALUES (?1, 'status_changed', ?2, ?3, ?4, ?5)
      `).bind(
        attachment.conversationId,
        attachment.participant,
        attachment.actorId,
        JSON.stringify({ from: conversation.status, to: parsed.data.status }),
        now,
      ),
    ]);
    if (results.some((entry) => !entry.success)) {
      return { ok: false as const, status: 503, code: 'PERSISTENCE_FAILED', message: 'Não foi possível atualizar o atendimento.' };
    }
    const systemMessage = messageDto({
      public_id: messageId,
      sequence,
      sender_type: 'system',
      message_type: 'system_event',
      body: eventCopy[parsed.data.status],
      client_message_id: null,
      created_at: now,
    });
    this.broadcast({ type: 'status', status: parsed.data.status, message: systemMessage });
    await this.notifyInbox({
      type: 'conversation_update',
      publicId: attachment.publicId,
      status: parsed.data.status,
      lastMessageAt: now,
      senderType: 'system',
      preview: eventCopy[parsed.data.status],
    });
    return { ok: true as const, status: parsed.data.status, message: systemMessage };
  }

  private async systemAnnouncement(attachment: SocketAttachment, raw: unknown) {
    if (attachment.participant !== 'admin') return { ok: false as const, status: 403, code: 'FORBIDDEN', message: 'Ação não permitida.' };
    const parsed = z.object({ body: z.string().trim().min(1).max(2_000), eventType: z.enum(['proposal_sent', 'payment_confirmed', 'payment_failed', 'payment_link_updated']) }).strict().safeParse(raw);
    if (!parsed.success) return { ok: false as const, status: 422, code: 'INVALID_ANNOUNCEMENT', message: 'Evento inválido.' };
    const sequenceRow = await this.env.DB.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM messages WHERE conversation_id = ?1')
      .bind(attachment.conversationId).first<{ next: number }>();
    const sequence = sequenceRow?.next || 1;
    const now = new Date().toISOString();
    const messageId = `MSG-${randomToken(12).toUpperCase()}`;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`
        INSERT INTO messages (conversation_id, public_id, sequence, sender_type, sender_id, message_type, body, created_at)
        VALUES (?1, ?2, ?3, 'system', ?4, 'system_event', ?5, ?6)
      `).bind(attachment.conversationId, messageId, sequence, attachment.actorId, parsed.data.body, now),
      this.env.DB.prepare('UPDATE conversations SET last_message_at = ?1, updated_at = ?1 WHERE id = ?2').bind(now, attachment.conversationId),
      this.env.DB.prepare(`
        INSERT INTO conversation_events (conversation_id, event_type, actor_type, actor_id, metadata, created_at)
        VALUES (?1, ?2, 'admin', ?3, NULL, ?4)
      `).bind(attachment.conversationId, parsed.data.eventType, attachment.actorId, now),
    ]);
    if (results.some((entry) => !entry.success)) return { ok: false as const, status: 503, code: 'PERSISTENCE_FAILED', message: 'Não foi possível registrar o evento.' };
    const message = messageDto({ public_id: messageId, sequence, sender_type: 'system', message_type: 'system_event', body: parsed.data.body, client_message_id: null, created_at: now });
    this.broadcast({ type: 'proposal', eventType: parsed.data.eventType, message });
    await this.notifyInbox({ type: 'conversation_update', publicId: attachment.publicId, status: (await this.currentConversation(attachment.conversationId))?.status, lastMessageAt: now, senderType: 'system', preview: parsed.data.body.slice(0, 120) });
    return { ok: true as const, message };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const conversationId = Number(request.headers.get('X-Conversation-Id'));
    const publicId = request.headers.get('X-Conversation-Public-Id') || '';
    const participant = request.headers.get('X-Participant') as Participant;
    const actorId = Number(request.headers.get('X-Actor-Id')) || null;
    if (!Number.isSafeInteger(conversationId) || conversationId < 1 || !['client', 'admin'].includes(participant) || !publicId) {
      return Response.json({ error: { code: 'INVALID_INTERNAL_REQUEST' } }, { status: 400 });
    }
    const attachment: SocketAttachment = {
      participant,
      actorId,
      connectionId: crypto.randomUUID(),
      conversationId,
      publicId,
    };

    if (url.pathname === '/socket') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
      const connectionLimit = participant === 'client' ? 5 : 10;
      if (this.ctx.getWebSockets(participant).length >= connectionLimit) {
        return Response.json({ error: { code: 'TOO_MANY_CONNECTIONS' } }, { status: 429 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [participant]);
      server.serializeAttachment(attachment);
      this.broadcast({ type: 'presence', participant, online: true, approximate: true });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/message' && request.method === 'POST') {
      const result = await this.persistMessage(attachment, await request.json());
      return Response.json(result.ok ? { message: result.message, duplicate: result.duplicate } : { error: result }, { status: result.ok ? 200 : result.status });
    }
    if (url.pathname === '/transition' && request.method === 'POST') {
      const result = await this.transition(attachment, await request.json());
      return Response.json(result.ok ? result : { error: result }, { status: result.ok ? 200 : result.status });
    }
    if (url.pathname === '/system' && request.method === 'POST') {
      const result = await this.systemAnnouncement(attachment, await request.json());
      return Response.json(result.ok ? result : { error: result }, { status: result.ok ? 200 : result.status });
    }
    return new Response(null, { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachment = this.attachment(ws);
    if (!attachment) return ws.close(1008, 'Invalid session');
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(text).byteLength > 4_096) {
      this.send(ws, { type: 'error', code: 'PAYLOAD_TOO_LARGE', message: 'Mensagem muito grande.' });
      return;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch {
      this.send(ws, { type: 'error', code: 'INVALID_JSON', message: 'Mensagem inválida.' });
      return;
    }
    const typed = typingEventSchema.safeParse(raw);
    if (typed.success) {
      if (!await this.consume(`typing:${attachment.participant}:${attachment.actorId || attachment.conversationId}`, 30)) return;
      for (const socket of this.ctx.getWebSockets()) {
        const other = this.attachment(socket);
        if (socket !== ws && other?.participant !== attachment.participant) {
          this.send(socket, { type: 'typing', from: attachment.participant, active: typed.data.active, expiresAt: Date.now() + 4_000 });
        }
      }
      return;
    }
    const read = readEventSchema.safeParse(raw);
    if (read.success) {
      const field = attachment.participant === 'client' ? 'client_last_read_at' : 'admin_last_read_at';
      await this.env.DB.prepare(`UPDATE conversations SET ${field} = ?1 WHERE id = ?2`).bind(new Date().toISOString(), attachment.conversationId).run();
      return;
    }
    const result = await this.persistMessage(attachment, raw);
    this.send(ws, result.ok
      ? { type: 'ack', clientMessageId: result.message.clientMessageId, message: result.message, duplicate: result.duplicate }
      : { type: 'error', clientMessageId: (raw as { clientMessageId?: string })?.clientMessageId, code: result.code, message: result.message });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const attachment = this.attachment(ws);
    if (attachment) this.broadcast({ type: 'presence', participant: attachment.participant, online: false, approximate: true });
    try { ws.close(code, reason); } catch { /* Already closed. */ }
    void wasClean;
  }

  async webSocketError(ws: WebSocket) {
    try { ws.close(1011, 'Connection error'); } catch { /* Already closed. */ }
  }
}

export class AdminInbox extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/socket') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
      const actorId = request.headers.get('X-Actor-Id') || '';
      if (!actorId) return new Response(null, { status: 400 });
      if (this.ctx.getWebSockets(`admin:${actorId}`).length >= 5) return new Response(null, { status: 429 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [`admin:${actorId}`]);
      pair[1].serializeAttachment({ actorId, connectionId: crypto.randomUUID() });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const payload = JSON.stringify(await request.json());
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(payload); } catch { /* Runtime cleans up stale sockets. */ }
      }
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') ws.send('pong');
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason); } catch { /* Already closed. */ }
  }
}
