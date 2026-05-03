import type { ChannelHandler } from './types';
import type { NotificationEvent } from '../events';

// Slack incoming webhooks accept Block Kit JSON. We send a short header
// (event name + sender) and a section with the subject + preview. Slack
// truncates section text at ~3000 chars; preview is already 280 max.
function buildPayload(event: NotificationEvent) {
  switch (event.name) {
    case 'ticket.created': {
      const p = event.payload;
      const from = p.requesterName ? `${p.requesterName} <${p.requesterEmail}>` : p.requesterEmail;
      return {
        text: `New ticket from ${from}: ${p.subject}`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '🆕 New ticket' } },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*From*\n${from}` },
              { type: 'mrkdwn', text: `*Mailbox*\n${p.mailboxAddress}` },
            ],
          },
          { type: 'section', text: { type: 'mrkdwn', text: `*${p.subject}*\n${p.preview}` } },
        ],
      };
    }
    case 'message.inbound': {
      const p = event.payload;
      const from = p.fromName ? `${p.fromName} <${p.fromAddress}>` : p.fromAddress;
      const heading = p.isReplyToExisting ? '💬 New reply' : '🆕 New ticket';
      return {
        text: `${heading} from ${from}: ${p.subject}`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: heading } },
          { type: 'section', text: { type: 'mrkdwn', text: `*From:* ${from}` } },
          { type: 'section', text: { type: 'mrkdwn', text: `*${p.subject}*\n${p.preview}` } },
        ],
      };
    }
  }
}

export const slackChannel: ChannelHandler = {
  kind: 'slack',
  label: 'Slack',
  description: 'Post notifications to a Slack channel via an incoming webhook.',
  targetLabel: 'Slack incoming webhook URL',
  targetPlaceholder: 'https://hooks.slack.com/services/T000/B000/XXXX',

  validateTarget(target) {
    try {
      const url = new URL(target);
      if (url.protocol !== 'https:') return 'Slack webhook URL must use HTTPS.';
      if (!/^hooks\.slack\.com$/i.test(url.hostname)) {
        return 'Expected a hooks.slack.com URL.';
      }
      return null;
    } catch {
      return 'Enter a valid URL.';
    }
  },

  async deliver(_env, target, event) {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPayload(event)),
    });
    if (!res.ok) {
      // Slack returns plain-text error bodies like "invalid_payload".
      const body = await res.text().catch(() => '');
      throw new Error(`slack ${res.status}: ${body.slice(0, 200)}`);
    }
  },
};
