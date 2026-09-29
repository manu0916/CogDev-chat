import { describe, expect, it } from 'vitest';
import { calculateSampleEstimate, SAMPLE_PRICING_VERSION } from '../../worker/pricing';

describe('server pricing', () => {
  it('calculates deterministically and records the rule version', () => {
    const estimate = calculateSampleEstimate({
      projectType: 'crm', authNeeds: 'roles', integrations: 'ERP', deadline: 'urgent', visualIdentity: 'none',
      features: 'Funil, relatórios, tarefas, usuários, metas, automações',
    } as any);
    expect(estimate.minimumAmount).toBeGreaterThan(18_000);
    expect(estimate.pricingVersion).toBe(SAMPLE_PRICING_VERSION);
  });
});
