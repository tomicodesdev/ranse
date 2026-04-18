import { describe, it, expect } from 'vitest';
import {
  buildReplyAddress,
  parseReplyAddress,
  shouldSuppressAutoReply,
} from '../src/email/reply-security';

const SECRET = 'mailbox-signing-secret-deadbeef';

describe('signed reply addresses', () => {
  it('round-trips a ticket id', async () => {
    const addr = await buildReplyAddress({
      supportDomain: 'support.acme.com',
      ticketId: 'tkt_abcd1234',
      mailboxSecret: SECRET,
    });
    expect(addr.startsWith('reply+tkt_abcd1234.')).toBe(true);
    expect(addr.endsWith('@support.acme.com')).toBe(true);

    const parsed = await parseReplyAddress(addr, SECRET);
    expect(parsed?.ticketId).toBe('tkt_abcd1234');
  });

  it('rejects a tampered signature', async () => {
    const addr = await buildReplyAddress({
      supportDomain: 'support.acme.com',
      ticketId: 'tkt_abcd1234',
      mailboxSecret: SECRET,
    });
    const tampered = addr.replace(/\.([a-f0-9]{8})@/, '.deadbeef@');
    const parsed = await parseReplyAddress(tampered, SECRET);
    expect(parsed).toBeNull();
  });

  it('rejects a different mailbox secret', async () => {
    const addr = await buildReplyAddress({
      supportDomain: 'support.acme.com',
      ticketId: 'tkt_abcd1234',
      mailboxSecret: SECRET,
    });
    const parsed = await parseReplyAddress(addr, 'different-secret');
    expect(parsed).toBeNull();
  });

  it('rejects malformed addresses', async () => {
    expect(await parseReplyAddress('support@acme.com', SECRET)).toBeNull();
    expect(await parseReplyAddress('reply+abc@acme.com', SECRET)).toBeNull();
    expect(await parseReplyAddress('reply+abc.xyz@acme.com', SECRET)).toBeNull();
  });
});

describe('auto-reply suppression', () => {
  it('suppresses when the inbound is flagged as auto-reply', () => {
    expect(shouldSuppressAutoReply(true, 0)).toBe(true);
  });

  it('suppresses after the loop threshold is crossed', () => {
    expect(shouldSuppressAutoReply(false, 2)).toBe(true);
    expect(shouldSuppressAutoReply(false, 5)).toBe(true);
  });

  it('allows replies on normal inbound with clean history', () => {
    expect(shouldSuppressAutoReply(false, 0)).toBe(false);
    expect(shouldSuppressAutoReply(false, 1)).toBe(false);
  });
});
