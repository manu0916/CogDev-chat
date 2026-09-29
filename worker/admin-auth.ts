import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { AdminRole } from '../shared/contracts';
import type { AdminUser, Env } from './types';

type Permission =
  | 'listConversations'
  | 'viewConversation'
  | 'viewPii'
  | 'reply'
  | 'assign'
  | 'changeStatus'
  | 'block'
  | 'readNotes'
  | 'writeNotes'
  | 'manageProposals';

const permissions: Record<AdminRole, ReadonlySet<Permission>> = {
  owner: new Set(['listConversations', 'viewConversation', 'viewPii', 'reply', 'assign', 'changeStatus', 'block', 'readNotes', 'writeNotes', 'manageProposals']),
  admin: new Set(['listConversations', 'viewConversation', 'viewPii', 'reply', 'assign', 'changeStatus', 'block', 'readNotes', 'writeNotes', 'manageProposals']),
  agent: new Set(['listConversations', 'viewConversation', 'viewPii', 'reply', 'assign', 'changeStatus', 'readNotes', 'writeNotes']),
  viewer: new Set(['listConversations', 'viewConversation']),
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const can = (admin: AdminUser, permission: Permission) => permissions[admin.role].has(permission);

const localRequest = (request: Request, env: Env) => {
  if (env.ENVIRONMENT !== 'development') return false;
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1';
};

const ensureLocalAdmin = async (env: Env) => {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_users (access_subject, email, display_name, role, active, created_at, updated_at)
    VALUES ('local-development-admin', 'admin@localhost', 'Admin local', 'owner', 1, ?1, ?1)
    ON CONFLICT(access_subject) DO UPDATE SET active = 1, updated_at = excluded.updated_at
  `).bind(now).run();
  return env.DB.prepare(`
    SELECT id, access_subject, email, display_name, role, active
    FROM admin_users WHERE access_subject = 'local-development-admin' AND active = 1
  `).first<AdminUser>();
};

const verifyAccessToken = async (request: Request, env: Env): Promise<JWTPayload | null> => {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  try {
    const verified = await jwtVerify(token, jwks, {
      audience: env.CF_ACCESS_AUD,
      issuer: teamDomain,
      algorithms: ['RS256'],
    });
    return verified.payload;
  } catch {
    return null;
  }
};

const provisionBootstrapAdmin = async (payload: JWTPayload, env: Env) => {
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  const subject = payload.sub || '';
  const allowed = env.ADMIN_BOOTSTRAP_EMAILS.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!subject || !email || !allowed.includes(email)) return null;
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO admin_users (access_subject, email, display_name, role, active, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'owner', 1, ?4, ?4)
    ON CONFLICT(email) DO UPDATE SET access_subject = excluded.access_subject, updated_at = excluded.updated_at
  `).bind(subject, email, email.split('@')[0], now).run();
  return env.DB.prepare(`
    SELECT id, access_subject, email, display_name, role, active
    FROM admin_users WHERE access_subject = ?1 AND active = 1
  `).bind(subject).first<AdminUser>();
};

export const authenticateAdmin = async (request: Request, env: Env): Promise<AdminUser | null> => {
  if (localRequest(request, env)) return ensureLocalAdmin(env);
  const payload = await verifyAccessToken(request, env);
  if (!payload?.sub || typeof payload.email !== 'string') return null;
  const email = payload.email.toLowerCase();
  if (env.CF_ACCESS_ALLOWED_DOMAIN && !email.endsWith(`@${env.CF_ACCESS_ALLOWED_DOMAIN.toLowerCase()}`)) return null;
  const existing = await env.DB.prepare(`
    SELECT id, access_subject, email, display_name, role, active
    FROM admin_users
    WHERE access_subject = ?1 AND email = ?2 AND active = 1
    LIMIT 1
  `).bind(payload.sub, email).first<AdminUser>();
  return existing || provisionBootstrapAdmin(payload, env);
};
