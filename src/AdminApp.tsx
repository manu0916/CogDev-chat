import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Bell,
  BellOff,
  ChevronLeft,
  Circle,
  Clipboard,
  CircleDollarSign,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  UserCheck,
  X,
} from 'lucide-react';
import type { ChatMessage, ConversationStatus } from './api';
import type { Proposal } from './api';
import { adminApi, type AdminConversationDetail, type AdminMe, type InboxConversation, type InternalNote } from './adminApi';
import { projectTypeLabels } from './flow';
import { ProposalForm } from './ProposalForm';

const filters = [
  ['waiting', 'Aguardando'],
  ['active', 'Em atendimento'],
  ['waiting_client', 'Aguardando cliente'],
  ['unread', 'Não lidas'],
  ['resolved', 'Finalizadas'],
  ['blocked', 'Bloqueadas'],
  ['all', 'Todas'],
] as const;

const statusCopy: Record<ConversationStatus, string> = {
  bot_collecting: 'Briefing em andamento',
  waiting_admin: 'Aguardando atendimento',
  active: 'Em atendimento',
  waiting_client: 'Aguardando cliente',
  resolved: 'Finalizada',
  blocked: 'Bloqueada',
  expired: 'Expirada',
};

const briefingLabels: Record<string, string> = {
  name: 'Nome', company: 'Empresa', contactMethod: 'Canal', contactValue: 'Contato', projectType: 'Projeto',
  objective: 'Objetivo', audience: 'Público', features: 'Funcionalidades', projectSpecific: 'Detalhes específicos',
  authNeeds: 'Login e acessos', integrations: 'Integrações', visualIdentity: 'Design', existingProject: 'Projeto anterior',
  deadline: 'Prazo', budget: 'Investimento', notes: 'Observações', consent: 'Consentimento',
};

const briefingValue = (key: string, value: unknown) => {
  if (key === 'budget' && typeof value === 'string') {
    if (value.startsWith('custom:')) {
      const amount = Number(value.slice('custom:'.length));
      if (Number.isFinite(amount)) {
        return `Personalizado: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(amount)}`;
      }
    }
    const budgetLabels: Record<string, string> = {
      'under-1k': 'Até R$ 1.000',
      '1-2k': 'R$ 1.001–2.000',
      '2-3k': 'R$ 2.001–3.000',
      'under-5k': 'Até R$ 5 mil',
      '5-15k': 'R$ 5–15 mil',
      '15-30k': 'R$ 15–30 mil',
      '30-60k': 'R$ 30–60 mil',
      '60k-plus': 'Acima de R$ 60 mil',
      'not-sure': 'Ainda não sei',
    };
    if (budgetLabels[value]) return budgetLabels[value];
  }
  return String(value || 'Não informado');
};

const timeAgo = (value: string) => {
  const difference = Date.now() - Date.parse(value);
  if (difference < 60_000) return 'agora';
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} min`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} h`;
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(value));
};

const fullTime = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));

const merge = (current: ChatMessage[], incoming: ChatMessage[]) => {
  const map = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => map.set(message.id, message));
  return [...map.values()].sort((a, b) => a.sequence - b.sequence);
};

function AdminBrand({ me }: { me: AdminMe | null }) {
  return (
    <div className="admin-brand">
      <a href="/admin" aria-label="Painel Cog Dev">
        <img src="/cogdev-logo.png" alt="" />
        <span><strong>Cog Dev</strong><small>Central de atendimento</small></span>
      </a>
      {me && <span className="admin-user" title={me.email}>{me.displayName.slice(0, 2).toUpperCase()}</span>}
    </div>
  );
}

export default function AdminApp() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [filter, setFilter] = useState('waiting');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminConversationDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notes, setNotes] = useState<InternalNote[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [pending, setPending] = useState<{ id: string; body: string; state: 'sending' | 'failed' }[]>([]);
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [sound, setSound] = useState(false);
  const [connected, setConnected] = useState(false);
  const [clientTyping, setClientTyping] = useState(false);
  const [clientOnline, setClientOnline] = useState(false);
  const [mobilePane, setMobilePane] = useState<'inbox' | 'chat' | 'details'>('inbox');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [showProposalForm, setShowProposalForm] = useState(false);
  const [replacementLink, setReplacementLink] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const latestSequenceRef = useRef(0);

  const selected = useMemo(() => conversations.find((item) => item.publicId === selectedId) || null, [conversations, selectedId]);
  const canReply = me ? me.role !== 'viewer' : false;
  const assignedToMe = Boolean(detail?.conversation.assigned_to && detail.conversation.assigned_to === me?.displayName);
  const totalUnread = conversations.reduce((total, item) => total + item.unreadCount, 0);

  const loadList = useCallback(async () => {
    const result = await adminApi.list(filter, query);
    setConversations(result.conversations);
    setSelectedId((current) => current || result.conversations[0]?.publicId || null);
  }, [filter, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    void Promise.all([adminApi.me(), loadList()])
      .then(([identity]) => setMe(identity))
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Falha ao abrir o painel.'))
      .finally(() => setLoading(false));
  }, [loadList]);

  useEffect(() => {
    document.title = totalUnread ? `(${totalUnread}) Atendimento | Cog Dev` : 'Atendimento | Cog Dev';
  }, [totalUnread]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = ['INPUT', 'TEXTAREA'].includes(target.tagName);
      if (event.key === '/' && !editing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') setMobilePane('chat');
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  useEffect(() => {
    if (!me) return;
    let disposed = false;
    let timer = 0;
    let attempt = 0;
    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(adminApi.socketUrl());
      socket.addEventListener('open', () => { attempt = 0; setConnected(true); });
      socket.addEventListener('message', (event) => {
        let payload: any;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (payload.type === 'conversation_update') {
          setToast(`Nova atividade em ${payload.publicId}`);
          void loadList();
          if (sound) {
            const context = new AudioContext();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.frequency.value = 520;
            gain.gain.value = 0.025;
            oscillator.connect(gain).connect(context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.08);
          }
        }
      });
      socket.addEventListener('close', () => {
        setConnected(false);
        timer = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempt));
        attempt += 1;
      });
      socket.addEventListener('error', () => socket.close());
    };
    connect();
    const poll = window.setInterval(() => void loadList(), 15_000);
    return () => { disposed = true; window.clearTimeout(timer); window.clearInterval(poll); };
  }, [loadList, me, sound]);

  const loadConversation = useCallback(async (publicId: string) => {
    setThreadLoading(true);
    setError('');
    try {
      const [loadedDetail, history, loadedProposal] = await Promise.all([adminApi.detail(publicId), adminApi.messages(publicId), adminApi.proposal(publicId)]);
      setDetail(loadedDetail);
      setMessages(history.messages);
      setNotes(history.notes);
      setOlderCursor(history.nextCursor);
      setProposal(loadedProposal.proposal);
      latestSequenceRef.current = history.messages.at(-1)?.sequence || 0;
      await adminApi.read(publicId);
      setConversations((items) => items.map((item) => item.publicId === publicId ? { ...item, unreadCount: 0 } : item));
      window.setTimeout(() => bottomRef.current?.scrollIntoView({ block: 'nearest' }), 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível abrir a conversa.');
    } finally {
      setThreadLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadConversation(selectedId);
  }, [loadConversation, selectedId]);

  useEffect(() => {
    if (!selectedId || !me) return;
    let disposed = false;
    let timer = 0;
    let attempt = 0;
    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(adminApi.socketUrl(selectedId));
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        attempt = 0;
        void adminApi.messages(selectedId, { after: latestSequenceRef.current }).then((history) => {
          setMessages((current) => merge(current, history.messages));
        }).catch(() => undefined);
      });
      socket.addEventListener('message', (event) => {
        let payload: any;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if ((payload.type === 'message' || payload.type === 'ack') && payload.message) {
          const message = payload.message as ChatMessage;
          setMessages((current) => merge(current, [message]));
          latestSequenceRef.current = Math.max(latestSequenceRef.current, message.sequence);
          if (message.clientMessageId) setPending((items) => items.filter((item) => item.id !== message.clientMessageId));
          if (payload.status) setDetail((current) => current ? { ...current, conversation: { ...current.conversation, status: payload.status } } : current);
          if (message.senderType === 'client') void adminApi.read(selectedId);
          window.setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
        }
        if (payload.type === 'status') {
          if (payload.message) setMessages((current) => merge(current, [payload.message]));
          setDetail((current) => current ? { ...current, conversation: { ...current.conversation, status: payload.status } } : current);
          void loadList();
        }
        if (payload.type === 'proposal') {
          if (payload.message) setMessages((current) => merge(current, [payload.message]));
          void adminApi.proposal(selectedId).then((response) => setProposal(response.proposal));
        }
        if (payload.type === 'typing' && payload.from === 'client') {
          setClientTyping(Boolean(payload.active));
          window.setTimeout(() => setClientTyping(false), 4_200);
        }
        if (payload.type === 'presence' && payload.participant === 'client') setClientOnline(Boolean(payload.online));
        if (payload.type === 'error') {
          if (payload.clientMessageId) setPending((items) => items.map((item) => item.id === payload.clientMessageId ? { ...item, state: 'failed' } : item));
          setError(payload.message || 'Falha ao enviar.');
        }
      });
      socket.addEventListener('close', () => {
        if (disposed) return;
        timer = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempt));
        attempt += 1;
      });
      socket.addEventListener('error', () => socket.close());
    };
    connect();
    const poll = window.setInterval(() => {
      void adminApi.messages(selectedId, { after: latestSequenceRef.current }).then((history) => setMessages((current) => merge(current, history.messages))).catch(() => undefined);
    }, 10_000);
    return () => { disposed = true; window.clearTimeout(timer); window.clearInterval(poll); socketRef.current?.close(1000, 'Conversation changed'); };
  }, [loadList, me, selectedId]);

  const select = (publicId: string) => {
    setSelectedId(publicId);
    setMobilePane('chat');
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!selectedId || !draft.trim() || !canReply) return;
    const item = { id: crypto.randomUUID(), body: draft.trim(), state: 'sending' as const };
    setPending((items) => [...items, item]);
    setDraft('');
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'message', clientMessageId: item.id, body: item.body }));
      return;
    }
    try {
      const response = await adminApi.send(selectedId, item.body, item.id);
      setMessages((current) => merge(current, [response.message]));
      setPending((items) => items.filter((pendingItem) => pendingItem.id !== item.id));
    } catch {
      setPending((items) => items.map((pendingItem) => pendingItem.id === item.id ? { ...item, state: 'failed' } : pendingItem));
    }
  };

  const assume = async () => {
    if (!selectedId || !me) return;
    try {
      const response = await adminApi.assign(selectedId);
      setDetail((current) => current ? { ...current, conversation: { ...current.conversation, status: response.status, assigned_to: me.displayName } } : current);
      void loadList();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Não foi possível assumir.'); }
  };

  const changeStatus = async (status: ConversationStatus) => {
    if (!selectedId) return;
    try {
      const response = await adminApi.status(selectedId, status);
      setDetail((current) => current ? { ...current, conversation: { ...current.conversation, status: response.status } } : current);
      void loadList();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Não foi possível atualizar.'); }
  };

  const saveNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId || !noteDraft.trim()) return;
    try {
      const response = await adminApi.note(selectedId, noteDraft.trim());
      setNotes((items) => [...items, { id: crypto.randomUUID(), body: noteDraft.trim(), createdAt: response.createdAt, author: me?.displayName || 'Admin' }]);
      setNoteDraft('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Não foi possível salvar a anotação.'); }
  };

  if (loading) return <div className="admin-loading"><LoaderCircle className="spin" /><span>Carregando central de atendimento…</span></div>;

  return (
    <main className="admin-shell" data-mobile-pane={mobilePane}>
      <aside className="admin-inbox-pane">
        <AdminBrand me={me} />
        <div className="inbox-title"><div><h1>Caixa de entrada</h1><span className={connected ? 'connected' : ''}>{connected ? 'Atualização em tempo real' : 'Reconectando'}</span></div><button type="button" title={sound ? 'Desativar som' : 'Ativar som'} onClick={() => setSound((value) => !value)}>{sound ? <Bell size={18} /> : <BellOff size={18} />}</button></div>
        <label className="admin-search"><Search size={17} /><span className="sr-only">Buscar conversas</span><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar nome, empresa ou código" /><kbd>/</kbd></label>
        <nav className="admin-filters" aria-label="Filtros da caixa de entrada">
          {filters.map(([value, label]) => <button type="button" className={filter === value ? 'active' : ''} onClick={() => setFilter(value)} key={value}>{label}</button>)}
        </nav>
        <div className="conversation-list">
          {conversations.length === 0 && <div className="inbox-empty"><Inbox size={24} /><p>Nenhuma conversa neste filtro.</p></div>}
          {conversations.map((conversation) => (
            <button type="button" className={`conversation-preview ${selectedId === conversation.publicId ? 'selected' : ''}`} onClick={() => select(conversation.publicId)} key={conversation.publicId}>
              <span className="preview-avatar">{conversation.name.slice(0, 2).toUpperCase()}<i className={conversation.clientPresence} /></span>
              <span className="preview-content">
                <span className="preview-line"><strong>{conversation.name}</strong><time>{timeAgo(conversation.lastMessageAt)}</time></span>
                <span className="preview-project">{projectTypeLabels[conversation.projectType as keyof typeof projectTypeLabels] || 'Projeto'} · {statusCopy[conversation.status]}</span>
                <span className="preview-message">{conversation.lastMessage || 'Sem mensagens humanas ainda'}</span>
              </span>
              {conversation.unreadCount > 0 && <span className="unread-count" aria-label={`${conversation.unreadCount} não lidas`}>{conversation.unreadCount}</span>}
            </button>
          ))}
        </div>
      </aside>

      <section className="admin-chat-pane">
        {!selectedId || !selected ? (
          <div className="select-conversation"><MessageSquare size={30} /><h2>Selecione uma conversa</h2><p>O histórico e o briefing aparecerão aqui.</p></div>
        ) : (
          <>
            <header className="admin-chat-header">
              <button className="mobile-back" type="button" onClick={() => setMobilePane('inbox')}><ChevronLeft size={20} /><span className="sr-only">Voltar à caixa de entrada</span></button>
              <span className="preview-avatar large">{selected.name.slice(0, 2).toUpperCase()}<i className={clientOnline ? 'online' : selected.clientPresence} /></span>
              <div><strong>{selected.name}</strong><small>{clientOnline ? 'Online agora' : selected.clientPresence === 'seen_recently' ? 'Visto recentemente' : 'Offline'} · {statusCopy[detail?.conversation.status || selected.status]}</small></div>
              <div className="admin-chat-actions">
                {['owner', 'admin'].includes(me?.role || '') && <button className="proposal-action" type="button" onClick={() => setShowProposalForm(true)}><CircleDollarSign size={16} /> Fechar orçamento</button>}
                {!assignedToMe && canReply && <button className="assign-button" type="button" onClick={() => void assume()}><UserCheck size={16} /> Assumir</button>}
                <button type="button" className="detail-toggle" onClick={() => setMobilePane('details')}><PanelRight size={18} /><span className="sr-only">Abrir briefing</span></button>
              </div>
            </header>
            <div className="admin-status-actions">
              {detail?.conversation.status === 'waiting_client' ? <button type="button" onClick={() => void changeStatus('active')}>Marcar em atendimento</button> : <button type="button" onClick={() => void changeStatus('waiting_client')} disabled={!assignedToMe}>Aguardar cliente</button>}
              {detail?.conversation.status === 'resolved' ? <button type="button" onClick={() => void changeStatus('waiting_admin')}>Reabrir</button> : <button type="button" onClick={() => void changeStatus('resolved')} disabled={!assignedToMe}>Finalizar</button>}
              <button className="block-action" type="button" onClick={() => void changeStatus('blocked')} disabled={!['owner', 'admin'].includes(me?.role || '')}><ShieldAlert size={14} /> Bloquear</button>
            </div>
            <div className="admin-thread" aria-live="polite">
              {threadLoading && <div className="chat-loading"><LoaderCircle className="spin" /> Abrindo conversa…</div>}
              {olderCursor && <button className="load-older" type="button" onClick={() => void adminApi.messages(selectedId, { before: olderCursor }).then((history) => { setMessages((current) => merge(history.messages, current)); setOlderCursor(history.nextCursor); })}>Carregar mensagens anteriores</button>}
              {messages.map((message) => (
                <article className={`admin-message ${message.senderType}`} key={message.id}>
                  <span>{message.senderLabel}</span><p>{message.body}</p><time>{fullTime(message.createdAt)}</time>
                </article>
              ))}
              {pending.map((message) => <article className={`admin-message admin pending ${message.state}`} key={message.id}><span>Equipe Cog Dev</span><p>{message.body}</p><small>{message.state === 'sending' ? 'Enviando…' : 'Falha no envio'}</small></article>)}
              {clientTyping && <div className="typing-indicator"><span /><span /><span /> Cliente está digitando</div>}
              <div ref={bottomRef} />
            </div>
            {error && <div className="admin-error" role="alert"><ShieldAlert size={16} />{error}<button type="button" onClick={() => setError('')}><X size={15} /></button></div>}
            {canReply ? (
              <form className="admin-composer" onSubmit={(event) => void sendMessage(event)}>
                <label className="sr-only" htmlFor="admin-reply">Responder ao cliente</label>
                <textarea id="admin-reply" rows={2} maxLength={2_000} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={assignedToMe ? 'Responder como Equipe Cog Dev' : 'Assuma o atendimento para responder'} disabled={!assignedToMe} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
                <button type="submit" disabled={!assignedToMe || !draft.trim()}><Send size={18} /><span className="sr-only">Enviar</span></button>
                <span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> para enviar</span>
              </form>
            ) : <div className="viewer-notice"><LockKeyhole size={16} /> Seu perfil possui acesso somente para leitura.</div>}
          </>
        )}
      </section>

      <aside className="admin-detail-pane">
        <header><button className="detail-close" type="button" onClick={() => setMobilePane('chat')}><ChevronLeft size={19} /><span className="sr-only">Voltar à conversa</span></button><div><span className="eyebrow">Contexto</span><h2>Briefing e dados</h2></div><MoreHorizontal size={19} /></header>
        {detail ? (
          <div className="detail-scroll">
            <section className="detail-section quote-identity">
              <span>Código do orçamento</span><div><strong>{detail.conversation.quote_code}</strong><button type="button" title="Copiar código" onClick={() => void navigator.clipboard.writeText(detail.conversation.quote_code)}><Clipboard size={15} /></button></div>
              <dl><div><dt>Responsável</dt><dd>{detail.conversation.assigned_to || 'Não atribuído'}</dd></div><div><dt>Projeto</dt><dd>{projectTypeLabels[detail.conversation.project_type as keyof typeof projectTypeLabels] || detail.conversation.project_type || 'Em definição'}</dd></div></dl>
            </section>
            {(detail.conversation.email_normalized || detail.conversation.phone_normalized) && <section className="detail-section"><h3>Contato</h3><p>{detail.conversation.email_normalized || detail.conversation.phone_normalized}</p></section>}
            <section className="detail-section"><h3>Briefing</h3><dl className="briefing-list">{Object.entries(detail.briefing).filter(([key]) => key !== 'consent').map(([key, value]) => <div key={key}><dt>{briefingLabels[key] || key}</dt><dd>{briefingValue(key, value)}</dd></div>)}</dl></section>
            {detail.conversation.minimum_amount && <section className="detail-section estimate-admin"><h3>Estimativa preliminar</h3><strong>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(detail.conversation.minimum_amount)} – {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(detail.conversation.maximum_amount ?? detail.conversation.minimum_amount)}</strong></section>}
            {proposal && <section className="detail-section admin-proposal-card"><h3>Proposta v{proposal.version}</h3><span className={`proposal-status ${proposal.status}`}>{proposal.status.replaceAll('_', ' ')}</span><p>{proposal.scopeSummary}</p><dl><div><dt>Total</dt><dd>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(proposal.totalAmount / 100)}</dd></div><div><dt>Sinal</dt><dd>{new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(proposal.depositAmount / 100)}</dd></div></dl>{proposal.paymentMode === 'manual_payment_link' && proposal.status !== 'payment_confirmed' && ['owner', 'admin'].includes(me?.role || '') && <form onSubmit={(event) => { event.preventDefault(); if (selectedId && replacementLink) void adminApi.replacePaymentLink(selectedId, replacementLink).then(() => { setReplacementLink(''); setToast('Link C6 atualizado'); }); }}><label><span>Substituir link C6</span><input type="url" value={replacementLink} onChange={(event) => setReplacementLink(event.target.value)} placeholder="https://..." /></label><button type="submit" disabled={!replacementLink}>Atualizar link</button></form>}{proposal.paymentMode === 'manual_payment_link' && ['awaiting_payment', 'payment_failed', 'approved'].includes(proposal.status) && ['owner', 'admin'].includes(me?.role || '') && <div className="manual-payment-actions"><button type="button" onClick={() => selectedId && void adminApi.setPaymentStatus(selectedId, 'confirmed').then(() => setProposal((current) => current ? { ...current, status: 'payment_confirmed' } : current))}>Confirmar após conferência</button><button type="button" onClick={() => selectedId && void adminApi.setPaymentStatus(selectedId, 'failed').then(() => setProposal((current) => current ? { ...current, status: 'payment_failed' } : current))}>Marcar falha</button></div>}</section>}
            <section className="detail-section internal-notes"><h3>Anotações internas <LockKeyhole size={14} /></h3><p className="private-hint">Visíveis apenas para a equipe autorizada.</p>{notes.map((note) => <article key={note.id}><p>{note.body}</p><span>{note.author} · {fullTime(note.createdAt)}</span></article>)}{canReply && <form onSubmit={(event) => void saveNote(event)}><label className="sr-only" htmlFor="internal-note">Nova anotação interna</label><textarea id="internal-note" rows={3} maxLength={2_000} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Adicionar observação privada" /><button type="submit" disabled={!noteDraft.trim()}>Salvar anotação</button></form>}</section>
          </div>
        ) : <div className="detail-empty"><Archive size={24} /><p>Selecione uma conversa para ver o briefing.</p></div>}
      </aside>

      {toast && <button className="admin-toast" type="button" onClick={() => setToast('')}><Circle size={9} fill="currentColor" />{toast}<X size={15} /></button>}
      <button className="mobile-menu" type="button" onClick={() => setMobilePane('inbox')}><Menu size={19} /><span className="sr-only">Abrir caixa de entrada</span></button>
      {showProposalForm && selectedId && <ProposalForm publicId={selectedId} onClose={() => setShowProposalForm(false)} onSaved={(created) => { setProposal(created); setToast('Proposta enviada ao cliente'); }} />}
    </main>
  );
}
