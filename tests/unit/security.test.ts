import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSessionCookies, contentSecurityPolicy, csrfCookies, parseCookies, requestOriginIsAllowed, sessionCookies } from '../../worker/security';
import { api } from '../../src/api';

const env = {
  ALLOWED_ORIGINS: 'https://cogdev.com.br,http://localhost:5173',
  ENVIRONMENT: 'production',
  C6_ALLOWED_PAYMENT_HOSTS: 'checkout2.c6pay.com.br,*.c6pay.com.br',
} as any;

describe('HTTP security', () => {
  afterEach(() => {
    for (const cookie of clearSessionCookies(env)) document.cookie = cookie;
    vi.unstubAllGlobals();
  });

  it('restricts browser origins', () => {
    expect(requestOriginIsAllowed(new Request('https://cogdev.com.br/api', { headers: { Origin: 'https://cogdev.com.br' } }), env)).toBe(true);
    expect(requestOriginIsAllowed(new Request('https://cogdev.com.br/api', { headers: { Origin: 'https://evil.example' } }), env)).toBe(false);
  });

  it('uses HttpOnly, Secure and SameSite for the conversation token', () => {
    const [session, csrf] = sessionCookies(env, 'secret', 'csrf', new Date(Date.now() + 60_000));
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Strict');
    expect(session).toContain('Path=/api;');
    expect(csrf).not.toContain('HttpOnly');
    expect(csrf).toContain('Path=/;');
    expect(csrf).toContain('Secure');
    expect(csrf).toContain('SameSite=Strict');
  });

  it('makes a new session CSRF token readable by the chat and sends it with answers', async () => {
    for (const cookie of sessionCookies(env, 'secret', 'test-csrf', new Date(Date.now() + 60_000))) {
      document.cookie = cookie;
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ saved: true })));
    vi.stubGlobal('fetch', fetchMock);

    await api.saveAnswer('name', 'Maria', 1);

    expect(fetchMock).toHaveBeenCalledWith('/api/session/answer', expect.objectContaining({
      headers: expect.objectContaining({ 'X-CSRF-Token': 'test-csrf' }),
    }));
    expect(document.cookie).not.toContain('cogdev_session');
  });

  it('migrates the API-only cookie without leaving a duplicate and clears both paths', () => {
    document.cookie = 'cogdev_csrf=legacy-token; Path=/api; SameSite=Strict';
    expect(document.cookie).not.toContain('cogdev_csrf');

    for (const cookie of csrfCookies(env, 'legacy-token', new Date(Date.now() + 60_000))) {
      document.cookie = cookie;
    }
    expect(document.cookie).toContain('cogdev_csrf=legacy-token');

    window.history.replaceState({}, '', '/api/session');
    try {
      expect(document.cookie.match(/cogdev_csrf=/g)).toHaveLength(1);
      for (const cookie of clearSessionCookies(env)) document.cookie = cookie;
      expect(document.cookie).not.toContain('cogdev_csrf');
    } finally {
      window.history.replaceState({}, '', '/');
    }
    expect(document.cookie).not.toContain('cogdev_csrf');
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
