import { describe, expect, it } from 'vitest';
import { canTransition } from '../../worker/conversation-policy';
import { can } from '../../worker/admin-auth';

const admin = (role: 'owner' | 'admin' | 'agent' | 'viewer') => ({ role, active: 1 } as any);

describe('conversation authorization', () => {
  it('prevents the client from assuming, blocking or reopening freely', () => {
    expect(canTransition('client', 'waiting_admin', 'active')).toBe(false);
    expect(canTransition('client', 'active', 'blocked')).toBe(false);
    expect(canTransition('client', 'resolved', 'waiting_admin')).toBe(true);
  });

  it('validates blocked, resolved and reopen transitions', () => {
    expect(canTransition('admin', 'active', 'blocked')).toBe(true);
    expect(canTransition('admin', 'active', 'resolved')).toBe(true);
    expect(canTransition('admin', 'resolved', 'waiting_admin')).toBe(true);
    expect(canTransition('admin', 'blocked', 'active')).toBe(false);
  });

  it('keeps proposal and payment permissions away from agents and viewers', () => {
    expect(can(admin('owner'), 'manageProposals')).toBe(true);
    expect(can(admin('admin'), 'manageProposals')).toBe(true);
    expect(can(admin('agent'), 'manageProposals')).toBe(false);
    expect(can(admin('viewer'), 'reply')).toBe(false);
  });
});
