import { expect, test, type Route } from '@playwright/test';

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test('administrador fecha orçamento com link manual C6 e valores em centavos', async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  const publicId = 'CHAT-TESTE12345678';
  const conversation = {
    publicId,
    status: 'waiting_admin',
    name: 'Cliente teste',
    company: 'Empresa teste',
    projectType: 'web-system',
    assignedTo: null,
    lastMessage: 'Quero conversar sobre a proposta.',
    lastMessageAt: '2030-01-02T10:00:00.000Z',
    unreadCount: 1,
    clientPresence: 'seen_recently',
  };

  await page.route('**/api/admin/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/admin/me') return json(route, { displayName: 'Admin local', email: 'admin@localhost', role: 'owner' });
    if (path === '/api/admin/conversations') return json(route, { conversations: [conversation], page: 0, hasMore: false });
    if (path === `/api/admin/conversations/${publicId}`) return json(route, {
      conversation: { ...conversation, assignedAdminId: null, assigned_to: null, quote_code: 'COG-TESTE', project_type: 'web-system' },
      briefing: { objective: 'Centralizar o atendimento comercial.' },
    });
    if (path === `/api/admin/conversations/${publicId}/messages`) return json(route, { messages: [], notes: [], nextCursor: null, status: 'waiting_admin' });
    if (path === `/api/admin/conversations/${publicId}/read`) return json(route, { read: true });
    if (path === `/api/admin/conversations/${publicId}/proposals` && request.method() === 'GET') return json(route, { proposal: null });
    if (path === `/api/admin/conversations/${publicId}/proposals` && request.method() === 'POST') {
      submitted = request.postDataJSON();
      return json(route, {
        proposal: {
          publicId: 'PROP-TESTE', version: 1, currency: 'BRL', status: 'awaiting_client_approval', acceptedAt: null,
          payment: { status: 'created', paidAt: null, expiresAt: submitted?.validUntil, paymentUrl: submitted?.manualPaymentUrl },
          ...submitted,
        },
      }, 201);
    }
    return json(route, { error: { code: 'NOT_MOCKED', message: path } }, 404);
  });

  await page.goto('/admin');
  const inboxItem = page.getByRole('button', { name: /Cliente teste/ }).first();
  await expect(inboxItem).toBeVisible();
  await inboxItem.click();
  await page.getByRole('button', { name: /Fechar orçamento/i }).click();
  await expect(page.getByRole('heading', { name: 'Fechar orçamento' })).toBeVisible();

  await page.getByLabel('Descrição resumida do escopo').fill('Plataforma web completa com chat e painel administrativo.');
  await page.getByLabel('Valor final (R$)').fill('12.500,00');
  await page.getByLabel('Valor do sinal (R$)').fill('3.750,00');
  await page.getByLabel('Prazo estimado').fill('8 a 10 semanas');
  await page.getByLabel('Máximo de parcelas').selectOption('6');
  await page.getByLabel('Condições de pagamento').fill('30% de sinal e saldo por marcos aprovados.');
  await page.getByLabel('Validade da proposta').fill('2030-12-31T20:00');
  await page.getByLabel('Link de pagamento C6').fill('https://checkout2.c6pay.com.br/payment-v2/TESTE');
  await expect(page.getByText('O servidor aceita somente HTTPS em checkout2.c6pay.com.br.')).toBeVisible();
  await page.getByRole('button', { name: 'Enviar proposta' }).click();

  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted).toMatchObject({
    totalAmount: 1_250_000,
    depositAmount: 375_000,
    maxInstallments: 6,
    paymentMode: 'manual_payment_link',
    manualPaymentUrl: 'https://checkout2.c6pay.com.br/payment-v2/TESTE',
  });
});
