import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  Edit3,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  WifiOff,
  X,
} from 'lucide-react';
import type { AnswerValue, QuestionKey } from '../shared/contracts';
import { ApiError, api, type ApiConfig, type QuoteResult } from './api';
import type { ConversationStatus } from './api';
import {
  buildFlow,
  choiceLabel,
  getQuestionPrompt,
  projectTypeLabels,
  toQuotePayload,
  type Answers,
  type Question,
} from './flow';
import { Turnstile } from './Turnstile';
import { ClientChat } from './ClientChat';

const hasAnswer = (answers: Answers, key: QuestionKey) =>
  Object.prototype.hasOwnProperty.call(answers, key);

const friendlyError = (error: unknown) => {
  if (error instanceof ApiError) return error.message;
  return 'Algo não saiu como esperado. Tente novamente.';
};

const contactError = (method: AnswerValue | undefined, value: string) => {
  if (method === 'email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : 'Informe um e-mail válido.';
  }
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? null : 'Informe um WhatsApp com DDD.';
};

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(value);

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Cog Dev — início">
      <span className="brand-logo-wrap" aria-hidden="true">
        <img src="/cogdev-logo.png" alt="" className="brand-logo" />
      </span>
      <span>
        <strong>Cog Dev</strong>
        <small>Soluções sob medida</small>
      </span>
    </a>
  );
}

function Progress({ answered, total }: { answered: number; total: number }) {
  return (
    <div className="progress-block">
      <div className="progress-label">
        <span>Seu briefing</span>
        <strong>{answered} de {total}</strong>
      </div>
      <progress
        className="progress-track"
        aria-label="Progresso do briefing"
        value={answered}
        max={Math.max(1, total)}
      />
      <p>As etapas se ajustam ao tipo do seu projeto.</p>
    </div>
  );
}

function AssistantBubble({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <div className={`message-row assistant ${compact ? 'compact' : ''}`}>
      <span className="assistant-mark" aria-hidden="true"><MessageCircle size={16} /></span>
      <div className="bubble assistant-bubble">{children}</div>
    </div>
  );
}

function ConversationHistory({ questions, answers }: { questions: Question[]; answers: Answers }) {
  return (
    <>
      {questions.filter((question) => hasAnswer(answers, question.key)).map((question) => (
        <div className="exchange" key={question.key}>
          <AssistantBubble compact>{getQuestionPrompt(question, answers)}</AssistantBubble>
          <div className="message-row visitor">
            <div className="bubble visitor-bubble">{choiceLabel(question, answers[question.key]!)}</div>
          </div>
        </div>
      ))}
    </>
  );
}

type ComposerProps = {
  question: Question;
  answers: Answers;
  value: string;
  error: string;
  processing: boolean;
  onValue: (value: string) => void;
  onAnswer: (value: AnswerValue) => void;
};

function Composer({ question, answers, value, error, processing, onValue, onAnswer }: ComposerProps) {
  const submitText = (event: FormEvent) => {
    event.preventDefault();
    onAnswer(value);
  };
  const textId = `answer-${question.key}`;
  const isTextarea = question.input === 'textarea';

  if (question.input === 'choices') {
    return (
      <div className="choice-grid" role="group" aria-label={question.label}>
        {question.choices?.map((choice) => (
          <button key={choice.value} className="choice-button" type="button" disabled={processing} onClick={() => onAnswer(choice.value)}>
            <span>{choice.label}</span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
    );
  }

  if (question.input === 'consent') {
    return (
      <div className="consent-box">
        <p>Usaremos as informações somente para analisar seu projeto, preparar o orçamento e entrar em contato. Não envie senhas, documentos ou dados financeiros.</p>
        <button className="primary-button" type="button" disabled={processing} onClick={() => onAnswer(true)}>
          <Check size={18} aria-hidden="true" /> Li e autorizo o uso dos dados
        </button>
      </div>
    );
  }

  return (
    <form className="answer-form" onSubmit={submitText}>
      {question.choices && (
        <div className="quick-answers" aria-label="Respostas rápidas">
          {question.choices.map((choice) => (
            <button key={choice.label} type="button" disabled={processing} onClick={() => onAnswer(choice.value)}>
              {choice.label}
            </button>
          ))}
        </div>
      )}
      <label htmlFor={textId} className="sr-only">{question.label}</label>
      <div className={`input-shell ${error ? 'invalid' : ''}`}>
        {isTextarea ? (
          <textarea
            id={textId}
            value={value}
            maxLength={1_500}
            rows={3}
            disabled={processing}
            placeholder={question.placeholder}
            aria-describedby={error ? `${textId}-error` : undefined}
            aria-invalid={Boolean(error)}
            onChange={(event) => onValue(event.target.value)}
            autoFocus
          />
        ) : (
          <input
            id={textId}
            value={value}
            maxLength={question.key === 'name' ? 80 : 160}
            type={question.input === 'contact' && answers.contactMethod === 'email' ? 'email' : question.input === 'contact' ? 'tel' : 'text'}
            inputMode={question.input === 'contact' && answers.contactMethod !== 'email' ? 'tel' : 'text'}
            autoComplete={question.key === 'name' ? 'name' : answers.contactMethod === 'email' ? 'email' : 'tel'}
            disabled={processing}
            placeholder={question.placeholder}
            aria-describedby={error ? `${textId}-error` : undefined}
            aria-invalid={Boolean(error)}
            onChange={(event) => onValue(event.target.value)}
            autoFocus
          />
        )}
        <button className="send-button" type="submit" disabled={processing || (!question.optional && !value.trim())} aria-label="Enviar resposta">
          {processing ? <LoaderCircle className="spin" size={20} /> : <Send size={19} />}
        </button>
      </div>
      <div className="field-meta">
        <span id={`${textId}-error`} className="field-error" role={error ? 'alert' : undefined}>{error}</span>
        {isTextarea && <span>{value.length}/1.500</span>}
      </div>
    </form>
  );
}

function Review({
  flow,
  answers,
  onEdit,
}: {
  flow: Question[];
  answers: Answers;
  onEdit: (key: QuestionKey) => void;
}) {
  return (
    <section className="review-card" aria-labelledby="review-title">
      <div className="review-heading">
        <div>
          <span className="eyebrow">Revisão final</span>
          <h2 id="review-title">Confira seu briefing</h2>
        </div>
        <CheckCircle2 size={24} aria-hidden="true" />
      </div>
      <div className="review-list">
        {flow.filter((question) => question.key !== 'consent').map((question) => (
          <div className="review-item" key={question.key}>
            <div>
              <dt>{question.label}</dt>
              <dd>{choiceLabel(question, answers[question.key]!)}</dd>
            </div>
            <button type="button" onClick={() => onEdit(question.key)} aria-label={`Editar ${question.label}`}>
              <Edit3 size={16} /> Editar
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Success({ result, onNew, onOpenChat }: { result: QuoteResult; onNew: () => void; onOpenChat: () => void }) {
  return (
    <section className="success-card" aria-labelledby="success-title">
      <span className="success-icon" aria-hidden="true"><CheckCircle2 size={30} /></span>
      <span className="eyebrow">Briefing registrado</span>
      <h2 id="success-title">Recebemos sua solicitação.</h2>
      <p>A equipe da Cog Dev analisará as informações e entrará em contato.</p>
      <div className="public-code">
        <span>Código do orçamento</span>
        <strong>{result.publicCode}</strong>
      </div>
      {result.estimate ? (
        <div className="estimate-card">
          <span>{result.estimate.label}</span>
          <strong>{formatCurrency(result.estimate.minimumAmount)} – {formatCurrency(result.estimate.maximumAmount)}</strong>
          <p>{result.estimate.estimatedDaysMin}–{result.estimate.estimatedDaysMax} dias estimados. {result.estimate.disclaimer}</p>
        </div>
      ) : (
        <div className="analysis-note">
          <Clock3 size={18} aria-hidden="true" />
          <p>A estimativa será preparada após a análise técnica — nenhum valor genérico foi aplicado.</p>
        </div>
      )}
      <div className="success-actions">
        <button className="primary-button" type="button" onClick={onOpenChat}>
          <MessageCircle size={18} /> Acompanhar atendimento por aqui
        </button>
        {result.whatsappUrl && (
          <a className="secondary-button" href={result.whatsappUrl} target="_blank" rel="noreferrer">
            <MessageCircle size={18} /> Continuar pelo WhatsApp
          </a>
        )}
        <button className="secondary-button" type="button" onClick={onNew}>Iniciar novo orçamento</button>
      </div>
    </section>
  );
}

export default function App() {
  const [answers, setAnswers] = useState<Answers>({});
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [bootState, setBootState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [globalError, setGlobalError] = useState('');
  const [processing, setProcessing] = useState(false);
  const [slow, setSlow] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [editingKey, setEditingKey] = useState<QuestionKey | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileReset, setTurnstileReset] = useState(0);
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [conversationStatus, setConversationStatus] = useState<ConversationStatus>('bot_collecting');
  const [humanMode, setHumanMode] = useState(false);
  const idempotencyRef = useRef(crypto.randomUUID());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const flow = useMemo(() => buildFlow(answers), [answers]);
  const firstUnansweredIndex = flow.findIndex((question) => !hasAnswer(answers, question.key));
  const answeredCount = flow.filter((question) => hasAnswer(answers, question.key)).length;
  const reviewReady = firstUnansweredIndex === -1;
  const activeQuestion = editingKey
    ? flow.find((question) => question.key === editingKey) ?? null
    : firstUnansweredIndex >= 0 ? flow[firstUnansweredIndex] : null;

  const createFreshSession = useCallback(async () => {
    const created = await api.createSession();
    setConversationStatus('bot_collecting');
    return created;
  }, []);

  const bootstrap = useCallback(async () => {
    setBootState('loading');
    setGlobalError('');
    try {
      const loadedConfig = await api.config();
      setConfig(loadedConfig);
      try {
        const restored = await api.restoreSession();
        setAnswers(restored.answers as Answers);
        setConversationStatus(restored.conversation.status);
        setHumanMode(restored.conversation.status !== 'bot_collecting');
        if (restored.quoteResult) setResult(restored.quoteResult);
      } catch (error) {
        if (error instanceof ApiError && ['INVALID_SESSION', 'SESSION_EXPIRED'].includes(error.code)) {
          await createFreshSession();
          if (error.code === 'SESSION_EXPIRED') setGlobalError('A sessão anterior expirou. Iniciamos um novo orçamento para você.');
        } else {
          throw error;
        }
      }
      setBootState('ready');
    } catch (error) {
      setGlobalError(friendlyError(error));
      setBootState('error');
    }
  }, [createFreshSession]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  useEffect(() => {
    const online = () => setOffline(false);
    const offlineHandler = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', offlineHandler);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offlineHandler);
    };
  }, []);

  useEffect(() => {
    if (activeQuestion) {
      const existing = answers[activeQuestion.key];
      setDraft(typeof existing === 'string' ? existing : '');
      setFieldError('');
    }
  }, [activeQuestion?.key, editingKey]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [answeredCount, editingKey, reviewReady, result]);

  const answerQuestion = async (value: AnswerValue) => {
    if (!activeQuestion || processing) return;
    setFieldError('');
    setGlobalError('');
    let error: string | null = null;
    if (activeQuestion.key === 'contactValue' && typeof value === 'string') {
      error = contactError(answers.contactMethod, value);
    } else if (activeQuestion.validate) {
      error = activeQuestion.validate(value, answers);
    } else if (typeof value === 'string' && !activeQuestion.optional && !value.trim()) {
      error = 'Preencha esta resposta para continuar.';
    }
    if (error) {
      setFieldError(error);
      return;
    }

    setProcessing(true);
    try {
      await api.saveAnswer(activeQuestion.key, value, answeredCount + 1, setSlow);
      setAnswers((current) => {
        const next = { ...current, [activeQuestion.key]: value };
        if (activeQuestion.key === 'projectType' && current.projectType !== value) delete next.projectSpecific;
        return next;
      });
      setEditingKey(null);
      setDraft('');
    } catch (caught) {
      const apiError = caught as ApiError;
      if (apiError.code === 'SESSION_EXPIRED') {
        setBootState('error');
      }
      setGlobalError(friendlyError(caught));
    } finally {
      setProcessing(false);
    }
  };

  const goBack = () => {
    const answered = flow.filter((question) => hasAnswer(answers, question.key));
    const previous = answered.at(-1);
    if (previous) setEditingKey(previous.key);
  };

  const reset = async (deleteCurrent = true) => {
    setProcessing(true);
    setGlobalError('');
    try {
      if (deleteCurrent && !result) {
        await api.deleteSession().catch((error) => {
          if (!(error instanceof ApiError) || !['INVALID_SESSION', 'SESSION_EXPIRED'].includes(error.code)) throw error;
        });
      }
      setAnswers({});
      setResult(null);
      setHumanMode(false);
      setConversationStatus('bot_collecting');
      setEditingKey(null);
      setTurnstileToken('');
      idempotencyRef.current = crypto.randomUUID();
      await createFreshSession();
      setShowReset(false);
      setBootState('ready');
    } catch (error) {
      setGlobalError(friendlyError(error));
    } finally {
      setProcessing(false);
    }
  };

  const submit = async () => {
    if (!config || processing) return;
    if (config.turnstileRequired && !config.turnstileSiteKey) {
      setGlobalError('A verificação de segurança ainda não foi configurada. Entre em contato com a Cog Dev.');
      return;
    }
    if (config.turnstileRequired && !turnstileToken) {
      setGlobalError('Conclua a verificação de segurança para enviar.');
      return;
    }
    setProcessing(true);
    setGlobalError('');
    try {
      const submitted = await api.submitQuote({
        quote: toQuotePayload(answers, turnstileToken || 'local-development'),
        idempotencyKey: idempotencyRef.current,
      }, setSlow);
      setResult(submitted);
      setConversationStatus('waiting_admin');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BOT_CHECK_FAILED') {
        setTurnstileToken('');
        setTurnstileReset((value) => value + 1);
      }
      setGlobalError(friendlyError(error));
    } finally {
      setProcessing(false);
    }
  };

  const requestHuman = async () => {
    if (processing) return;
    setProcessing(true);
    setGlobalError('');
    try {
      const response = await api.requestHuman();
      setConversationStatus(response.status);
      setHumanMode(true);
    } catch (error) {
      setGlobalError(friendlyError(error));
    } finally {
      setProcessing(false);
    }
  };

  const handleConversationStatus = useCallback((status: ConversationStatus) => {
    setConversationStatus(status);
  }, []);

  const history = flow.filter((question) => question.key !== editingKey);

  return (
    <div className="app-shell">
      <header className="site-header">
        <Brand />
        <div className="online-status"><span aria-hidden="true" /> Orçamento online</div>
      </header>

      <main className="workspace">
        <aside className="context-panel" aria-label="Informações do orçamento">
          <div className="context-copy">
            <span className="eyebrow">Conversa guiada</span>
            <h1>Seu projeto começa com as perguntas certas.</h1>
            <p>Conte o que você precisa no seu ritmo. A Cog Dev organiza o briefing para uma análise objetiva.</p>
          </div>
          <Progress answered={answeredCount} total={flow.length} />
          <div className="trust-list">
            <div><ShieldCheck size={19} /><span><strong>Dados protegidos</strong>Validação e proteção contra abuso</span></div>
            <div><Clock3 size={19} /><span><strong>Leva poucos minutos</strong>Só perguntamos o que importa</span></div>
            <div><LockKeyhole size={19} /><span><strong>Privacidade primeiro</strong>Nunca envie senhas ou dados financeiros</span></div>
          </div>
          <p className="aside-note">Você pode fechar esta aba e continuar depois neste dispositivo enquanto a sessão estiver válida.</p>
        </aside>

        <section className="chat-panel" aria-label="Assistente de orçamento">
          <div className="chat-topbar">
            <div>
              <span className="assistant-avatar"><MessageCircle size={18} /></span>
              <span><strong>Assistente Cog Dev</strong><small>Análise inicial do seu projeto</small></span>
            </div>
            <div className="topbar-actions">
              {!humanMode && !result && (
                <button type="button" className="specialist-button" onClick={() => void requestHuman()} disabled={processing}>
                  <MessageCircle size={16} /> <span>Falar com um especialista</span>
                </button>
              )}
              {!result && (
                <button type="button" className="icon-text-button" onClick={() => setShowReset(true)} disabled={processing}>
                  <RotateCcw size={16} /> <span>Reiniciar</span>
                </button>
              )}
            </div>
          </div>

          {(offline || slow) && (
            <div className="connection-banner" role="status">
              {offline ? <WifiOff size={17} /> : <LoaderCircle className="spin" size={17} />}
              {offline ? 'Você está sem conexão. Suas respostas não serão enviadas até a internet voltar.' : 'A conexão está mais lenta que o normal. Estamos aguardando com segurança.'}
            </div>
          )}

          <div className="messages" aria-live="polite" aria-busy={processing}>
            {bootState === 'loading' ? (
              <div className="loading-state">
                <span className="loading-logo"><LoaderCircle className="spin" size={24} /></span>
                <strong>Preparando uma conversa segura…</strong>
                <p>Isso deve levar só um instante.</p>
              </div>
            ) : bootState === 'error' ? (
              <div className="empty-error" role="alert">
                <RefreshCw size={24} />
                <h2>Não conseguimos iniciar agora.</h2>
                <p>{globalError}</p>
                <button className="primary-button" type="button" onClick={() => void bootstrap()}>Tentar novamente</button>
              </div>
            ) : result && !humanMode ? (
              <Success result={result} onNew={() => void reset(false)} onOpenChat={() => setHumanMode(true)} />
            ) : humanMode ? (
              <>
                <AssistantBubble>Seu briefing foi preservado. A partir daqui, suas mensagens serão acompanhadas pela equipe Cog Dev.</AssistantBubble>
                <ConversationHistory questions={history} answers={answers} />
                <ClientChat initialStatus={conversationStatus} onStatus={handleConversationStatus} />
                <div ref={messagesEndRef} />
              </>
            ) : (
              <>
                <AssistantBubble>Olá! Somos a Cog Dev. Vamos entender o que você precisa e preparar seu orçamento.</AssistantBubble>
                <ConversationHistory questions={history} answers={answers} />
                {activeQuestion && (
                  <AssistantBubble>{editingKey ? `Vamos atualizar: ${getQuestionPrompt(activeQuestion, answers)}` : getQuestionPrompt(activeQuestion, answers)}</AssistantBubble>
                )}
                {reviewReady && !editingKey && <Review flow={flow} answers={answers} onEdit={setEditingKey} />}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {bootState === 'ready' && !result && !humanMode && (
            <div className="composer-area">
              {globalError && (
                <div className="error-banner" role="alert">
                  <span>{globalError}</span>
                  <button type="button" aria-label="Fechar aviso" onClick={() => setGlobalError('')}><X size={16} /></button>
                </div>
              )}
              {reviewReady && !editingKey ? (
                <div className="submit-area">
                  {config?.turnstileSiteKey && (
                    <Turnstile
                      siteKey={config.turnstileSiteKey}
                      onToken={setTurnstileToken}
                      onError={() => setGlobalError('Não foi possível carregar a verificação de segurança.')}
                      resetKey={turnstileReset}
                    />
                  )}
                  {!config?.turnstileRequired && (
                    <p className="dev-note"><ShieldCheck size={16} /> Turnstile será exigido no ambiente de produção.</p>
                  )}
                  <button className="primary-button submit-quote" type="button" disabled={processing || offline} onClick={() => void submit()}>
                    {processing ? <LoaderCircle className="spin" size={19} /> : <CheckCircle2 size={19} />}
                    Solicitar análise da Cog Dev
                  </button>
                  <p>Ao enviar, você confirma o consentimento acima. Seus dados serão mantidos por até {config?.retentionDays ?? 180} dias.</p>
                </div>
              ) : activeQuestion ? (
                <Composer
                  question={activeQuestion}
                  answers={answers}
                  value={draft}
                  error={fieldError}
                  processing={processing || offline}
                  onValue={(value) => { setDraft(value); setFieldError(''); }}
                  onAnswer={(value) => void answerQuestion(value)}
                />
              ) : null}
              <div className="composer-footer">
                <button type="button" onClick={goBack} disabled={processing || answeredCount === 0}>
                  <ChevronLeft size={16} /> Voltar
                </button>
                <span><LockKeyhole size={14} /> Envio protegido</span>
              </div>
            </div>
          )}
        </section>
      </main>

      {showReset && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowReset(false)}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="dialog-icon"><RotateCcw size={22} /></span>
            <h2 id="reset-title">Reiniciar o orçamento?</h2>
            <p>As respostas desta sessão serão apagadas com segurança e não poderão ser recuperadas.</p>
            <div>
              <button className="secondary-button" type="button" onClick={() => setShowReset(false)}>Continuar preenchendo</button>
              <button className="danger-button" type="button" onClick={() => void reset(true)} disabled={processing}>Apagar e reiniciar</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
