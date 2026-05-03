import { Hono } from 'hono';
import { z } from 'zod';
import { getAgentByName } from 'agents';
import type { Env } from '../env';
import { getSession } from '../lib/auth';
import { apiError } from '../lib/errors';
import { r2Keys, putRaw } from '../lib/storage';

interface AuthedSession {
  sessionId: string;
  userId: string;
  workspaceId: string;
}

type Ctx = { Bindings: Env; Variables: { session: AuthedSession } };

export const apiApp = new Hono<Ctx>();

function getSupervisor(env: Env, workspaceId: string) {
  // Cast to the SDK's expected `Agent<Cloudflare.Env>` shape — our custom
  // Env doesn't extend Cloudflare.Env, so the generic match fails. The
  // namespace itself is the right one; only the type parameter differs.
  return getAgentByName(env.WorkspaceSupervisorAgent as never, workspaceId);
}

apiApp.use('*', async (c, next) => {
  const s = await getSession(c);
  if (!s?.workspaceId) return apiError(c, 'unauthorized', 'Sign in required.');
  c.set('session', { sessionId: s.sessionId, userId: s.userId, workspaceId: s.workspaceId });
  await next();
});

apiApp.get('/tickets', async (c) => {
  const s = c.get('session');
  const status = c.req.query('status');
  const stub = await getSupervisor(c.env, s.workspaceId);
  const tickets = await (stub as any).listTickets({ status, limit: 50 });
  return c.json({ tickets });
});

apiApp.get('/tickets/:id', async (c) => {
  const s = c.get('session');
  const stub = await getSupervisor(c.env, s.workspaceId);
  const data = await (stub as any).getTicket(c.req.param('id'));
  if (!data) return apiError(c, 'not_found', 'That ticket doesn\'t exist or is not in your workspace.');
  return c.json(data);
});

apiApp.post('/tickets/:id/assign', async (c) => {
  const s = c.get('session');
  const body = z.object({ userId: z.string().nullable() }).parse(await c.req.json());
  const stub = await getSupervisor(c.env, s.workspaceId);
  await (stub as any).assignTicket({ ticketId: c.req.param('id'), userId: body.userId, actorUserId: s.userId });
  return c.json({ ok: true });
});

apiApp.post('/tickets/:id/status', async (c) => {
  const s = c.get('session');
  const body = z
    .object({ status: z.enum(['open', 'pending', 'resolved', 'closed', 'spam']) })
    .parse(await c.req.json());
  const stub = await getSupervisor(c.env, s.workspaceId);
  await (stub as any).setTicketStatus({ ticketId: c.req.param('id'), status: body.status, actorUserId: s.userId });
  return c.json({ ok: true });
});

apiApp.post('/tickets/:id/note', async (c) => {
  const s = c.get('session');
  const body = z.object({ body: z.string().min(1).max(20000) }).parse(await c.req.json());
  const stub = await getSupervisor(c.env, s.workspaceId);
  await (stub as any).addInternalNote({ ticketId: c.req.param('id'), body: body.body, actorUserId: s.userId });
  return c.json({ ok: true });
});

apiApp.post('/tickets/:id/reply', async (c) => {
  const s = c.get('session');
  const body = z
    .object({ body: z.string().min(1).max(50000), subject: z.string().max(998).optional() })
    .parse(await c.req.json());
  const stub = await getSupervisor(c.env, s.workspaceId);
  const result = await (stub as any).replyDirect({
    ticketId: c.req.param('id'),
    actorUserId: s.userId,
    body: body.body,
    subject: body.subject,
  });
  return c.json(result);
});

apiApp.post('/tickets/:id/draft', async (c) => {
  const s = c.get('session');
  const stub = await getSupervisor(c.env, s.workspaceId);
  const result = await (stub as any).draftReply({ ticketId: c.req.param('id'), actorUserId: s.userId });
  return c.json(result);
});

apiApp.post('/tickets/:id/ai-drafts', async (c) => {
  const s = c.get('session');
  const body = z.object({ enabled: z.boolean().nullable() }).parse(await c.req.json());
  const stub = await getSupervisor(c.env, s.workspaceId);
  await (stub as any).setTicketAiDrafts({
    ticketId: c.req.param('id'),
    actorUserId: s.userId,
    enabled: body.enabled,
  });
  return c.json({ ok: true });
});

apiApp.get('/settings/workspace', async (c) => {
  const s = c.get('session');
  const stub = await getSupervisor(c.env, s.workspaceId);
  const settings = await (stub as any).getWorkspaceSettings();
  return c.json(settings);
});

apiApp.post('/settings/workspace', async (c) => {
  const s = c.get('session');
  const body = z
    .object({
      ai_drafts_enabled: z.boolean().optional(),
      from_name: z.string().max(100).optional(),
      logo_url: z.union([z.string().url().max(500), z.literal('')]).optional(),
    })
    .parse(await c.req.json());
  const stub = await getSupervisor(c.env, s.workspaceId);
  await (stub as any).setWorkspaceSettings({ actorUserId: s.userId, ...body });
  return c.json({ ok: true });
});

// Image uploads land in R2 under `assets/...`, are served back unauthenticated
// from /assets/* (so recipient mail clients can fetch them out of email HTML),
// and the resulting absolute URL is persisted to settings_json / user.avatar_url
// via the same agent methods the URL-input fields use. Limits:
// - 2MB logo / 1MB avatar (mail clients don't load >2MB images well anyway)
// - PNG/JPEG/WebP/GIF only (no SVG — embedded scripts)
const ALLOWED_IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;

async function readUploadedImage(c: any, maxBytes: number): Promise<{ bytes: ArrayBuffer; ext: string; contentType: string } | Response> {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return apiError(c, 'no_file', 'Attach an image file under the "file" field.');
  if (file.size > maxBytes) {
    return apiError(c, 'too_large', `Image must be under ${Math.round(maxBytes / 1024 / 1024)}MB.`);
  }
  const contentType = file.type || 'application/octet-stream';
  if (!ALLOWED_IMAGE_TYPES.test(contentType)) {
    return apiError(c, 'invalid_type', 'Use PNG, JPEG, WebP, or GIF.');
  }
  const ext = contentType.split('/')[1];
  const bytes = await file.arrayBuffer();
  return { bytes, ext, contentType };
}

apiApp.post('/uploads/workspace-logo', async (c) => {
  const s = c.get('session');
  const result = await readUploadedImage(c, 2 * 1024 * 1024);
  if (result instanceof Response) return result;
  const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${result.ext}`;
  const key = r2Keys.workspaceAsset(s.workspaceId, 'logo', filename);
  await putRaw(c.env, key, result.bytes, result.contentType);
  const url = `${new URL(c.req.url).origin}/${key}`;
  const stub = await getSupervisor(c.env, s.workspaceId);
  await (stub as any).setWorkspaceSettings({ actorUserId: s.userId, logo_url: url });
  return c.json({ ok: true, url });
});

apiApp.post('/uploads/avatar', async (c) => {
  const s = c.get('session');
  const result = await readUploadedImage(c, 1 * 1024 * 1024);
  if (result instanceof Response) return result;
  const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${result.ext}`;
  const key = r2Keys.userAsset(s.workspaceId, s.userId, 'avatar', filename);
  await putRaw(c.env, key, result.bytes, result.contentType);
  const url = `${new URL(c.req.url).origin}/${key}`;
  const stub = await getSupervisor(c.env, s.workspaceId);
  await (stub as any).setAgentProfile({ userId: s.userId, avatar_url: url });
  return c.json({ ok: true, url });
});

apiApp.get('/me/profile', async (c) => {
  const s = c.get('session');
  const stub = await getSupervisor(c.env, s.workspaceId);
  const profile = await (stub as any).getAgentProfile({ userId: s.userId });
  return c.json(profile ?? {});
});

apiApp.post('/me/profile', async (c) => {
  const s = c.get('session');
  const body = z
    .object({
      name: z.string().max(100).optional(),
      signature_markdown: z.string().max(5000).optional(),
      avatar_url: z.union([z.string().url().max(500), z.literal('')]).optional(),
    })
    .parse(await c.req.json());
  const stub = await getSupervisor(c.env, s.workspaceId);
  await (stub as any).setAgentProfile({ userId: s.userId, ...body });
  return c.json({ ok: true });
});

apiApp.get('/approvals', async (c) => {
  const s = c.get('session');
  const stub = await getSupervisor(c.env, s.workspaceId);
  const approvals = await (stub as any).listApprovals();
  return c.json({ approvals });
});

apiApp.post('/approvals/:id/approve', async (c) => {
  const s = c.get('session');
  const body = z
    .object({ edits: z.object({ subject: z.string().optional(), body_markdown: z.string().optional() }).optional() })
    .parse(await c.req.json().catch(() => ({})));
  const stub = await getSupervisor(c.env, s.workspaceId);
  const result = await (stub as any).approveAndSend({ approvalId: c.req.param('id'), actorUserId: s.userId, edits: body.edits });
  return c.json(result);
});

apiApp.post('/approvals/:id/reject', async (c) => {
  const s = c.get('session');
  const body = z.object({ reason: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
  const stub = await getSupervisor(c.env, s.workspaceId);
  await (stub as any).rejectApproval({ approvalId: c.req.param('id'), actorUserId: s.userId, reason: body.reason });
  return c.json({ ok: true });
});

apiApp.get('/knowledge', async (c) => {
  const s = c.get('session');
  const rows = await c.env.DB.prepare(
    `SELECT id, title, url, updated_at FROM knowledge_doc WHERE workspace_id = ? ORDER BY updated_at DESC`,
  )
    .bind(s.workspaceId)
    .all();
  return c.json({ docs: rows.results ?? [] });
});

apiApp.post('/knowledge', async (c) => {
  const s = c.get('session');
  const body = z
    .object({ title: z.string().min(1), body: z.string().min(1), url: z.string().url().optional() })
    .parse(await c.req.json());
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO knowledge_doc (id, workspace_id, title, body, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, s.workspaceId, body.title, body.body, body.url ?? null, now, now)
    .run();
  return c.json({ ok: true, id });
});

apiApp.get('/settings/llm', async (c) => {
  const s = c.get('session');
  const rows = await c.env.DB.prepare(
    `SELECT action_key, model_name, fallback_model, temperature FROM workspace_llm_config WHERE workspace_id = ?`,
  )
    .bind(s.workspaceId)
    .all();
  return c.json({ config: rows.results ?? [] });
});

apiApp.post('/settings/llm', async (c) => {
  const s = c.get('session');
  const body = z
    .object({
      action_key: z.enum(['triage', 'summarize', 'draft', 'knowledge_query', 'escalation', 'conversational']),
      model_name: z.string().min(1),
      fallback_model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    })
    .parse(await c.req.json());
  await c.env.DB.prepare(
    `INSERT INTO workspace_llm_config (workspace_id, action_key, model_name, fallback_model, reasoning_effort, temperature, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, action_key) DO UPDATE SET model_name=excluded.model_name, fallback_model=excluded.fallback_model, reasoning_effort=excluded.reasoning_effort, temperature=excluded.temperature, updated_at=excluded.updated_at`,
  )
    .bind(
      s.workspaceId,
      body.action_key,
      body.model_name,
      body.fallback_model ?? null,
      body.reasoning_effort ?? null,
      body.temperature ?? null,
      Date.now(),
    )
    .run();
  return c.json({ ok: true });
});

apiApp.get('/settings/providers', async (c) => {
  const s = c.get('session');
  const stub = await getAgentByName(c.env.UserSecretsStore as never, s.workspaceId);
  const providers = await (stub as any).listProviders();
  return c.json({ providers });
});

apiApp.post('/settings/providers', async (c) => {
  const s = c.get('session');
  const body = z.object({ provider: z.string(), api_key: z.string().min(1) }).parse(await c.req.json());
  const stub = await getAgentByName(c.env.UserSecretsStore as never, s.workspaceId);
  await (stub as any).setKey({ provider: body.provider, apiKey: body.api_key });
  return c.json({ ok: true });
});

apiApp.delete('/settings/providers/:provider', async (c) => {
  const s = c.get('session');
  const stub = await getAgentByName(c.env.UserSecretsStore as never, s.workspaceId);
  await (stub as any).deleteKey(c.req.param('provider'));
  return c.json({ ok: true });
});
