import type { ConversationStatus } from '../shared/contracts';

export type Participant = 'client' | 'admin';

export const allowedTransitions: Record<Participant, Partial<Record<ConversationStatus, readonly ConversationStatus[]>>> = {
  client: {
    bot_collecting: ['waiting_admin'],
    waiting_admin: ['resolved'],
    active: ['resolved'],
    waiting_client: ['resolved'],
    resolved: ['waiting_admin'],
  },
  admin: {
    bot_collecting: ['waiting_admin', 'active', 'blocked'],
    waiting_admin: ['active', 'blocked'],
    active: ['waiting_client', 'resolved', 'blocked'],
    waiting_client: ['active', 'resolved', 'blocked'],
    resolved: ['waiting_admin', 'active'],
    blocked: ['waiting_admin'],
  },
};

export const canTransition = (participant: Participant, from: ConversationStatus, to: ConversationStatus) =>
  allowedTransitions[participant][from]?.includes(to) ?? false;
