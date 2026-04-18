import { Hono } from 'hono';
import { z } from 'zod';
import { deleteCookie } from 'hono/cookie';
import type { Env } from '../env';
import { createSession, getSession, setSessionCookie, verifyPassword } from '../lib/auth';
import { hashPassword, needsRehash } from '../lib/password';

export const authApp = new Hono<{ Bindings: Env }>();

authApp.post('/login', async (c) => {
  const body = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .parse(await c.req.json());

  const user = await c.env.DB.prepare(
    `SELECT id, password_hash FROM user WHERE email = ?`,
  )
    .bind(body.email.toLowerCase())
    .first<{ id: string; password_hash: string | null }>();
  if (!user?.password_hash) return c.json({ error: 'invalid_credentials' }, 401);

  const ok = await verifyPassword(body.password, user.password_hash);
  if (!ok) return c.json({ error: 'invalid_credentials' }, 401);

  if (needsRehash(user.password_hash)) {
    const fresh = await hashPassword(body.password);
    await c.env.DB.prepare(`UPDATE user SET password_hash = ? WHERE id = ?`).bind(fresh, user.id).run();
  }

  const ws = await c.env.DB.prepare(
    `SELECT workspace_id FROM workspace_user WHERE user_id = ? ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(user.id)
    .first<{ workspace_id: string }>();

  const sessionId = await createSession(c.env, user.id, ws?.workspace_id);
  await setSessionCookie(c, sessionId);
  await c.env.DB.prepare(`UPDATE user SET last_login_at = ? WHERE id = ?`)
    .bind(Date.now(), user.id)
    .run();

  return c.json({ ok: true, userId: user.id, workspaceId: ws?.workspace_id });
});

authApp.post('/logout', async (c) => {
  const s = await getSession(c);
  if (s) {
    await c.env.DB.prepare(`DELETE FROM session WHERE id = ?`).bind(s.sessionId).run();
  }
  deleteCookie(c, 'ranse_session', { path: '/' });
  return c.json({ ok: true });
});

authApp.get('/me', async (c) => {
  const s = await getSession(c);
  if (!s) return c.json({ authenticated: false });
  const user = await c.env.DB.prepare(
    `SELECT id, email, name FROM user WHERE id = ?`,
  )
    .bind(s.userId)
    .first<{ id: string; email: string; name: string | null }>();
  const workspaces = await c.env.DB.prepare(
    `SELECT w.id, w.name, wu.role FROM workspace_user wu JOIN workspace w ON w.id = wu.workspace_id WHERE wu.user_id = ?`,
  )
    .bind(s.userId)
    .all<{ id: string; name: string; role: string }>();
  return c.json({
    authenticated: true,
    user,
    workspaces: workspaces.results ?? [],
    currentWorkspaceId: s.workspaceId,
  });
});
