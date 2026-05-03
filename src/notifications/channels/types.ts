import type { Env } from '../../env';
import type { NotificationEvent } from '../events';

// All channel handlers implement this. Adding a new channel kind = drop
// a new file + register it in ./index.ts. The dispatcher and queue
// consumer don't know anything about kinds beyond the registry.
export interface ChannelHandler {
  kind: string;

  // UI metadata — Settings reads these directly so adding a channel kind
  // doesn't require UI changes.
  label: string;
  description: string;
  targetLabel: string;
  targetPlaceholder: string;

  validateTarget(target: string): string | null;

  // Throw on permanent failure (the queue retries automatically; throw
  // only when retry won't help — e.g. 4xx). Resolve on success.
  deliver(env: Env, target: string, event: NotificationEvent): Promise<void>;
}
