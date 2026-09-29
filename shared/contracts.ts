import { z } from 'zod';

export const projectTypes = [
  'site',
  'landing-page',
  'ecommerce',
  'crm',
  'web-system',
  'mobile-app',
  'automation',
  'admin-panel',
  'integration',
  'maintenance',
  'other',
] as const;

export const questionKeys = [
  'name',
  'company',
  'contactMethod',
  'contactValue',
  'projectType',
  'objective',
  'audience',
  'features',
  'projectSpecific',
  'authNeeds',
  'integrations',
  'visualIdentity',
  'existingProject',
  'deadline',
  'budget',
  'notes',
  'consent',
] as const;

export const answerValueSchema = z.union([
  z.string().max(1_500),
  z.boolean(),
  z.array(z.string().max(120)).max(20),
]);

export const createSessionSchema = z
  .object({ resume: z.boolean().optional() })
  .strict();

export const saveAnswerSchema = z
  .object({
    questionKey: z.enum(questionKeys),
    answerValue: answerValueSchema,
    currentStep: z.number().int().min(0).max(40),
  })
  .strict();

const trimmed = (minimum: number, maximum: number, label: string) =>
  z
    .string()
    .trim()
    .min(minimum, `${label} precisa ter pelo menos ${minimum} caracteres.`)
    .max(maximum, `${label} excedeu o limite de ${maximum} caracteres.`);

export const emailSchema = z
  .string()
  .trim()
  .max(160)
  .email('Informe um e-mail válido.')
  .transform((value) => value.toLowerCase());

export const phoneSchema = z
  .string()
  .trim()
  .max(30)
  .transform((value) => value.replace(/[^\d+]/g, ''))
  .refine((value) => /^\+?\d{10,15}$/.test(value), 'Informe um WhatsApp com DDD.');

export const quotePayloadSchema = z
  .object({
    name: trimmed(2, 80, 'O nome'),
    company: z.string().trim().max(100).optional(),
    contact: z
      .object({
        method: z.enum(['whatsapp', 'email']),
        value: z.string().trim().max(160),
      })
      .strict(),
    projectType: z.enum(projectTypes),
    objective: trimmed(10, 1_200, 'O objetivo'),
    audience: trimmed(2, 500, 'O público'),
    features: trimmed(2, 1_500, 'As funcionalidades'),
    projectSpecific: z.string().trim().max(1_200).optional(),
    authNeeds: z.enum(['none', 'single', 'roles', 'not-sure']),
    integrations: z.string().trim().max(1_000),
    visualIdentity: z.enum(['ready', 'partial', 'none', 'not-sure']),
    existingProject: z.enum(['yes', 'no']),
    deadline: z.enum(['urgent', '1-2-months', '3-4-months', '5-plus-months', 'flexible']),
    budget: z.enum(['under-5k', '5-15k', '15-30k', '30-60k', '60k-plus', 'not-sure']),
    notes: z.string().trim().max(1_500).optional(),
    consent: z.literal(true),
    turnstileToken: z.string().min(1).max(2_048),
  })
  .strict()
  .superRefine((data, ctx) => {
    const validation = data.contact.method === 'email'
      ? emailSchema.safeParse(data.contact.value)
      : phoneSchema.safeParse(data.contact.value);

    if (!validation.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['contact', 'value'],
        message: validation.error.issues[0]?.message ?? 'Contato inválido.',
      });
    }
  });

export const submitQuoteSchema = z
  .object({
    quote: quotePayloadSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type ProjectType = (typeof projectTypes)[number];
export type QuestionKey = (typeof questionKeys)[number];
export type AnswerValue = z.infer<typeof answerValueSchema>;
export type QuotePayload = z.infer<typeof quotePayloadSchema>;
export type SubmitQuotePayload = z.infer<typeof submitQuoteSchema>;

export const conversationStatuses = [
  'bot_collecting',
  'waiting_admin',
  'active',
  'waiting_client',
  'resolved',
  'blocked',
  'expired',
] as const;

export const messageBodySchema = z.string().trim().min(1, 'Digite uma mensagem.').max(2_000, 'Use no máximo 2.000 caracteres.');

export const sendMessageSchema = z
  .object({
    type: z.literal('message').optional(),
    clientMessageId: z.string().uuid(),
    body: messageBodySchema,
  })
  .strict();

export const typingEventSchema = z
  .object({ type: z.literal('typing'), active: z.boolean() })
  .strict();

export const readEventSchema = z
  .object({ type: z.literal('read'), lastSequence: z.number().int().nonnegative() })
  .strict();

export const conversationTransitionSchema = z
  .object({ status: z.enum(conversationStatuses) })
  .strict();

export const internalNoteSchema = z
  .object({ body: z.string().trim().min(1).max(2_000) })
  .strict();

export const adminRoles = ['owner', 'admin', 'agent', 'viewer'] as const;

export const proposalStatuses = [
  'draft',
  'awaiting_client_approval',
  'approved',
  'awaiting_payment',
  'payment_confirmed',
  'payment_failed',
  'expired',
  'cancelled',
] as const;

export const paymentModes = ['manual_payment_link', 'c6_checkout_api'] as const;

export const createProposalSchema = z
  .object({
    totalAmount: z.number().int().min(100).max(1_000_000_000),
    depositAmount: z.number().int().min(100).max(1_000_000_000),
    scopeSummary: z.string().trim().min(10).max(4_000),
    estimatedDeadline: z.string().trim().min(2).max(200),
    paymentTerms: z.string().trim().min(5).max(1_500),
    maxInstallments: z.number().int().min(1).max(12),
    validUntil: z.string().datetime({ offset: true }),
    paymentMode: z.enum(paymentModes),
    manualPaymentUrl: z.string().url().max(2_048).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.depositAmount > value.totalAmount) {
      ctx.addIssue({ code: 'custom', path: ['depositAmount'], message: 'O sinal não pode superar o valor total.' });
    }
    if (value.paymentMode === 'manual_payment_link' && !value.manualPaymentUrl) {
      ctx.addIssue({ code: 'custom', path: ['manualPaymentUrl'], message: 'Informe o link de pagamento C6.' });
    }
  });

export const proposalAcceptanceSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

export const paymentLinkSchema = z
  .object({ paymentUrl: z.string().url().max(2_048), expiresAt: z.string().datetime({ offset: true }).optional() })
  .strict();

export type ConversationStatus = (typeof conversationStatuses)[number];
export type AdminRole = (typeof adminRoles)[number];
export type SendMessagePayload = z.infer<typeof sendMessageSchema>;
export type ProposalStatus = (typeof proposalStatuses)[number];
export type PaymentMode = (typeof paymentModes)[number];
export type CreateProposalPayload = z.infer<typeof createProposalSchema>;

export const normalizeContact = (method: 'whatsapp' | 'email', value: string) => {
  const parsed = method === 'email' ? emailSchema.safeParse(value) : phoneSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
