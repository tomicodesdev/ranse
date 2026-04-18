# Operations

## Ticket lifecycle

| Status | Meaning |
|---|---|
| `open` | New or awaiting first agent action |
| `pending` | Waiting on customer |
| `resolved` | Agent believes the issue is handled; customer can still reopen by replying |
| `closed` | Archived — no further activity expected |
| `spam` | Marked by triage or human |

Any inbound reply to a `resolved` or `closed` ticket reopens it automatically (by thread-token match).

## Approvals

Every outbound reply from the AI is gated. The flow:

1. `DraftAgent` produces `{ subject, body_markdown, cites_knowledge_ids, confidence, needs_human_review_reasons }`.
2. The supervisor creates an `approval_request` row with risk reasons based on confidence, sentiment, priority, and explicit review flags.
3. Operators see pending approvals in **Approvals** sidebar and inline on each ticket.
4. Approve (optionally with edits) → `env.EMAIL.send` → `message_index` row → audit event.
5. Reject → request stays in audit trail, no email sent.

## Escalations

The `EscalationAgent` runs on demand. It returns `{ should_escalate, severity, route_to }` and the operator (or an automation rule) picks the handoff target.

An **SLA sweep** runs every 5 minutes via a Cron Trigger (`*/5 * * * *`). It walks every workspace, computes first-response / resolution breaches against `DEFAULT_SLA`, and writes a dedup'd `ticket.sla_breached.{first_response|resolution}` audit event the first time each threshold is crossed. Surface these in your own dashboard by querying `audit_event WHERE action LIKE 'ticket.sla_breached.%'`.

## Rotating secrets

```bash
# Replace a provider API key
wrangler secret put OPENAI_API_KEY

# Replace the cookie signing key (will invalidate all sessions)
wrangler secret put COOKIE_SIGNING_KEY

# BYOK keys live in the UserSecretsStore DO, not Worker secrets.
# Users can rotate their own in Settings → LLM providers.
```

## Incident playbook

**"The AI is replying with garbage."** — Open **Settings → Model per agent action** and switch `draft` to a stronger model (e.g. `anthropic/claude-sonnet-4-6`). Or disable auto-draft by setting the draft action's policy to "manual only" (Phase 2).

**"Auto-reply loop."** — Ranse detects `Auto-Submitted`, `Precedence`, `X-Autoreply` headers and suppresses responses. If a loop still happens, temporarily pause the mailbox:
```sql
UPDATE mailbox SET auto_reply_policy = 'strict' WHERE address = 'support@acme.com';
```

**"Provider is down."** — Each agent action has a `fallback_model`. The dispatcher retries 3× with exponential backoff, then fails over. Set a fallback in **Settings → Model per agent action**.

## Upgrades

```bash
git pull origin main
bun install
bun run db:migrate:remote
bun run deploy
```

Migrations are forward-only. Rollback by re-deploying the prior Git tag (D1 doesn't support down-migrations; schema changes should be additive).

## Observability

Cloudflare's `observability.enabled: true` is on by default — head to **Workers → ranse → Observability** for logs. Queue retries and DO alarms show up there too.

For custom metrics, the audit trail (`audit_event` in D1) is the source of truth. Every state change the UI performs writes an audit row.
