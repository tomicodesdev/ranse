import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { hashPassword as hashPw, verifyPassword as verifyPw } from './password';
import { hmacSign, hmacVerify } from './crypto';
import { ids } from './ids';

const COOKIE_NAME = 'ranse_session';
const MAX_AGE = 60 * 60 * 24 * 30;

export interface SessionData {
  sessionId: string;
  userId: string;
  workspaceId?: string;
}

export async function createSession(
  env: Env,
  userId: string,
  workspaceId?: string,
): Promise<string> {
  const sessionId = ids.session();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO session (id, user_id, workspace_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, userId, workspaceId ?? null, now + MAX_AGE * 1000, now)
    .run();
  return sessionId;
}

export async function setSessionCookie(c: Context<{ Bindings: Env }>, sessionId: string): Promise<void> {
  const secret = c.env.COOKIE_SIGNING_KEY;
  if (!secret) throw new Error('COOKIE_SIGNING_KEY not configured');
  const sig = await hmacSign(secret, sessionId);
  setCookie(c, COOKIE_NAME, `${sessionId}.${sig}`, {
    httpOnly: true,
    secure: !c.env.APP_URL?.startsWith('http://'),
    sameSite: 'Lax',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function getSession(c: Context<{ Bindings: Env }>): Promise<SessionData | null> {
  const raw = getCookie(c, COOKIE_NAME);
  if (!raw) return null;
  const secret = c.env.COOKIE_SIGNING_KEY;
  if (!secret) return null;
  const [sessionId, sig] = raw.split('.');
  if (!sessionId || !sig) return null;
  const expected = await hmacSign(secret, sessionId);
  if (!hmacVerify(expected, sig)) return null;
  const row = await c.env.DB.prepare(
    `SELECT id, user_id, workspace_id, expires_at FROM session WHERE id = ?`,
  )
    .bind(sessionId)
    .first<{ id: string; user_id: string; workspace_id: string | null; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return { sessionId: row.id, userId: row.user_id, workspaceId: row.workspace_id ?? undefined };
}

export async function requireUser(c: Context<{ Bindings: Env }>): Promise<SessionData> {
  const s = await getSession(c);
  if (!s) throw new Response('Unauthorized', { status: 401 });
  return s;
}

export const hashPassword = hashPw;
export const verifyPassword = verifyPw;
