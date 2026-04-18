import { describe, it, expect } from 'vitest';
import { computeSLA, DEFAULT_SLA } from '../src/agents/specialists/sla';

const HOUR = 3_600_000;

describe('computeSLA', () => {
  it('flags no breach when within first_response window', () => {
    const s = computeSLA({
      policy: DEFAULT_SLA,
      priority: 'normal',
      firstMessageAt: Date.now() - 30 * 60_000, // 30 minutes ago
      now: Date.now(),
    });
    expect(s.first_response_breached).toBe(false);
    expect(s.resolution_breached).toBe(false);
  });

  it('flags first_response breach at urgent priority', () => {
    const s = computeSLA({
      policy: DEFAULT_SLA,
      priority: 'urgent',
      firstMessageAt: Date.now() - 30 * 60_000, // 30 minutes — urgent window is 15
      now: Date.now(),
    });
    expect(s.first_response_breached).toBe(true);
  });

  it('clears first_response breach once an agent responds', () => {
    const fm = Date.now() - 60 * 60_000;
    const s = computeSLA({
      policy: DEFAULT_SLA,
      priority: 'urgent',
      firstMessageAt: fm,
      firstResponseAt: fm + 5 * 60_000,
      now: Date.now(),
    });
    expect(s.first_response_breached).toBe(false);
  });

  it('flags resolution breach on stale normal ticket', () => {
    const s = computeSLA({
      policy: DEFAULT_SLA,
      priority: 'normal',
      firstMessageAt: Date.now() - 72 * HOUR, // 72h > 48h normal window
      now: Date.now(),
    });
    expect(s.resolution_breached).toBe(true);
  });
});
