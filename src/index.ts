import { Hono } from 'hono';
import { routeAgentRequest } from 'agents';
import type {
  ExecutionContext,
  ForwardableEmailMessage,
  MessageBatch,
  ScheduledController,
} from '@cloudflare/workers-types';
import type { Env } from './env';
import { runSLASweep } from './jobs/sla-sweep';
import { parseInbound } from './email/parsing';
import { resolveMailboxForRecipients } from './email/routing';
import { r2Keys, putRaw } from './lib/storage';
import { ids } from './lib/ids';
import { setupApp } from './setup/wizard';
import { authApp } from './auth/routes';
import { apiApp } from './api/routes';
import type { InboundEmailPayload } from './agents/WorkspaceSupervisorAgent';

export { WorkspaceSupervisorAgent } from './agents/WorkspaceSupervisorAgent';
export { MailboxAgent } from './agents/MailboxAgent';
export { UserSecretsStore } from './agents/UserSecretsStore';

const app = new Hono<{ Bindings: Env }>();

app.get('/healthz', (c) => c.json({ ok: true, name: c.env.APP_NAME, version: c.env.CF_VERSION?.id }));

app.route('/setup', setupApp);
app.route('/auth', authApp);
app.route('/api', apiApp);

// Agents SDK handles /agents/* WebSocket + RPC. Falls through to static assets on null.
app.all('/agents/*', async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env as any);
  return res ?? c.notFound();
});

app.notFound(async (c) => {
  // SPA fallback: let the assets binding serve index.html for client-side routing.
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Not found', 404);
});

export default {
  fetch: app.fetch,

  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const rlKey = `ingest:${message.from}`;
    const rl = await env.RATE_LIMIT_INGEST?.limit({ key: rlKey }).catch(() => ({ success: true }));
    if (rl && !rl.success) {
      await message.setReject('Rate limited');
      return;
    }

    const recipients = [message.to];
    const routed = await resolveMailboxForRecipients(env, recipients);
    if (!routed) {
      await message.setReject('Unknown recipient');
      return;
    }

    const parsed = await parseInbound(message);

    const rawKey = r2Keys.rawEmail(routed.workspaceId, routed.mailboxId, parsed.messageId);
    await putRaw(env, rawKey, parsed.rawBytes, 'message/rfc822');

    for (const att of parsed.attachments) {
      const attId = ids.message();
      await putRaw(
        env,
        r2Keys.attachment(routed.workspaceId, 'pending', attId, att.filename),
        att.content,
        att.mimeType,
      );
    }

    const mailboxStub = env.MailboxAgent.get(env.MailboxAgent.idFromName(routed.mailboxId));
    await (mailboxStub as any).recordInbound({ autoReply: parsed.isAutoReply });

    const payload: InboundEmailPayload = {
      mailboxId: routed.mailboxId,
      mailboxAddress: routed.mailboxAddress,
      replySigningSecret: routed.replySigningSecret,
      existingTicketId: routed.ticketId,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      text: parsed.text,
      html: parsed.html,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      isAutoReply: parsed.isAutoReply,
      rawKey,
      receivedAt: Date.now(),
      attachmentCount: parsed.attachments.length,
    };

    const supervisorStub = env.WorkspaceSupervisorAgent.get(
      env.WorkspaceSupervisorAgent.idFromName(routed.workspaceId),
    );
    await (supervisorStub as any).ingestEmail(payload);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (controller.cron) {
      case '*/5 * * * *':
        ctx.waitUntil(
          runSLASweep(env)
            .then((r) => console.log('sla-sweep', r))
            .catch((e) => console.error('sla-sweep failed', e)),
        );
        break;
      default:
        console.warn('unhandled cron', controller.cron);
    }
  },

  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body as { type: string; [k: string]: any };
        switch (body.type) {
          case 'webhook.deliver': {
            const res = await fetch(body.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-ranse-signature': body.signature },
              body: JSON.stringify(body.payload),
            });
            if (!res.ok) throw new Error(`webhook ${res.status}`);
            break;
          }
          default:
            console.warn('unknown queue message', body.type);
        }
        msg.ack();
      } catch (err) {
        console.error('queue error', err);
        msg.retry({ delaySeconds: 30 });
      }
    }
  },
};
