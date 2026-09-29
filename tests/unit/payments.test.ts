import { describe, expect, it } from 'vitest';
import { C6CheckoutApiProvider, ManualPaymentLinkProvider, PaymentProviderError, validateManualPaymentUrl } from '../../worker/payments';

describe('payment security', () => {
  const hosts = 'checkout2.c6pay.com.br,*.c6pay.com.br';

  it('allows only configured HTTPS C6 hosts', () => {
    expect(validateManualPaymentUrl('https://checkout2.c6pay.com.br/payment-v2/example', hosts)).toContain('checkout2.c6pay.com.br');
    expect(validateManualPaymentUrl('https://secure.c6pay.com.br/p/abc', hosts)).toContain('secure.c6pay.com.br');
  });

  it('rejects malicious, lookalike, insecure and credential-bearing URLs', () => {
    expect(validateManualPaymentUrl('https://c6bank.com.br.attacker.example/pay', hosts)).toBeNull();
    expect(validateManualPaymentUrl('http://checkout2.c6pay.com.br/pay', hosts)).toBeNull();
    expect(validateManualPaymentUrl('https://user:pass@checkout2.c6pay.com.br/pay', hosts)).toBeNull();
    expect(validateManualPaymentUrl('https://c6pay.com.br/pay', hosts)).toBeNull();
  });

  it('fails closed when API credentials are absent', () => {
    expect(() => new C6CheckoutApiProvider({ C6_CHECKOUT_ADAPTER_URL: '' } as any)).toThrow(PaymentProviderError);
  });

  it('rejects webhook confirmation in manual mode', async () => {
    const provider = new ManualPaymentLinkProvider('https://checkout2.c6pay.com.br/payment-v2/example', null);
    await expect(provider.verifyWebhookSignature()).resolves.toBe(false);
    await expect(provider.processWebhook()).rejects.toMatchObject({ code: 'WEBHOOK_UNSUPPORTED' });
  });

  it('rejects API webhooks when the verification secret is absent', async () => {
    const provider = new C6CheckoutApiProvider({
      C6_CLIENT_ID: 'test-id',
      C6_CLIENT_SECRET: 'test-secret',
      C6_CHECKOUT_ADAPTER_URL: 'https://adapter.example.com',
    } as any);
    await expect(provider.verifyWebhookSignature('{}', new Headers())).resolves.toBe(false);
  });
});
