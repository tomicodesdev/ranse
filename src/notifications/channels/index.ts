import type { ChannelHandler } from './types';
import { emailChannel } from './email';
import { slackChannel } from './slack';

// Single source of truth for channel kinds. Drop a new handler here and
// API/UI/dispatch all see it without further changes.
const handlers: ChannelHandler[] = [emailChannel, slackChannel];

const byKind = new Map(handlers.map((h) => [h.kind, h]));

export const CHANNEL_KINDS = handlers.map((h) => h.kind);

export function getHandler(kind: string): ChannelHandler | undefined {
  return byKind.get(kind);
}

export function listHandlers(): ChannelHandler[] {
  return handlers;
}

export type { ChannelHandler };
