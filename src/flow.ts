import type { AnswerValue, ProjectType, QuestionKey, QuotePayload } from '../shared/contracts';

export type Answers = Partial<Record<QuestionKey, AnswerValue>>;

export type Choice = {
  value: string;
  label: string;
  description?: string;
};

export type Question = {
  key: QuestionKey;
  prompt: string | ((answers: Answers) => string);
  label: string;
  input: 'text' | 'textarea' | 'choices' | 'contact' | 'consent';
  placeholder?: string;
  optional?: boolean;
  choices?: Choice[];
  validate?: (value: AnswerValue, answers: Answers) => string | null;
};

export const projectTypeLabels: Record<ProjectType, string> = {
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

const textLength = (minimum: number, maximum: number, label: string) => (value: AnswerValue) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < minimum) return `${label} precisa de um pouco mais de detalhe.`;
  if (text.length > maximum) return `Use no máximo ${maximum} caracteres.`;
  return null;
};

const baseQuestions: Question[] = [
  {
    key: 'name',
    label: 'Nome',
    prompt: 'Para começar, como podemos chamar você?',
    input: 'text',
    placeholder: 'Seu nome',
    validate: textLength(2, 80, 'O nome'),
  },
  {
    key: 'company',
    label: 'Empresa',
    prompt: ({ name }) => `Prazer, ${typeof name === 'string' ? name.split(' ')[0] : ''}. Você fala por alguma empresa?`,
    input: 'text',
    placeholder: 'Nome da empresa',
    optional: true,
    choices: [{ value: '', label: 'Não se aplica' }],
    validate: (value) => (typeof value === 'string' && value.length <= 100 ? null : 'Use no máximo 100 caracteres.'),
  },
  {
    key: 'contactMethod',
    label: 'Forma de contato',
    prompt: 'Qual é a melhor forma de entrarmos em contato?',
    input: 'choices',
    choices: [
      { value: 'whatsapp', label: 'WhatsApp' },
      { value: 'email', label: 'E-mail' },
    ],
  },
  {
    key: 'contactValue',
    label: 'Contato',
    prompt: (answers) => answers.contactMethod === 'email'
      ? 'Qual e-mail devemos usar?'
      : 'Qual é o seu WhatsApp com DDD?',
    input: 'contact',
    placeholder: 'Digite seu contato',
  },
  {
    key: 'projectType',
    label: 'Tipo de projeto',
    prompt: 'Que tipo de solução você precisa?',
    input: 'choices',
    choices: Object.entries(projectTypeLabels).map(([value, label]) => ({ value, label })),
  },
  {
    key: 'objective',
    label: 'Objetivo',
    prompt: 'Qual é o principal resultado que esse projeto precisa gerar?',
    input: 'textarea',
    placeholder: 'Ex.: centralizar o atendimento e reduzir tarefas manuais…',
    validate: textLength(10, 1_200, 'O objetivo'),
  },
  {
    key: 'audience',
    label: 'Público',
    prompt: 'Quem vai usar essa solução?',
    input: 'textarea',
    placeholder: 'Ex.: equipe comercial, clientes, parceiros…',
    validate: textLength(2, 500, 'O público'),
  },
  {
    key: 'features',
    label: 'Funcionalidades',
    prompt: 'Quais funcionalidades são indispensáveis para você?',
    input: 'textarea',
    placeholder: 'Liste o que a solução precisa fazer',
    validate: textLength(2, 1_500, 'As funcionalidades'),
  },
];

const specificQuestion = (type: ProjectType): Question | null => {
  const prompts: Partial<Record<ProjectType, string>> = {
    ecommerce: 'Conte sobre produtos, formas de pagamento, entregas e controle de estoque.',
    crm: 'Como funcionam hoje seus clientes, funil, equipe, permissões e integrações?',
    site: 'Quais páginas imagina? Já possui conteúdo, domínio e identidade visual?',
    'landing-page': 'Qual oferta será apresentada e qual ação o visitante deve realizar?',
    'mobile-app': 'O app será para Android, iOS ou ambos? Precisa de notificações, login e publicação nas lojas?',
    automation: 'Quais sistemas participam, o que dispara a automação e qual é o volume aproximado?',
    integration: 'Quais sistemas precisam conversar e que dados devem ser sincronizados?',
    maintenance: 'O que existe hoje e quais problemas ou melhorias são prioritários?',
    'web-system': 'Como é o processo principal e quais perfis de usuário participam dele?',
    'admin-panel': 'Quais dados e operações precisam ser gerenciados no painel?',
  };
  const prompt = prompts[type];
  if (!prompt) return null;
  return {
    key: 'projectSpecific',
    label: 'Detalhes específicos',
    prompt,
    input: 'textarea',
    placeholder: 'Conte o que já sabe; não precisa ter tudo definido',
    optional: true,
    validate: (value) => (typeof value === 'string' && value.length <= 1_200 ? null : 'Use no máximo 1.200 caracteres.'),
  };
};

const closingQuestions: Question[] = [
  {
    key: 'authNeeds',
    label: 'Login e acessos',
    prompt: 'A solução precisa de login ou diferentes níveis de acesso?',
    input: 'choices',
    choices: [
      { value: 'none', label: 'Não precisa' },
      { value: 'single', label: 'Login simples' },
      { value: 'roles', label: 'Perfis e permissões' },
      { value: 'not-sure', label: 'Ainda não sei' },
    ],
  },
  {
    key: 'integrations',
    label: 'Integrações',
    prompt: 'Precisa integrar com alguma ferramenta ou sistema?',
    input: 'textarea',
    placeholder: 'Ex.: ERP, gateway de pagamento, Google…',
    choices: [{ value: 'Nenhuma integração prevista', label: 'Nenhuma por enquanto' }],
    validate: (value) => (typeof value === 'string' && value.trim().length > 0 && value.length <= 1_000 ? null : 'Informe uma opção ou descreva as integrações.'),
  },
  {
    key: 'visualIdentity',
    label: 'Design',
    prompt: 'Como está a identidade visual ou o design do projeto?',
    input: 'choices',
    choices: [
      { value: 'ready', label: 'Tudo pronto' },
      { value: 'partial', label: 'Temos uma parte' },
      { value: 'none', label: 'Precisamos criar' },
      { value: 'not-sure', label: 'Ainda não sei' },
    ],
  },
  {
    key: 'existingProject',
    label: 'Projeto anterior',
    prompt: 'Já existe um projeto ou código anterior relacionado?',
    input: 'choices',
    choices: [
      { value: 'yes', label: 'Sim' },
      { value: 'no', label: 'Não' },
    ],
  },
  {
    key: 'deadline',
    label: 'Prazo',
    prompt: 'Quando você gostaria de colocar o projeto em uso?',
    input: 'choices',
    choices: [
      { value: 'urgent', label: 'É urgente' },
      { value: '1-2-months', label: 'Em 1–2 meses' },
      { value: '3-4-months', label: 'Em 3–4 meses' },
      { value: '5-plus-months', label: 'Em 5+ meses' },
      { value: 'flexible', label: 'Prazo flexível' },
    ],
  },
  {
    key: 'budget',
    label: 'Investimento',
    prompt: 'Qual faixa de investimento você considera para o projeto?',
    input: 'choices',
    choices: [
      { value: 'under-1k', label: 'Até R$ 1.000' },
      { value: '1-2k', label: 'R$ 1.001–2.000' },
      { value: '2-3k', label: 'R$ 2.001–3.000' },
      { value: 'custom', label: 'Personalizar orçamento' },
    ],
    validate: (value) => typeof value === 'string' && (
      ['under-1k', '1-2k', '2-3k', 'under-5k', '5-15k', '15-30k', '30-60k', '60k-plus', 'not-sure'].includes(value)
      || /^custom:[1-9]\d{0,7}$/.test(value)
    ) ? null : 'Informe um valor personalizado válido em reais.',
  },
  {
    key: 'notes',
    label: 'Observações',
    prompt: 'Há mais alguma informação que pode nos ajudar na análise?',
    input: 'textarea',
    placeholder: 'Contexto, restrições ou referências importantes',
    optional: true,
    choices: [{ value: '', label: 'Não, podemos continuar' }],
    validate: (value) => (typeof value === 'string' && value.length <= 1_500 ? null : 'Use no máximo 1.500 caracteres.'),
  },
  {
    key: 'consent',
    label: 'Consentimento',
    prompt: 'Antes da revisão: podemos usar estes dados para analisar seu pedido e entrar em contato?',
    input: 'consent',
  },
];

export const buildFlow = (answers: Answers): Question[] => {
  const type = answers.projectType as ProjectType | undefined;
  const specific = type ? specificQuestion(type) : null;
  return [...baseQuestions, ...(specific ? [specific] : []), ...closingQuestions];
};

export const getQuestionPrompt = (question: Question, answers: Answers) =>
  typeof question.prompt === 'function' ? question.prompt(answers) : question.prompt;

export const choiceLabel = (question: Question, value: AnswerValue) => {
  if (typeof value === 'boolean') return value ? 'Autorizado' : 'Não autorizado';
  if (Array.isArray(value)) return value.join(', ');
  if (question.key === 'budget' && typeof value === 'string') {
    if (value.startsWith('custom:')) {
      const amount = Number(value.slice('custom:'.length));
      if (Number.isFinite(amount)) {
        return `Personalizar orçamento: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(amount)}`;
      }
    }
    const legacyBudgetLabels: Record<string, string> = {
      'under-5k': 'Até R$ 5 mil',
      '5-15k': 'R$ 5–15 mil',
      '15-30k': 'R$ 15–30 mil',
      '30-60k': 'R$ 30–60 mil',
      '60k-plus': 'Acima de R$ 60 mil',
      'not-sure': 'Ainda não sei',
    };
    if (legacyBudgetLabels[value]) return legacyBudgetLabels[value];
  }
  return question.choices?.find((choice) => choice.value === value)?.label || value || 'Não se aplica';
};

export const toQuotePayload = (answers: Answers, turnstileToken: string): QuotePayload => ({
  name: String(answers.name ?? ''),
  company: String(answers.company ?? '') || undefined,
  contact: {
    method: answers.contactMethod as 'whatsapp' | 'email',
    value: String(answers.contactValue ?? ''),
  },
  projectType: answers.projectType as ProjectType,
  objective: String(answers.objective ?? ''),
  audience: String(answers.audience ?? ''),
  features: String(answers.features ?? ''),
  projectSpecific: String(answers.projectSpecific ?? '') || undefined,
  authNeeds: answers.authNeeds as QuotePayload['authNeeds'],
  integrations: String(answers.integrations ?? ''),
  visualIdentity: answers.visualIdentity as QuotePayload['visualIdentity'],
  existingProject: answers.existingProject as QuotePayload['existingProject'],
  deadline: answers.deadline as QuotePayload['deadline'],
  budget: answers.budget as QuotePayload['budget'],
  notes: String(answers.notes ?? '') || undefined,
  consent: true,
  turnstileToken,
});
