import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, parseCookies, requestOriginIsAllowed, sessionCookies } from '../../worker/security';

const env = {
  ALLOWED_ORIGINS: 'https://cogdev.com.br,http://localhost:5173',
  ENVIRONMENT: 'production',
  C6_ALLOWED_PAYMENT_HOSTS: 'checkout2.c6pay.com.br,*.c6pay.com.br',
} as any;

describe('HTTP security', () => {
  it('restricts browser origins', () => {
    expect(requestOriginIsAllowed(new Request('https://cogdev.com.br/api', { headers: { Origin: 'https://cogdev.com.br' } }), env)).toBe(true);
    expect(requestOriginIsAllowed(new Request('https://cogdev.com.br/api', { headers: { Origin: 'https://evil.example' } }), env)).toBe(false);
  });

  it('uses HttpOnly, Secure and SameSite for the conversation token', () => {
    const [session, csrf] = sessionCookies(env, 'secret', 'csrf', new Date(Date.now() + 60_000));
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Strict');
    expect(csrf).not.toContain('HttpOnly');
  });

  it('parses cookies without evaluating content', () => {
    const cookies = parseCookies(new Request('https://cogdev.com.br', { headers: { Cookie: 'a=1; payload=%3Cscript%3E' } }));
    expect(cookies.get('payload')).toBe('<script>');
  });

  it('has a strict CSP and limits payment navigation', () => {
    const csp = contentSecurityPolicy(env);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('https://checkout2.c6pay.com.br');
    expect(csp).not.toContain('https://*;');
  });
});
