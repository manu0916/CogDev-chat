import type { QuotePayload } from '../shared/contracts';

// Valores exclusivamente ilustrativos. Esta configuração permanece desativada
// até a Cog Dev validar e habilitar ENABLE_SAMPLE_PRICING no ambiente do Worker.
export const SAMPLE_PRICING_VERSION = 'sample-2026-09-disabled-by-default';

const sampleBase: Record<QuotePayload['projectType'], [number, number, number, number]> = {
  site: [4_000, 9_000, 15, 30],
  'landing-page': [2_500, 6_000, 7, 18],
  ecommerce: [10_000, 28_000, 35, 75],
  crm: [18_000, 50_000, 50, 110],
  'web-system': [15_000, 45_000, 45, 100],
  'mobile-app': [22_000, 65_000, 60, 130],
  automation: [5_000, 18_000, 14, 45],
  'admin-panel': [10_000, 30_000, 30, 75],
  integration: [6_000, 22_000, 18, 55],
  maintenance: [3_000, 15_000, 10, 40],
  other: [8_000, 30_000, 25, 75],
};

export type Estimate = {
  minimumAmount: number;
  maximumAmount: number;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  pricingVersion: string;
};

export const calculateSampleEstimate = (quote: QuotePayload): Estimate => {
  const [baseMin, baseMax, daysMin, daysMax] = sampleBase[quote.projectType];
  let multiplier = 1;
  if (quote.authNeeds === 'roles') multiplier += 0.2;
  if (quote.integrations !== 'Nenhuma integração prevista') multiplier += 0.15;
  if (quote.deadline === 'urgent') multiplier += 0.2;
  if (quote.visualIdentity === 'none') multiplier += 0.12;
  const featureCount = quote.features.split(/[,;\n]/).filter((item) => item.trim().length > 2).length;
  if (featureCount >= 6) multiplier += 0.18;

  return {
    minimumAmount: Math.round((baseMin * multiplier) / 100) * 100,
    maximumAmount: Math.round((baseMax * multiplier) / 100) * 100,
    estimatedDaysMin: daysMin,
    estimatedDaysMax: daysMax,
    pricingVersion: SAMPLE_PRICING_VERSION,
  };
};
