import type { ChannelHandler } from './types';
import type { NotificationEvent } from '../events';
import type { Env } from '../../env';

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}

function render(event: NotificationEvent): RenderedMessage {
  switch (event.name) {
    case 'ticket.created': {
      const p = event.payload;
      const from = p.requesterName ? `${p.requesterName} <${p.requesterEmail}>` : p.requesterEmail;
      return {
        subject: `[New ticket] ${p.subject}`,
        text: `New ticket from ${from}\n\n${p.subject}\n\n${p.preview}\n\n— Ranse`,
        html: `<p><strong>New ticket</strong> from ${escape(from)}</p>` +
              `<p style="font-size:16px;font-weight:600">${escape(p.subject)}</p>` +
              `<p style="color:#555">${escape(p.preview)}</p>` +
              `<p style="color:#888;font-size:12px">Sent by Ranse</p>`,
      };
    }
    case 'message.inbound': {
      const p = event.payload;
      const from = p.fromName ? `${p.fromName} <${p.fromAddress}>` : p.fromAddress;
      const tag = p.isReplyToExisting ? 'Reply' : 'New ticket';
      return {
        subject: `[${tag}] ${p.subject}`,
        text: `${tag} from ${from}\n\n${p.subject}\n\n${p.preview}\n\n— Ranse`,
        html: `<p><strong>${tag}</strong> from ${escape(from)}</p>` +
              `<p style="font-size:16px;font-weight:600">${escape(p.subject)}</p>` +
              `<p style="color:#555">${escape(p.preview)}</p>` +
              `<p style="color:#888;font-size:12px">Sent by Ranse</p>`,
      };
    }
  }
}

// Look up a workspace mailbox so we can send from a domain that we
// actually own (DKIM-signed by Email Sending on mail.<apex>). Without a
// mailbox, we can't deliver — the workspace hasn't finished onboarding.
async function getSendingDomain(env: Env, workspaceId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT address FROM mailbox WHERE workspace_id = ? LIMIT 1`,
  )
    .bind(workspaceId)
    .first<{ address: string }>();
  if (!row?.address) return null;
  return row.address.split('@')[1] ?? null;
}

function buildRawMime(from: string, to: string, msg: RenderedMessage, messageId: string): string {
  const boundary = `=_ranse_notif_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const date = new Date().toUTCString();
  return [
    `Date: ${date}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${msg.subject.replace(/[\r\n]+/g, ' ')}`,
    `Message-ID: <${messageId}>`,
    // Keeps mail clients from auto-replying and prevents loops if the
    // notification ever lands back in our own inbox.
    'Auto-Submitted: auto-generated',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    msg.text.replace(/\r?\n/g, '\r\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    msg.html,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export const emailChannel: ChannelHandler = {
  kind: 'email',
  label: 'Email',
  description: 'Forward notifications to an email address.',
  targetLabel: 'Email address',
  targetPlaceholder: 'you@example.com',

  validateTarget(target) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return 'Enter a valid email address.';
    return null;
  },

  async deliver(env, target, event) {
    const apex = await getSendingDomain(env, event.workspaceId);
    if (!apex) throw new Error('no_mailbox_configured');
    const from = `Ranse Notifications <notifications@mail.${apex}>`;
    const messageId = `notif-${event.name.replace('.', '-')}-${event.emittedAt}@mail.${apex}`;
    const rendered = render(event);
    const raw = buildRawMime(from, target, rendered, messageId);
    const { EmailMessage } = await import('cloudflare:email');
    await env.EMAIL.send(new EmailMessage(`notifications@mail.${apex}`, target, raw));
  },
};
