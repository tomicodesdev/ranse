# Security

## Auth model

- Password auth with PBKDF2-HMAC-SHA256 (600k iterations, 16-byte salt, 32-byte hash; Web Crypto). Hashes are stored in a versioned `pbkdf2$iters$salt$hash` format so the cost factor can be raised in-place — users are auto-rehashed on next login via `needsRehash()`.
- Session cookie is `ranse_session=<sessionId>.<hmac>`, `HttpOnly`, `Secure` in prod, `SameSite=Lax`.
- Session rows live in D1 with 30-day expiry and are revocable (`DELETE FROM session WHERE id = ?`).
- `/setup/bootstrap` requires a single-use `ADMIN_BOOTSTRAP_TOKEN` Worker secret, which is invalidated the moment setup completes.

## Role model

| Role | Capabilities |
|---|---|
| `owner` | Full access, including billing (Phase 4), destructive admin |
| `admin` | Manage mailboxes, users, LLM settings |
| `agent` | Read tickets, add notes, approve replies, resolve |
| `viewer` | Read-only |

Enforcement lives in `requireUser` + role checks on sensitive routes (currently all API routes require an authenticated session; fine-grained role gates arrive in Phase 2).

## Reply security

Ranse does **not** use `In-Reply-To` alone to route replies (that would let anyone impersonate threads by copying a header). Instead every agent-initiated thread uses a **signed reply address**:

```
reply+<ticketId>.<sig8>@support.acme.com
```

where `sig8 = first 8 hex chars of HMAC-SHA-256(mailbox.reply_signing_secret, ticketId)`. An inbound email's recipient address is parsed and verified before the message is accepted into a ticket.

## Auto-reply handling

We detect any of:
- `Auto-Submitted: ` != `no`
- `Precedence: bulk | list | junk | auto_reply`
- `X-Autoreply`, `X-Autorespond`, `X-Auto-Response-Suppress`

Detected auto-replies:
- Create a ticket (so you have a record) but are flagged `isAutoReply`.
- **Do not trigger** `triageAndDraft`.
- Are counted per-mailbox; two consecutive autos break the loop (no outbound is generated).

## Approval gates

Default policy: AI may classify, summarize, search, and draft. It **cannot** send an outbound customer email without an approved `approval_request` row. An operator's approval is recorded with `decided_by_user_id` + `decided_at`; full proposed payload + risk reasons are preserved.

## Audit trail

Every state change writes an `audit_event`:

- `ticket.created`, `ticket.message_received`, `ticket.triaged`, `ticket.{status}`
- `ticket.assigned`, `ticket.unassigned`, `ticket.internal_note`
- `approval.created`, `approval.rejected`, `reply.sent`
- `workspace.created`, `mailbox.created`

Events are immutable (append-only). D1 TTL is currently unbounded; configure a retention policy in `wrangler.jsonc` (Phase 3).

## BYOK (per-workspace API keys)

Provider API keys added via **Settings → LLM providers** are stored in a per-workspace `UserSecretsStore` Durable Object, AES-GCM-encrypted with a key derived from `COOKIE_SIGNING_KEY` + the workspace ID. The plaintext is never written to D1 or logs.

> **v1 caveat:** server derives the key material, so a Worker operator with access to `COOKIE_SIGNING_KEY` could decrypt stored keys. For stronger isolation, Phase 3 moves to **client-side encryption** (mirrors vibesdk's `UserSecretsStore` design) where the worker never sees plaintext keys except in-flight during a single request.

## Reporting vulnerabilities

Email `security@getranse.com` with a reproduction and any proof-of-concept. We aim to acknowledge within 2 business days. Please do not file public issues for security-sensitive reports.
