import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { hashPassword, createSession, setSessionCookie, getSession } from '../lib/auth';
import { ids } from '../lib/ids';
import { randomToken } from '../lib/crypto';
import { audit } from '../lib/audit';
import { apiError } from '../lib/errors';
import { applyProvisioning } from '../email/provisioning';

export const setupApp = new Hono<{ Bindings: Env }>();

async function isSetupComplete(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT value FROM setup_state WHERE key = 'completed'`).first<{ value: string }>();
  return row?.value === 'true';
}

async function markSetupComplete(env: Env) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO setup_state (key, value, updated_at) VALUES ('completed', 'true', ?)`,
  )
    .bind(Date.now())
    .run();
}

setupApp.get('/status', async (c) => {
  return c.json({ completed: await isSetupComplete(c.env) });
});

setupApp.post('/bootstrap', async (c) => {
  if (await isSetupComplete(c.env)) {
    return apiError(
      c,
      'already_completed',
      'Setup has already been completed. Sign in or rotate ADMIN_SETUP_TOKEN and re-provision the database.',
    );
  }

  const schema = z.object({
    setup_token: z.string().min(1),
    workspace_name: z.string().min(1).max(100),
    admin_email: z.string().email(),
    admin_password: z.string().min(12),
    admin_name: z.string().min(1).max(100).optional(),
  });
  const body = schema.parse(await c.req.json());

  const expected = c.env.ADMIN_SETUP_TOKEN;
  if (!expected || body.setup_token !== expected) {
    return apiError(
      c,
      'invalid_setup_token',
      'That setup token doesn\'t match. Find the current value in the Cloudflare deploy log, or rotate with `wrangler secret put ADMIN_SETUP_TOKEN`.',
    );
  }

  const workspaceId = ids.workspace();
  const userId = ids.user();
  const now = Date.now();
  const slug = body.workspace_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'workspace';
  const pwHash = await hashPassword(body.admin_password);

  // Seed settings_json with from_name = workspace_name. The runtime falls
  // back to workspace.name anyway, but seeding it makes the Settings UI
  // input show a real value instead of looking empty.
  const initialSettings = JSON.stringify({ from_name: body.workspace_name });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO workspace (id, name, slug, settings_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(workspaceId, body.workspace_name, slug, initialSettings, now),
    c.env.DB.prepare(
      `INSERT INTO user (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(userId, body.admin_email.toLowerCase(), body.admin_name ?? null, pwHash, now),
    c.env.DB.prepare(
      `INSERT INTO workspace_user (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
    ).bind(workspaceId, userId, now),
  ]);

  await audit(c.env, {
    workspaceId,
    actorType: 'user',
    actorId: userId,
    action: 'workspace.created',
    payload: { name: body.workspace_name },
  });

  await markSetupComplete(c.env);

  const sessionId = await createSession(c.env, userId, workspaceId);
  await setSessionCookie(c, sessionId);

  return c.json({ ok: true, workspaceId, userId });
});

setupApp.post('/mailbox', async (c) => {
  const session = await getSession(c);
  if (!session?.workspaceId) return apiError(c, 'unauthorized', 'Sign in required.');

  const body = z
    .object({
      address: z.string().email(),
      display_name: z.string().max(100).optional(),
    })
    .parse(await c.req.json());

  const mailboxId = ids.mailbox();
  const signingSecret = randomToken(32);
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO mailbox (id, workspace_id, address, display_name, reply_signing_secret, auto_reply_policy, created_at)
     VALUES (?, ?, ?, ?, ?, 'safe', ?)`,
  )
    .bind(mailboxId, session.workspaceId, body.address.toLowerCase(), body.display_name ?? null, signingSecret, now)
    .run();

  await audit(c.env, {
    workspaceId: session.workspaceId,
    actorType: 'user',
    actorId: session.userId,
    action: 'mailbox.created',
    payload: { mailboxId, address: body.address },
  });

  return c.json({ ok: true, mailboxId, address: body.address });
});

/**
 * Optional auto-onboarding for Cloudflare Email Sending + Routing.
 * Caller provides a user-scoped CF API token (never persisted) and the
 * target domain; we onboard sending, add DKIM/SPF/DMARC records (if the
 * zone is on CF), enable Email Routing, and create a forwarding rule.
 */
setupApp.post('/provision', async (c) => {
  const body = z
    .object({
      api_token: z.string().min(20),
      account_id: z.string().min(8),
      domain: z.string().min(3),
      mailbox_address: z.string().email(),
      worker_name: z.string().min(1).max(63),
    })
    .parse(await c.req.json());

  const steps = await applyProvisioning({
    apiToken: body.api_token,
    accountId: body.account_id,
    domain: body.domain,
    mailboxAddress: body.mailbox_address,
    workerName: body.worker_name,
  });
  const anyFail = steps.some((s) => s.status === 'fail');
  return c.json({ ok: !anyFail, steps });
});

setupApp.post('/verify', async (c) => {
  const session = await getSession(c);
  if (!session?.workspaceId) return apiError(c, 'unauthorized', 'Sign in required.');

  const checks: Record<string, { ok: boolean; message?: string }> = {};

  try {
    await c.env.DB.prepare('SELECT 1').first();
    checks.d1 = { ok: true };
  } catch (e) {
    checks.d1 = { ok: false, message: String(e) };
  }

  try {
    const testKey = `healthcheck/${crypto.randomUUID()}`;
    await c.env.BLOB.put(testKey, 'ok', { httpMetadata: { contentType: 'text/plain' } });
    await c.env.BLOB.delete(testKey);
    checks.r2 = { ok: true };
  } catch (e) {
    checks.r2 = { ok: false, message: String(e) };
  }

  try {
    await c.env.CACHE.put('healthcheck', 'ok', { expirationTtl: 60 });
    checks.kv = { ok: true };
  } catch (e) {
    checks.kv = { ok: false, message: String(e) };
  }

  try {
    if (c.env.AI) {
      await (c.env.AI as any).run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: 'ping' },
          { role: 'user', content: 'reply with just the word: pong' },
        ],
        max_tokens: 8,
      });
      checks.ai = { ok: true };
    } else {
      checks.ai = { ok: false, message: 'AI binding missing' };
    }
  } catch (e) {
    checks.ai = { ok: false, message: String(e) };
  }

  const mailboxes = await c.env.DB.prepare(
    `SELECT id, address FROM mailbox WHERE workspace_id = ? LIMIT 1`,
  )
    .bind(session.workspaceId)
    .first<{ id: string; address: string }>();
  checks.mailbox = mailboxes
    ? { ok: true }
    : { ok: false, message: 'No mailbox configured — add one before going live' };

  return c.json({ checks, allOk: Object.values(checks).every((c) => c.ok) });
});
