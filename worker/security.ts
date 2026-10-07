import type { Env } from './types';

export const contentSecurityPolicy = (env: Env) => {
  const paymentHosts = env.C6_ALLOWED_PAYMENT_HOSTS.split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => /^(\*\.)?[a-z0-9.-]+$/.test(host))
    .map((host) => `https://${host}`);
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "font-src 'self'",
    `navigate-to 'self' ${paymentHosts.join(' ')}`.trim(),
  ].join('; ');
};

export const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export const allowedOrigins = (env: Env) =>
  env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);

export const requestOriginIsAllowed = (request: Request, env: Env) => {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return allowedOrigins(env).includes(origin);
};

export const responseHeaders = (request: Request, env: Env, extra?: HeadersInit) => {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Security-Policy', contentSecurityPolicy(env));
  const origin = request.headers.get('Origin');
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
};

export const json = (
  request: Request,
  env: Env,
  body: unknown,
  status = 200,
  extra?: HeadersInit,
  cookies: string[] = [],
) => {
  const headers = responseHeaders(request, env, extra);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
};

export const apiError = (
  request: Request,
  env: Env,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) => {
  const errorId = crypto.randomUUID();
  console.error(JSON.stringify({ event: 'api_error', errorId, status, code, path: new URL(request.url).pathname }));
  return json(request, env, { error: { code, message, errorId, ...(details ? { details } : {}) } }, status);
};

export const parseJsonBody = async <T>(request: Request, maxBytes = 32_768): Promise<T> => {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > maxBytes) throw new RequestBodyError('PAYLOAD_TOO_LARGE');
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new RequestBodyError('UNSUPPORTED_MEDIA_TYPE');
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new RequestBodyError('PAYLOAD_TOO_LARGE');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new RequestBodyError('INVALID_JSON');
  }
};

export class RequestBodyError extends Error {
  constructor(public readonly code: 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'INVALID_JSON') {
    super(code);
  }
}

export const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const randomToken = (bytes = 32) => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export const parseCookies = (request: Request) => {
  const values = new Map<string, string>();
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { values.set(key, decodeURIComponent(value)); } catch { /* Ignore malformed cookies. */ }
  }
  return values;
};

export const csrfCookies = (env: Env, csrfToken: string, expiresAt: Date) => {
  const secure = env.ENVIRONMENT === 'production' ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000));
  return [
    // The chat at / must read this token to populate X-CSRF-Token.
    `cogdev_csrf=${encodeURIComponent(csrfToken)}${secure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
    // Remove the old API-only cookie to avoid two values with the same name.
    `cogdev_csrf=${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
  ];
};

export const sessionCookies = (env: Env, accessToken: string, csrfToken: string, expiresAt: Date) => {
  const secure = env.ENVIRONMENT === 'production' ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000));
  return [
    `cogdev_session=${encodeURIComponent(accessToken)}; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=${maxAge}`,
    ...csrfCookies(env, csrfToken, expiresAt),
  ];
};

export const clearSessionCookies = (env: Env) => {
  const secure = env.ENVIRONMENT === 'production' ? '; Secure' : '';
  return [
    `cogdev_session=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
    ...csrfCookies(env, '', new Date(0)),
  ];
};

export const getClientIpKey = async (request: Request, env: Env) => {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const salt = env.RATE_LIMIT_SALT || (env.ENVIRONMENT === 'production' ? '' : 'local-development-only');
  if (!salt) throw new Error('RATE_LIMIT_SALT is required in production');
  return sha256(`${salt}|${ip}`);
};
