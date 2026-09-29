import { expect, test, type Page, type Route } from '@playwright/test';

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const proposal = {
  publicId: 'PROP-TESTE-SEGURO',
  version: 1,
  scopeSummary: 'Plataforma de atendimento com briefing, chat e painel administrativo.',
  totalAmount: 1250000,
  depositAmount: 375000,
  currency: 'BRL' as const,
  estimatedDeadline: '8 a 10 semanas após o sinal',
  paymentTerms: '30% de sinal e saldo por marcos aprovados.',
  maxInstallments: 6,
  paymentMode: 'manual_payment_link' as const,
  status: 'awaiting_client_approval' as const,
  validUntil: '2030-12-31T23:59:59.000Z',
  acceptedAt: null,
  payment: { status: 'created', paidAt: null, expiresAt: '2030-12-31T23:59:59.000Z', paymentUrl: null },
};

async function mockClientApi(page: Page, counters: { accepted: number; checkout: number }) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/config') return json(route, { turnstileSiteKey: null, turnstileRequired: false, pricingEnabled: false, retentionDays: 180 });
    if (path === '/api/session') return json(route, {
      status: 'in_progress', currentStep: 0, expiresAt: '2030-12-31T23:59:59.000Z', answers: {},
      conversation: { status: 'waiting_admin', statusLabel: 'Aguardando atendimento', lastMessageAt: null }, quoteResult: null,
    });
    if (path === '/api/conversations/current/messages' && request.method() === 'GET') {
      return json(route, { messages: [], nextCursor: null, status: 'waiting_admin' });
    }
    if (path === '/api/conversations/current/read') return json(route, { read: true });
    if (path === '/api/proposals/current' && request.method() === 'GET') return json(route, { proposal });
    if (path === '/api/proposals/current/accept') {
      counters.accepted += 1;
      expect(request.postDataJSON()).toEqual({ accepted: true });
      return json(route, { accepted: true, status: 'approved' });
    }
    if (path === '/api/proposals/current/checkout') {
      counters.checkout += 1;
      expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
      return json(route, { checkoutUrl: null, paymentStatus: 'awaiting_payment' });
    }
    return json(route, { error: { code: 'NOT_MOCKED', message: path } }, 404);
  });
}

test('cliente precisa aceitar explicitamente e clique duplo cria só um checkout', async ({ page }) => {
  const counters = { accepted: 0, checkout: 0 };
  await mockClientApi(page, counters);
  await page.goto('/');

  await expect(page.getByText('Plataforma de atendimento com briefing')).toBeVisible();
  await page.getByRole('button', { name: 'Revisar proposta' }).click();

  const consent = page.getByRole('checkbox', { name: 'Li e aceito a proposta e as condições apresentadas.' });
  const pay = page.getByRole('button', { name: 'Aprovar e pagar sinal' });
  await expect(consent).not.toBeChecked();
  await expect(pay).toBeDisabled();
  expect(counters).toEqual({ accepted: 0, checkout: 0 });

  await consent.check();
  await expect(pay).toBeEnabled();
  await pay.dblclick();
  await expect.poll(() => counters).toEqual({ accepted: 1, checkout: 1 });
});

test('a revisão de proposta não causa overflow horizontal', async ({ page }) => {
  const counters = { accepted: 0, checkout: 0 };
  await mockClientApi(page, counters);
  await page.goto('/');
  await page.getByRole('button', { name: 'Revisar proposta' }).click();

  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
  await expect(page.getByRole('checkbox')).toBeVisible();
});
