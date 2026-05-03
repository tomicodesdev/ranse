import { z } from 'zod';

// Typed event catalogue. Adding a new event = one new entry; the rest of
// the system (channels, dispatch, UI) reads from here and stays in sync.
// Naming convention: `<resource>.<verb>` (CloudEvents-ish, also matches
// what GitHub/Stripe/Linear use). Keep payloads small and stable —
// channels JSON-serialize them and external systems may parse them.

export const ticketCreatedPayload = z.object({
  ticketId: z.string(),
  subject: z.string(),
  requesterEmail: z.string(),
  requesterName: z.string().nullable(),
  preview: z.string(),
  mailboxAddress: z.string(),
  receivedAt: z.number(),
});

export const messageInboundPayload = z.object({
  ticketId: z.string(),
  messageId: z.string(),
  subject: z.string(),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  preview: z.string(),
  isReplyToExisting: z.boolean(),
  receivedAt: z.number(),
});

export const EVENTS = {
  'ticket.created': {
    schema: ticketCreatedPayload,
    desc: 'A new ticket is created from inbound email (first contact from a sender).',
  },
  'message.inbound': {
    schema: messageInboundPayload,
    desc: 'A message arrives on any ticket — new ticket or reply on an existing one.',
  },
} as const;

export type EventName = keyof typeof EVENTS;
export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

export type EventPayload<E extends EventName> = z.infer<(typeof EVENTS)[E]['schema']>;

// Discriminated union — used throughout the dispatch + delivery path so
// channel handlers can switch on `event.name` and TypeScript narrows the
// payload automatically. No casts needed at the boundary.
export type NotificationEvent = {
  [E in EventName]: { name: E; payload: EventPayload<E>; workspaceId: string; emittedAt: number };
}[EventName];

export function isKnownEvent(name: string): name is EventName {
  return name in EVENTS;
}
