import { Agent, callable } from 'agents';
import type { Env } from '../env';
import { audit } from '../lib/audit';
import { createApproval } from '../lib/approvals';
import { ids } from '../lib/ids';
import { r2Keys, putRaw } from '../lib/storage';
import { buildReplyAddress } from '../email/reply-security';
import {
  buildHtmlWithSignature,
  buildMultipartReply,
  buildPlainTextWithSignature,
} from '../email/html';
import { runTriage } from './specialists/triage';
import { runDraft } from './specialists/draft';
import { searchKnowledge } from './specialists/knowledge';
import type { AgentConfig } from '../llm/config.types';
import { emitEvent } from '../notifications/dispatch';

export interface SupervisorState {
  workspaceId: string;
  workspaceName: string;
  openCount: number;
  lastSyncAt: number;
  currentApprovals: number;
  presence: Record<string, { name: string; lastSeen: number }>;
}

export interface InboundEmailPayload {
  mailboxId: string;
  mailboxAddress: string;
  replySigningSecret: string;
  existingTicketId?: string;
  from: { address: string; name?: string };
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  references: string[];
  isAutoReply: boolean;
  rawKey: string;
  receivedAt: number;
  attachmentCount: number;
}

export interface TicketListItem {
  id: string;
  subject: string;
  status: string;
  priority: string;
  requester_email: string;
  last_message_at: number;
  category?: string;
  assignee_user_id?: string;
}

const DEFAULT_STATE: SupervisorState = {
  workspaceId: '',
  workspaceName: '',
  openCount: 0,
  lastSyncAt: 0,
  currentApprovals: 0,
  presence: {},
};

export class WorkspaceSupervisorAgent extends Agent<Env, SupervisorState> {
  initialState: SupervisorState = DEFAULT_STATE;

  async onStart(): Promise<void> {
    if (!this.state.workspaceId) {
      const ws = await this.loadWorkspaceByDOName();
      if (ws) await this.setState({ ...this.state, ...ws, lastSyncAt: Date.now() });
    }
    await this.refreshCounts();
  }

  private async loadWorkspaceByDOName(): Promise<{ workspaceId: string; workspaceName: string } | null> {
    const idStr = this.name;
    if (!idStr) return null;
    const row = await this.env.DB.prepare(`SELECT id, name FROM workspace WHERE id = ?`)
      .bind(idStr)
      .first<{ id: string; name: string }>();
    return row ? { workspaceId: row.id, workspaceName: row.name } : null;
  }

  /**
   * Effective AI-drafts setting for a ticket. Per-ticket override beats
   * the workspace default; workspace defaults to off.
   */
  private async aiDraftsEnabled(ticketId: string): Promise<boolean> {
    const t = await this.env.DB.prepare(`SELECT ai_drafts_enabled FROM ticket WHERE id = ?`)
      .bind(ticketId)
      .first<{ ai_drafts_enabled: number | null }>();
    if (t?.ai_drafts_enabled === 1) return true;
    if (t?.ai_drafts_enabled === 0) return false;
    const w = await this.env.DB.prepare(`SELECT settings_json FROM workspace WHERE id = ?`)
      .bind(this.state.workspaceId)
      .first<{ settings_json: string }>();
    try {
      const s = w ? JSON.parse(w.settings_json || '{}') : {};
      return s.ai_drafts_enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * Single source of truth for sending an outbound reply on a ticket. Builds
   * raw MIME with proper Message-ID / In-Reply-To / References headers so
   * recipient mail clients thread the reply, persists the outbound row in
   * message_index (with rfc_message_id populated for future inbound match),
   * stores the body in R2, audits, and bumps the ticket.
   *
   * `actorUserId` is the human who clicked send (or null when an automated
   * AI flow sends, but currently AI never sends without a human approval).
   */
  private async sendThreadedReply(args: {
    ticketId: string;
    body: string;
    subject?: string;
    actorUserId: string | null;
    source: 'manual' | 'ai_approval';
    approvalId?: string;
    edited?: boolean;
  }): Promise<{ messageId: string }> {
    const ctx = await this.env.DB.prepare(
      `SELECT t.subject AS ticket_subject, t.requester_email, t.mailbox_id,
              m.address AS mailbox_address, m.reply_signing_secret,
              w.name AS workspace_name, w.settings_json AS workspace_settings
         FROM ticket t
         JOIN mailbox m ON m.id = t.mailbox_id
         JOIN workspace w ON w.id = t.workspace_id
        WHERE t.id = ? AND t.workspace_id = ?`,
    )
      .bind(args.ticketId, this.state.workspaceId)
      .first<{
        ticket_subject: string;
        requester_email: string;
        mailbox_id: string;
        mailbox_address: string;
        reply_signing_secret: string;
        workspace_name: string;
        workspace_settings: string;
      }>();
    if (!ctx) throw new Error('ticket_not_found');

    let workspaceSettings: { from_name?: string; logo_url?: string } = {};
    try {
      workspaceSettings = JSON.parse(ctx.workspace_settings || '{}');
    } catch {
      workspaceSettings = {};
    }

    let agent: { name: string | null; email: string; signature_markdown: string | null; avatar_url: string | null } | null = null;
    if (args.actorUserId) {
      agent = await this.env.DB.prepare(
        `SELECT name, email, signature_markdown, avatar_url FROM user WHERE id = ?`,
      )
        .bind(args.actorUserId)
        .first<{ name: string | null; email: string; signature_markdown: string | null; avatar_url: string | null }>();
    }

    const lastInbound = await this.env.DB.prepare(
      `SELECT rfc_message_id FROM message_index
        WHERE ticket_id = ? AND direction = 'inbound' AND rfc_message_id IS NOT NULL
        ORDER BY sent_at DESC LIMIT 1`,
    )
      .bind(args.ticketId)
      .first<{ rfc_message_id: string }>();

    const refRows = await this.env.DB.prepare(
      `SELECT rfc_message_id FROM message_index
        WHERE ticket_id = ? AND rfc_message_id IS NOT NULL
        ORDER BY sent_at ASC`,
    )
      .bind(args.ticketId)
      .all<{ rfc_message_id: string }>();
    const references = (refRows.results ?? []).map((r) => r.rfc_message_id);

    // Two-domain From / Reply-To split:
    //   From    = support@mail.<apex>     — DKIM-signed by Email Sending,
    //                                       which is onboarded only on the
    //                                       mail.<apex> subdomain (Sending
    //                                       and Routing can't share a zone).
    //   Reply-To = reply+<ticketId>.<sig>@<apex> — signed reply address on
    //                                       the apex zone where Email
    //                                       Routing actually receives mail.
    //                                       Customer mail clients use this
    //                                       when the user clicks Reply, so
    //                                       responses land at the Worker.
    const apexDomain = ctx.mailbox_address.split('@')[1];
    const sendingDomain = `mail.${apexDomain}`;
    const localPart = ctx.mailbox_address.split('@')[0] || 'support';
    const fromAddress = `${localPart}@${sendingDomain}`;
    const replyToAddress = await buildReplyAddress({
      supportDomain: apexDomain,
      ticketId: args.ticketId,
      mailboxSecret: ctx.reply_signing_secret,
    });

    const subject = (args.subject ?? `Re: ${ctx.ticket_subject}`).replace(/^(re:\s*)+/i, 'Re: ');
    const messageId = ids.message();
    const rfcMessageId = `${messageId}@${sendingDomain}`;

    // Display-name on From: "<Agent> · <FromName/Workspace> <addr>" — the
    // pattern Zendesk / Intercom / HelpScout use. Falls back gracefully:
    //   manual reply by user with name set: `"Sarah · Acme Support" <hello@mail.acme.com>`
    //   manual reply, no agent profile:    `"Acme Support" <hello@mail.acme.com>`
    //   AI-approved reply:                 `"Acme Support" <hello@mail.acme.com>`
    const fromName = workspaceSettings.from_name || ctx.workspace_name || 'Support';
    const displayName =
      agent?.name && agent.name.trim()
        ? `${agent.name.trim()} · ${fromName}`
        : fromName;
    const fromHeader = `"${displayName.replace(/"/g, '\\"')}" <${fromAddress}>`;

    const signatureCtx = {
      agentName: agent?.name ?? null,
      agentEmail: agent?.email ?? null,
      agentSignatureMarkdown: agent?.signature_markdown ?? null,
      agentAvatarUrl: agent?.avatar_url ?? null,
      workspaceName: ctx.workspace_name,
      workspaceLogoUrl: workspaceSettings.logo_url ?? null,
      fromName,
    };
    const textBody = buildPlainTextWithSignature(args.body, signatureCtx);
    const htmlBody = await buildHtmlWithSignature(args.body, signatureCtx);

    const rawMimeText = buildMultipartReply(
      {
        from: fromHeader,
        to: ctx.requester_email,
        subject,
        messageId: rfcMessageId,
        inReplyTo: lastInbound?.rfc_message_id,
        references,
        replyTo: replyToAddress,
      },
      textBody,
      htmlBody,
    );

    const { EmailMessage } = await import('cloudflare:email');
    await this.env.EMAIL.send(
      new EmailMessage(fromAddress, ctx.requester_email, rawMimeText),
    );

    await this.env.DB.prepare(
      `INSERT INTO message_index (id, ticket_id, workspace_id, direction, from_address, to_address, subject, rfc_message_id, in_reply_to, preview, body_r2_key, author_user_id, sent_at, created_at)
       VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        messageId,
        args.ticketId,
        this.state.workspaceId,
        fromAddress,
        ctx.requester_email,
        subject,
        rfcMessageId,
        lastInbound?.rfc_message_id ?? null,
        args.body.slice(0, 280),
        r2Keys.textBody(this.state.workspaceId, args.ticketId, messageId),
        args.actorUserId,
        Date.now(),
        Date.now(),
      )
      .run();
    await putRaw(
      this.env,
      r2Keys.textBody(this.state.workspaceId, args.ticketId, messageId),
      new TextEncoder().encode(args.body),
      'text/plain; charset=utf-8',
    );
    await this.env.DB.prepare(
      `UPDATE ticket SET status = 'pending', last_message_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), Date.now(), args.ticketId)
      .run();
    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      ticketId: args.ticketId,
      actorType: args.actorUserId ? 'user' : 'system',
      actorId: args.actorUserId ?? undefined,
      action: 'reply.sent',
      payload: {
        messageId,
        source: args.source,
        approvalId: args.approvalId,
        edited: args.edited,
      },
    });
    await this.refreshCounts();
    return { messageId };
  }

  private async workspaceConfig(): Promise<Partial<AgentConfig> | undefined> {
    if (!this.state.workspaceId) return undefined;
    const rows = await this.env.DB.prepare(
      `SELECT action_key, model_name, fallback_model, reasoning_effort, temperature
       FROM workspace_llm_config WHERE workspace_id = ?`,
    )
      .bind(this.state.workspaceId)
      .all<{ action_key: string; model_name: string; fallback_model: string | null; reasoning_effort: string | null; temperature: number | null }>();
    const out: any = {};
    for (const r of rows.results ?? []) {
      out[r.action_key] = {
        model: r.model_name,
        fallbackModel: r.fallback_model ?? undefined,
        reasoningEffort: (r.reasoning_effort as any) ?? undefined,
        temperature: r.temperature ?? undefined,
      };
    }
    return Object.keys(out).length ? out : undefined;
  }

  async ingestEmail(payload: InboundEmailPayload): Promise<{ ticketId: string; messageId: string }> {
    const now = Date.now();
    let ticketId = payload.existingTicketId;
    let isNewTicket = false;

    if (!ticketId) {
      const existing = await this.findTicketByReferences(payload.inReplyTo, payload.references, payload.from.address);
      ticketId = existing ?? undefined;
    }

    if (!ticketId) {
      ticketId = ids.ticket();
      isNewTicket = true;
      const threadToken = ids.ticket().slice(4);
      await this.env.DB.prepare(
        `INSERT INTO ticket (id, workspace_id, mailbox_id, subject, status, priority, requester_email, requester_name, last_message_at, thread_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', 'normal', ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          ticketId,
          this.state.workspaceId,
          payload.mailboxId,
          payload.subject,
          payload.from.address.toLowerCase(),
          payload.from.name ?? null,
          payload.receivedAt,
          threadToken,
          now,
          now,
        )
        .run();
    }

    const messageId = ids.message();
    await this.env.DB.prepare(
      `INSERT INTO message_index (id, ticket_id, workspace_id, direction, from_address, to_address, subject, rfc_message_id, in_reply_to, preview, raw_r2_key, has_attachments, sent_at, created_at)
       VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        messageId,
        ticketId,
        this.state.workspaceId,
        payload.from.address,
        payload.to[0] ?? payload.mailboxAddress,
        payload.subject,
        payload.messageId,
        payload.inReplyTo ?? null,
        payload.text.slice(0, 280),
        payload.rawKey,
        payload.attachmentCount > 0 ? 1 : 0,
        payload.receivedAt,
        now,
      )
      .run();

    await this.env.DB.prepare(
      `UPDATE ticket SET last_message_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(payload.receivedAt, now, ticketId)
      .run();

    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      ticketId,
      actorType: 'system',
      action: isNewTicket ? 'ticket.created' : 'ticket.message_received',
      payload: { messageId, from: payload.from.address, subject: payload.subject, isAutoReply: payload.isAutoReply },
    });

    // Notification fan-out — auto-replies and bounces don't notify
    // (would generate a notification storm during a vacation autoreply
    // exchange). Real human inbound only.
    if (!payload.isAutoReply) {
      const preview = payload.text.slice(0, 280);
      if (isNewTicket) {
        await emitEvent(this.env, this.state.workspaceId, 'ticket.created', {
          ticketId,
          subject: payload.subject,
          requesterEmail: payload.from.address,
          requesterName: payload.from.name ?? null,
          preview,
          mailboxAddress: payload.mailboxAddress,
          receivedAt: payload.receivedAt,
        });
      }
      await emitEvent(this.env, this.state.workspaceId, 'message.inbound', {
        ticketId,
        messageId,
        subject: payload.subject,
        fromAddress: payload.from.address,
        fromName: payload.from.name ?? null,
        preview,
        isReplyToExisting: !isNewTicket,
        receivedAt: payload.receivedAt,
      });
    }

    if (!payload.isAutoReply && (await this.aiDraftsEnabled(ticketId))) {
      await this.schedule(0, 'triageAndDraft', { ticketId, messageId, payload });
    }

    await this.refreshCounts();
    return { ticketId, messageId };
  }

  async triageAndDraft(args: { ticketId: string; messageId: string; payload: InboundEmailPayload }) {
    const { ticketId, payload } = args;
    const cfg = await this.workspaceConfig();

    const triage = await runTriage({
      env: this.env,
      workspaceId: this.state.workspaceId,
      ticketId,
      subject: payload.subject,
      body: payload.text,
      from: payload.from.address,
      workspaceConfig: cfg,
    });

    await this.env.DB.prepare(
      `UPDATE ticket SET category = ?, priority = ?, sentiment = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(triage.category, triage.priority, triage.sentiment, Date.now(), ticketId)
      .run();

    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      ticketId,
      actorType: 'agent',
      actorId: 'triage',
      action: 'ticket.triaged',
      payload: triage as any,
    });

    if (triage.category === 'spam') {
      await this.env.DB.prepare(`UPDATE ticket SET status = 'spam' WHERE id = ?`).bind(ticketId).run();
      await this.refreshCounts();
      return;
    }

    const knowledge = await searchKnowledge(this.env, this.state.workspaceId, `${payload.subject}\n${payload.text}`);
    const draft = await runDraft({
      env: this.env,
      workspaceId: this.state.workspaceId,
      ticketId,
      customerMessage: payload.text,
      customerName: payload.from.name,
      knowledge,
      workspaceConfig: cfg,
    });

    const replyFrom = await buildReplyAddress({
      supportDomain: payload.mailboxAddress.split('@')[1],
      ticketId,
      mailboxSecret: payload.replySigningSecret,
    });

    const riskReasons: string[] = [];
    if (draft.confidence < 0.7) riskReasons.push('low_confidence');
    if (draft.needs_human_review_reasons.length) riskReasons.push(...draft.needs_human_review_reasons);
    if (triage.sentiment === 'hostile') riskReasons.push('hostile_sentiment');
    if (triage.priority === 'urgent') riskReasons.push('urgent_priority');

    await createApproval(this.env, {
      workspaceId: this.state.workspaceId,
      ticketId,
      kind: 'send_reply',
      proposed: {
        from: replyFrom,
        to: payload.from.address,
        subject: draft.subject,
        body_markdown: draft.body_markdown,
        cites_knowledge_ids: draft.cites_knowledge_ids,
        mailboxAddress: payload.mailboxAddress,
        mailboxId: payload.mailboxId,
      },
      riskReasons,
      expiresInMs: 24 * 60 * 60 * 1000,
    });

    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      ticketId,
      actorType: 'agent',
      actorId: 'draft',
      action: 'approval.created',
      payload: { confidence: draft.confidence, tone: draft.tone, riskReasons },
    });

    await this.refreshCounts();
  }

  @callable()
  async listTickets(params: { status?: string; limit?: number; offset?: number }): Promise<TicketListItem[]> {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const clause = params.status ? 'AND status = ?' : '';
    const bindings: any[] = [this.state.workspaceId];
    if (params.status) bindings.push(params.status);
    bindings.push(limit, offset);
    const rows = await this.env.DB.prepare(
      `SELECT id, subject, status, priority, requester_email, last_message_at, category, assignee_user_id
       FROM ticket WHERE workspace_id = ? ${clause}
       ORDER BY last_message_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings)
      .all<TicketListItem>();
    return rows.results ?? [];
  }

  @callable()
  async getTicket(ticketId: string): Promise<{ ticket: any; messages: any[]; audit: any[]; approvals: any[] } | null> {
    const ticket = await this.env.DB.prepare(
      `SELECT * FROM ticket WHERE id = ? AND workspace_id = ?`,
    )
      .bind(ticketId, this.state.workspaceId)
      .first();
    if (!ticket) return null;
    const [messages, auditRows, approvals] = await Promise.all([
      this.env.DB.prepare(
        `SELECT * FROM message_index WHERE ticket_id = ? ORDER BY sent_at ASC`,
      )
        .bind(ticketId)
        .all(),
      this.env.DB.prepare(
        `SELECT * FROM audit_event WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 100`,
      )
        .bind(ticketId)
        .all(),
      this.env.DB.prepare(
        `SELECT * FROM approval_request WHERE ticket_id = ? ORDER BY created_at DESC`,
      )
        .bind(ticketId)
        .all(),
    ]);
    return {
      ticket,
      messages: messages.results ?? [],
      audit: auditRows.results ?? [],
      approvals: approvals.results ?? [],
    };
  }

  @callable()
  async assignTicket(args: { ticketId: string; userId: string | null; actorUserId: string }) {
    await this.env.DB.prepare(
      `UPDATE ticket SET assignee_user_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    )
      .bind(args.userId, Date.now(), args.ticketId, this.state.workspaceId)
      .run();
    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      ticketId: args.ticketId,
      actorType: 'user',
      actorId: args.actorUserId,
      action: args.userId ? 'ticket.assigned' : 'ticket.unassigned',
      payload: { userId: args.userId },
    });
  }

  @callable()
  async setTicketStatus(args: { ticketId: string; status: 'open' | 'pending' | 'resolved' | 'closed' | 'spam'; actorUserId: string }) {
    await this.env.DB.prepare(
      `UPDATE ticket SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    )
      .bind(args.status, Date.now(), args.ticketId, this.state.workspaceId)
      .run();
    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      ticketId: args.ticketId,
      actorType: 'user',
      actorId: args.actorUserId,
      action: `ticket.${args.status}`,
    });
    await this.refreshCounts();
  }

  @callable()
  async addInternalNote(args: { ticketId: string; body: string; actorUserId: string }) {
    const messageId = ids.message();
    await this.env.DB.prepare(
      `INSERT INTO message_index (id, ticket_id, workspace_id, direction, preview, author_user_id, sent_at, created_at)
       VALUES (?, ?, ?, 'note', ?, ?, ?, ?)`,
    )
      .bind(messageId, args.ticketId, this.state.workspaceId, args.body.slice(0, 280), args.actorUserId, Date.now(), Date.now())
      .run();
    // persist full body to R2
    await putRaw(
      this.env,
      r2Keys.textBody(this.state.workspaceId, args.ticketId, messageId),
      new TextEncoder().encode(args.body),
      'text/plain; charset=utf-8',
    );
    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      ticketId: args.ticketId,
      actorType: 'user',
      actorId: args.actorUserId,
      action: 'ticket.internal_note',
    });
  }

  @callable()
  async listApprovals(): Promise<any[]> {
    const rows = await this.env.DB.prepare(
      `SELECT * FROM approval_request WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC`,
    )
      .bind(this.state.workspaceId)
      .all();
    return rows.results ?? [];
  }

  @callable()
  async approveAndSend(args: { approvalId: string; actorUserId: string; edits?: { subject?: string; body_markdown?: string } }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const row = await this.env.DB.prepare(
      `SELECT workspace_id, ticket_id, kind, proposed_json, status FROM approval_request WHERE id = ?`,
    )
      .bind(args.approvalId)
      .first<{ workspace_id: string; ticket_id: string; kind: string; proposed_json: string; status: string }>();
    if (!row || row.status !== 'pending') return { ok: false, error: 'not_pending' };
    if (row.workspace_id !== this.state.workspaceId) return { ok: false, error: 'wrong_workspace' };

    const proposed = JSON.parse(row.proposed_json);
    const subject = args.edits?.subject ?? proposed.subject;
    const body = args.edits?.body_markdown ?? proposed.body_markdown;

    const sent = await this.sendThreadedReply({
      ticketId: row.ticket_id,
      body,
      subject,
      actorUserId: args.actorUserId,
      source: 'ai_approval',
      approvalId: args.approvalId,
      edited: !!args.edits,
    });

    await this.env.DB.prepare(
      `UPDATE approval_request SET status = 'approved', decided_by_user_id = ?, decided_at = ? WHERE id = ?`,
    )
      .bind(args.actorUserId, Date.now(), args.approvalId)
      .run();

    return { ok: true, messageId: sent.messageId };
  }

  /**
   * Operator-initiated send. Skips the AI-draft / approval queue entirely.
   * Used by the ticket detail page's compose-reply form.
   */
  @callable()
  async replyDirect(args: {
    ticketId: string;
    actorUserId: string;
    body: string;
    subject?: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    if (!args.body || args.body.trim().length === 0) {
      return { ok: false, error: 'empty_body' };
    }
    try {
      const sent = await this.sendThreadedReply({
        ticketId: args.ticketId,
        body: args.body,
        subject: args.subject,
        actorUserId: args.actorUserId,
        source: 'manual',
      });
      return { ok: true, messageId: sent.messageId };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'send_failed' };
    }
  }

  /**
   * Operator-initiated AI draft, SYNCHRONOUS. Calls the LLM in-band and
   * returns the suggested subject/body so the UI can populate the
   * compose-reply textarea. Operator edits + sends via replyDirect.
   *
   * Distinct from the auto-draft flow (triageAndDraft → approval card),
   * which is for hands-off "AI handles it, human just clicks approve"
   * teams. The on-demand path is for "I want a starting point, let me
   * polish it" teams.
   */
  @callable()
  async draftReply(args: {
    ticketId: string;
    actorUserId: string;
  }): Promise<{ ok: boolean; subject?: string; body?: string; error?: string }> {
    const t = await this.env.DB.prepare(
      `SELECT id, requester_email, subject FROM ticket WHERE id = ? AND workspace_id = ?`,
    )
      .bind(args.ticketId, this.state.workspaceId)
      .first<{ id: string; requester_email: string; subject: string }>();
    if (!t) return { ok: false, error: 'ticket_not_found' };

    const lastInbound = await this.env.DB.prepare(
      `SELECT from_address, subject, preview
         FROM message_index
        WHERE ticket_id = ? AND direction = 'inbound'
        ORDER BY sent_at DESC LIMIT 1`,
    )
      .bind(args.ticketId)
      .first<{ from_address: string | null; subject: string | null; preview: string | null }>();
    if (!lastInbound) return { ok: false, error: 'no_inbound_message_to_draft_from' };

    try {
      const cfg = await this.workspaceConfig();
      const knowledge = await searchKnowledge(
        this.env,
        this.state.workspaceId,
        `${lastInbound.subject ?? t.subject}\n${lastInbound.preview ?? ''}`,
      );
      const draft = await runDraft({
        env: this.env,
        workspaceId: this.state.workspaceId,
        ticketId: args.ticketId,
        customerMessage: lastInbound.preview ?? '',
        customerName: undefined,
        knowledge,
        workspaceConfig: cfg,
      });
      await audit(this.env, {
        workspaceId: this.state.workspaceId,
        ticketId: args.ticketId,
        actorType: 'user',
        actorId: args.actorUserId,
        action: 'ai_draft.suggested',
      });
      const reSubject = `Re: ${(lastInbound.subject ?? t.subject).replace(/^(re:\s*)+/i, '')}`;
      return { ok: true, subject: reSubject, body: draft.body_markdown };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'draft_failed' };
    }
  }

  /**
   * Toggle the per-ticket AI-drafts override. Pass `enabled: null` to
   * clear the override (ticket inherits workspace setting).
   */
  @callable()
  async setTicketAiDrafts(args: {
    ticketId: string;
    actorUserId: string;
    enabled: boolean | null;
  }): Promise<{ ok: boolean }> {
    const v = args.enabled === null ? null : args.enabled ? 1 : 0;
    await this.env.DB.prepare(
      `UPDATE ticket SET ai_drafts_enabled = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    )
      .bind(v, Date.now(), args.ticketId, this.state.workspaceId)
      .run();
    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      ticketId: args.ticketId,
      actorType: 'user',
      actorId: args.actorUserId,
      action: 'ticket.ai_drafts_changed',
      payload: { enabled: args.enabled },
    });
    return { ok: true };
  }

  /**
   * Read/write workspace-level settings — ai_drafts_enabled, from_name
   * (display name on outbound From header), logo_url (for the HTML body
   * header).
   */
  @callable()
  async getWorkspaceSettings(): Promise<{
    ai_drafts_enabled: boolean;
    from_name: string;
    logo_url: string;
    workspace_name: string;
  }> {
    const w = await this.env.DB.prepare(`SELECT name, settings_json FROM workspace WHERE id = ?`)
      .bind(this.state.workspaceId)
      .first<{ name: string; settings_json: string }>();
    try {
      const s = w ? JSON.parse(w.settings_json || '{}') : {};
      return {
        ai_drafts_enabled: s.ai_drafts_enabled === true,
        from_name: typeof s.from_name === 'string' ? s.from_name : '',
        logo_url: typeof s.logo_url === 'string' ? s.logo_url : '',
        workspace_name: w?.name ?? '',
      };
    } catch {
      return { ai_drafts_enabled: false, from_name: '', logo_url: '', workspace_name: w?.name ?? '' };
    }
  }

  @callable()
  async setWorkspaceSettings(args: {
    actorUserId: string;
    ai_drafts_enabled?: boolean;
    from_name?: string;
    logo_url?: string;
  }): Promise<{ ok: boolean }> {
    const w = await this.env.DB.prepare(`SELECT settings_json FROM workspace WHERE id = ?`)
      .bind(this.state.workspaceId)
      .first<{ settings_json: string }>();
    let settings: Record<string, unknown> = {};
    try {
      settings = w ? JSON.parse(w.settings_json || '{}') : {};
    } catch {
      settings = {};
    }
    if (args.ai_drafts_enabled !== undefined) settings.ai_drafts_enabled = !!args.ai_drafts_enabled;
    if (args.from_name !== undefined) settings.from_name = args.from_name.trim().slice(0, 100);
    if (args.logo_url !== undefined) settings.logo_url = args.logo_url.trim().slice(0, 500);
    await this.env.DB.prepare(`UPDATE workspace SET settings_json = ? WHERE id = ?`)
      .bind(JSON.stringify(settings), this.state.workspaceId)
      .run();
    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      actorType: 'user',
      actorId: args.actorUserId,
      action: 'workspace.settings_changed',
      payload: args,
    });
    return { ok: true };
  }

  /**
   * Read/write the agent's profile fields used in outbound email — display
   * name (on From header), markdown signature, avatar URL.
   */
  @callable()
  async getAgentProfile(args: { userId: string }): Promise<{
    name: string;
    email: string;
    signature_markdown: string;
    avatar_url: string;
  } | null> {
    const u = await this.env.DB.prepare(
      `SELECT u.name, u.email, u.signature_markdown, u.avatar_url
         FROM user u JOIN workspace_user wu ON wu.user_id = u.id
        WHERE u.id = ? AND wu.workspace_id = ?`,
    )
      .bind(args.userId, this.state.workspaceId)
      .first<{ name: string | null; email: string; signature_markdown: string | null; avatar_url: string | null }>();
    if (!u) return null;
    return {
      name: u.name ?? '',
      email: u.email,
      signature_markdown: u.signature_markdown ?? '',
      avatar_url: u.avatar_url ?? '',
    };
  }

  @callable()
  async setAgentProfile(args: {
    userId: string;
    name?: string;
    signature_markdown?: string;
    avatar_url?: string;
  }): Promise<{ ok: boolean }> {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (args.name !== undefined) {
      fields.push('name = ?');
      values.push(args.name.trim().slice(0, 100));
    }
    if (args.signature_markdown !== undefined) {
      fields.push('signature_markdown = ?');
      values.push(args.signature_markdown.slice(0, 5000));
    }
    if (args.avatar_url !== undefined) {
      fields.push('avatar_url = ?');
      values.push(args.avatar_url.trim().slice(0, 500));
    }
    if (fields.length === 0) return { ok: true };
    values.push(args.userId);
    await this.env.DB.prepare(`UPDATE user SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
    return { ok: true };
  }

  @callable()
  async rejectApproval(args: { approvalId: string; actorUserId: string; reason?: string }) {
    await this.env.DB.prepare(
      `UPDATE approval_request SET status = 'rejected', decided_by_user_id = ?, decided_at = ? WHERE id = ? AND workspace_id = ?`,
    )
      .bind(args.actorUserId, Date.now(), args.approvalId, this.state.workspaceId)
      .run();
    await audit(this.env, {
      workspaceId: this.state.workspaceId,
      actorType: 'user',
      actorId: args.actorUserId,
      action: 'approval.rejected',
      payload: { approvalId: args.approvalId, reason: args.reason },
    });
    await this.refreshCounts();
  }

  private async findTicketByReferences(
    inReplyTo: string | undefined,
    references: string[],
    requesterEmail: string,
  ): Promise<string | null> {
    const ids_ = [inReplyTo, ...references].filter(Boolean) as string[];
    if (ids_.length) {
      const placeholders = ids_.map(() => '?').join(',');
      const row = await this.env.DB.prepare(
        `SELECT ticket_id FROM message_index WHERE rfc_message_id IN (${placeholders}) LIMIT 1`,
      )
        .bind(...ids_)
        .first<{ ticket_id: string }>();
      if (row) return row.ticket_id;
    }
    // Fallback: open ticket from same requester in last 72h
    const since = Date.now() - 72 * 3600 * 1000;
    const row = await this.env.DB.prepare(
      `SELECT id FROM ticket WHERE workspace_id = ? AND requester_email = ? AND status IN ('open','pending') AND last_message_at > ?
       ORDER BY last_message_at DESC LIMIT 1`,
    )
      .bind(this.state.workspaceId, requesterEmail.toLowerCase(), since)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  private async refreshCounts(): Promise<void> {
    const [open, approvals] = await Promise.all([
      this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ticket WHERE workspace_id = ? AND status = 'open'`,
      )
        .bind(this.state.workspaceId)
        .first<{ n: number }>(),
      this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM approval_request WHERE workspace_id = ? AND status = 'pending'`,
      )
        .bind(this.state.workspaceId)
        .first<{ n: number }>(),
    ]);
    await this.setState({
      ...this.state,
      openCount: open?.n ?? 0,
      currentApprovals: approvals?.n ?? 0,
      lastSyncAt: Date.now(),
    });
  }
}
