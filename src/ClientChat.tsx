import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Check, CircleAlert, Clock3, LoaderCircle, RefreshCw, Send, Signal, SignalLow, XCircle } from 'lucide-react';
import { ApiError, api, websocketUrl, type ChatMessage, type ConversationStatus, type Proposal } from './api';
import { ProposalReview } from './ProposalReview';

type PendingMessage = {
  clientMessageId: string;
  body: string;
  state: 'sending' | 'failed';
  error?: string;
};

type Props = {
  initialStatus: ConversationStatus;
  onStatus: (status: ConversationStatus) => void;
};

const sortMessages = (messages: ChatMessage[]) => [...messages].sort((a, b) => a.sequence - b.sequence);

const mergeMessages = (current: ChatMessage[], incoming: ChatMessage[]) => {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return sortMessages([...byId.values()]);
};

const timeLabel = (value: string) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

export function ClientChat({ initialStatus, onStatus }: Props) {
  const [status, setStatus] = useState(initialStatus);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [adminTyping, setAdminTyping] = useState(false);
  const [adminOnline, setAdminOnline] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  const typingTimer = useRef<number | null>(null);
  const typingExpiry = useRef<number | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const latestSequence = useMemo(() => messages.at(-1)?.sequence || 0, [messages]);
  const latestSequenceRef = useRef(0);
  const canSend = ['waiting_admin', 'active', 'waiting_client'].includes(status);

  const updateStatus = useCallback((next: ConversationStatus) => {
    setStatus(next);
    onStatus(next);
  }, [onStatus]);

  useEffect(() => { latestSequenceRef.current = latestSequence; }, [latestSequence]);

  const nearBottom = () => {
    const panel = threadRef.current?.closest('.messages');
    if (!panel) return true;
    return panel.scrollHeight - panel.scrollTop - panel.clientHeight < 140;
  };

  const addMessages = useCallback((incoming: ChatMessage[]) => {
    const shouldScroll = nearBottom();
    setMessages((current) => mergeMessages(current, incoming));
    if (shouldScroll) window.setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
    else setNewBelow((count) => count + incoming.length);
  }, []);

  const loadHistory = useCallback(async (options?: { after?: number; before?: string }) => {
    const history = await api.messages(options);
    addMessages(history.messages);
    setOlderCursor(history.nextCursor);
    updateStatus(history.status);
    const last = history.messages.at(-1)?.sequence;
    if (last) void api.markRead(last).catch(() => undefined);
  }, [addMessages, updateStatus]);

  const refreshProposal = useCallback(async () => {
    const response = await api.proposal();
    setProposal(response.proposal);
  }, []);

  useEffect(() => {
    void Promise.all([loadHistory(), refreshProposal()]).catch((caught) => setError(caught instanceof Error ? caught.message : 'Não foi possível carregar o histórico.')).finally(() => setLoading(false));
  }, [loadHistory, refreshProposal]);

  useEffect(() => {
    const poll = window.setInterval(() => void refreshProposal().catch(() => undefined), 12_000);
    return () => window.clearInterval(poll);
  }, [refreshProposal]);

  useEffect(() => {
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      setConnection('connecting');
      const socket = new WebSocket(websocketUrl('/api/conversations/current/socket'));
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        reconnectAttempt.current = 0;
        setConnection('online');
        void loadHistory({ after: latestSequenceRef.current }).catch(() => undefined);
      });
      socket.addEventListener('message', (event) => {
        let payload: any;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (payload.type === 'message' || payload.type === 'ack') {
          const message = payload.message as ChatMessage;
          if (message) {
            addMessages([message]);
            if (message.clientMessageId) setPending((items) => items.filter((item) => item.clientMessageId !== message.clientMessageId));
            if (payload.status) updateStatus(payload.status);
            if (message.senderType === 'admin') void api.markRead(message.sequence).catch(() => undefined);
          }
        }
        if (payload.type === 'status') {
          updateStatus(payload.status);
          if (payload.message) addMessages([payload.message]);
        }
        if (payload.type === 'proposal') {
          if (payload.message) addMessages([payload.message]);
          void refreshProposal();
        }
        if (payload.type === 'error') {
          if (payload.clientMessageId) setPending((items) => items.map((item) => item.clientMessageId === payload.clientMessageId ? { ...item, state: 'failed', error: payload.message } : item));
          setError(payload.message || 'Não foi possível enviar a mensagem.');
        }
        if (payload.type === 'typing' && payload.from === 'admin') {
          setAdminTyping(Boolean(payload.active));
          if (typingExpiry.current) window.clearTimeout(typingExpiry.current);
          typingExpiry.current = window.setTimeout(() => setAdminTyping(false), 4_200);
        }
        if (payload.type === 'presence' && payload.participant === 'admin') setAdminOnline(Boolean(payload.online));
      });
      socket.addEventListener('close', () => {
        if (disposed) return;
        setConnection('offline');
        const delay = Math.min(30_000, 1_000 * (2 ** reconnectAttempt.current));
        reconnectAttempt.current += 1;
        reconnectTimer.current = window.setTimeout(connect, delay);
      });
      socket.addEventListener('error', () => socket.close());
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      if (typingExpiry.current) window.clearTimeout(typingExpiry.current);
      socketRef.current?.close(1000, 'Page changed');
    };
  }, [addMessages, loadHistory, refreshProposal, updateStatus]);

  useEffect(() => {
    if (connection === 'online') return;
    const poll = window.setInterval(() => void loadHistory({ after: latestSequence }).catch(() => undefined), 8_000);
    return () => window.clearInterval(poll);
  }, [connection, latestSequence, loadHistory]);

  const sendPayload = async (item: PendingMessage) => {
    setError('');
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'message', clientMessageId: item.clientMessageId, body: item.body }));
      return;
    }
    try {
      const response = await api.sendMessage(item.body, item.clientMessageId);
      addMessages([response.message]);
      setPending((items) => items.filter((pendingItem) => pendingItem.clientMessageId !== item.clientMessageId));
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Falha no envio.';
      setPending((items) => items.map((pendingItem) => pendingItem.clientMessageId === item.clientMessageId ? { ...pendingItem, state: 'failed', error: message } : pendingItem));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || body.length > 2_000 || !canSend) return;
    const item: PendingMessage = { clientMessageId: crypto.randomUUID(), body, state: 'sending' };
    setPending((items) => [...items, item]);
    setDraft('');
    void sendPayload(item);
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'typing', active: false }));
  };

  const onDraft = (value: string) => {
    setDraft(value);
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: 'typing', active: true }));
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => socketRef.current?.send(JSON.stringify({ type: 'typing', active: false })), 1_200);
  };

  const endConversation = async () => {
    if (!window.confirm('Deseja encerrar este atendimento? O histórico continuará disponível.')) return;
    try {
      const response = await api.resolveConversation();
      updateStatus(response.status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível encerrar.');
    }
  };

  return (
    <section className="human-chat" aria-labelledby="human-chat-title" ref={threadRef}>
      <div className="human-chat-heading">
        <div>
          <span className="human-avatar">CD</span>
          <span>
            <strong id="human-chat-title">Especialista Cog Dev</strong>
            <small>{adminOnline ? 'Online agora' : connection === 'online' ? 'Conectado — aguardando especialista' : 'Reconectando…'}</small>
          </span>
        </div>
        <span className={`connection-pill ${connection}`} role="status">
          {connection === 'online' ? <Signal size={14} /> : connection === 'connecting' ? <LoaderCircle className="spin" size={14} /> : <SignalLow size={14} />}
          {connection === 'online' ? 'Conectado' : connection === 'connecting' ? 'Conectando' : 'Fallback ativo'}
        </span>
      </div>

      {olderCursor && (
        <button className="load-older" type="button" onClick={() => void loadHistory({ before: olderCursor })}>Carregar mensagens anteriores</button>
      )}
      {loading && <div className="chat-loading"><LoaderCircle className="spin" size={18} /> Carregando histórico…</div>}

      <div className="human-message-list" aria-live="polite" aria-relevant="additions">
        {proposal && <ProposalReview proposal={proposal} onRefresh={refreshProposal} />}
        {messages.map((message) => (
          <article className={`human-message ${message.senderType}`} key={message.id}>
            <span className="message-kind">{message.senderLabel}</span>
            <p>{message.body}</p>
            <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
          </article>
        ))}
        {pending.map((message) => (
          <article className={`human-message client pending ${message.state}`} key={message.clientMessageId}>
            <span className="message-kind">Você</span>
            <p>{message.body}</p>
            <span className="delivery-state">
              {message.state === 'sending' ? <><LoaderCircle className="spin" size={13} /> Enviando</> : <><CircleAlert size={13} /> Falhou</>}
            </span>
            {message.state === 'failed' && <button type="button" onClick={() => void sendPayload({ ...message, state: 'sending' })}><RefreshCw size={14} /> Tentar novamente</button>}
          </article>
        ))}
        {adminTyping && <div className="typing-indicator" role="status"><span /><span /><span /> Equipe Cog Dev está digitando</div>}
        <div ref={bottomRef} />
      </div>

      {newBelow > 0 && (
        <button className="new-messages-button" type="button" onClick={() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); setNewBelow(0); }}>
          <ArrowDown size={15} /> {newBelow} {newBelow === 1 ? 'nova mensagem' : 'novas mensagens'}
        </button>
      )}

      {error && <div className="inline-chat-error" role="alert"><XCircle size={16} /> {error}</div>}

      {canSend ? (
        <form className="human-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="human-message">Mensagem para a equipe Cog Dev</label>
          <textarea
            id="human-message"
            rows={2}
            maxLength={2_000}
            value={draft}
            placeholder="Escreva sua mensagem"
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit" disabled={!draft.trim()} aria-label="Enviar mensagem"><Send size={18} /></button>
        </form>
      ) : (
        <div className="conversation-closed"><Check size={17} /> {status === 'resolved' ? 'Atendimento finalizado' : status === 'blocked' ? 'Conversa bloqueada' : 'Conversa indisponível'}</div>
      )}
      <div className="human-chat-footer">
        <span><Clock3 size={14} /> O histórico fica salvo com segurança.</span>
        {canSend && <button type="button" onClick={() => void endConversation()}>Encerrar atendimento</button>}
      </div>
    </section>
  );
}
