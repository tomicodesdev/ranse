/**
 * Tiny markdown → HTML converter scoped to the subset that shows up in
 * support replies: paragraphs, line breaks, bold/italic, links, inline
 * code, blockquotes, and basic bullet lists. Output is HTML-escaped first
 * so user content can never inject script or attributes.
 *
 * No external dependency on purpose — reply content is small (a few KB
 * at most), and avoiding a markdown lib keeps the Worker bundle tight.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(s: string): string {
  let out = escapeHtml(s);
  // links: [text](url)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, t, u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${t}</a>`,
  );
  // bold **text**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // italic *text*  (avoid eating bold)
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
  // inline code `code`
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // bare URLs → autolink (skip ones already in href="...")
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a>`,
  );
  return out;
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    // bullet list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    // blockquote
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(inline(lines[i].replace(/^>\s?/, '')));
        i++;
      }
      out.push(`<blockquote>${quoted.join('<br>')}</blockquote>`);
      continue;
    }
    // paragraph: collect until blank
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^[-*]\s+/.test(lines[i]) && !/^>\s?/.test(lines[i])) {
      para.push(inline(lines[i]));
      i++;
    }
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return out.join('\n');
}

/**
 * SHA-256-based Gravatar URL. Gravatar v2 accepts SHA-256 hashes so we
 * don't need MD5 (Web Crypto doesn't ship with MD5). `d=mp` falls back to
 * the generic mystery-person silhouette when no Gravatar exists for the
 * email — operators can override with their own avatar_url.
 */
export async function gravatarUrl(email: string, size = 64): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  return `https://www.gravatar.com/avatar/${hex}?d=mp&s=${size}`;
}

export interface SignatureCtx {
  agentName?: string | null;
  agentEmail?: string | null;
  agentSignatureMarkdown?: string | null;
  agentAvatarUrl?: string | null;
  workspaceName?: string | null;
  fromName?: string | null;
}

/**
 * Append a default signature to plain-text body when the agent hasn't
 * written one. Keeps the text/plain alternative readable.
 */
export function buildPlainTextWithSignature(body: string, ctx: SignatureCtx): string {
  if (ctx.agentSignatureMarkdown) {
    return `${body.trimEnd()}\n\n--\n${ctx.agentSignatureMarkdown}`;
  }
  const parts: string[] = [];
  if (ctx.agentName) parts.push(ctx.agentName);
  if (ctx.fromName || ctx.workspaceName) parts.push(ctx.fromName ?? ctx.workspaceName ?? '');
  if (parts.length === 0) return body;
  return `${body.trimEnd()}\n\n--\n${parts.join('\n')}`;
}

/**
 * Build the HTML alternative for a reply: body rendered from markdown,
 * then an agent signature block with avatar / name. No workspace logo
 * inline — Gmail/Outlook show the sender avatar from BIMI/Gravatar, and
 * embedding it in the body just duplicates branding awkwardly.
 * Uses inline styles only (some clients strip <style>), scoped enough
 * to render reasonably in Gmail / Outlook / Apple Mail.
 */
export async function buildHtmlWithSignature(
  bodyMarkdown: string,
  ctx: SignatureCtx,
): Promise<string> {
  const bodyHtml = markdownToHtml(bodyMarkdown);

  const avatar =
    ctx.agentAvatarUrl ??
    (ctx.agentEmail ? await gravatarUrl(ctx.agentEmail) : null);

  const name = ctx.agentName ?? '';
  const sub = ctx.fromName ?? ctx.workspaceName ?? '';

  let signatureHtml = '';
  if (ctx.agentSignatureMarkdown) {
    signatureHtml = `<div style="margin-top:48px;padding-top:16px;border-top:1px solid #eee;color:#555;font-size:14px;">${markdownToHtml(ctx.agentSignatureMarkdown)}</div>`;
  } else if (name || sub || avatar) {
    signatureHtml = `<table style="margin-top:48px;padding-top:16px;border-top:1px solid #eee;color:#555;font-size:14px;" cellspacing="0" cellpadding="0"><tr>${
      avatar
        ? `<td style="padding-right:10px;vertical-align:middle"><img src="${avatar}" width="40" height="40" alt="${escapeHtml(name)}" style="border-radius:50%;display:block"></td>`
        : ''
    }<td style="vertical-align:middle">${
      name ? `<div style="font-weight:600;color:#222">${escapeHtml(name)}</div>` : ''
    }${
      sub ? `<div>${escapeHtml(sub)}</div>` : ''
    }</td></tr></table>`;
  }

  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;line-height:1.5;max-width:640px;margin:0;padding:0">${bodyHtml}${signatureHtml}</body></html>`;
}

/**
 * Build a multipart/alternative raw MIME message. text/plain part comes
 * first (per RFC 2046 — clients that prefer plain text get the simpler
 * version), HTML second.
 */
export interface MultipartHeaders {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  date?: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: string;
}

function escapeHeaderValue(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

export function buildMultipartReply(
  headers: MultipartHeaders,
  textBody: string,
  htmlBody: string,
): string {
  const boundary = `=_ranse_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const date = headers.date ?? new Date().toUTCString();
  const headerLines: string[] = [
    `Date: ${date}`,
    `From: ${escapeHeaderValue(headers.from)}`,
    `To: ${escapeHeaderValue(headers.to)}`,
    `Subject: ${escapeHeaderValue(headers.subject)}`,
    `Message-ID: <${headers.messageId}>`,
  ];
  if (headers.replyTo) headerLines.push(`Reply-To: ${escapeHeaderValue(headers.replyTo)}`);
  if (headers.inReplyTo) headerLines.push(`In-Reply-To: <${headers.inReplyTo}>`);
  if (headers.references?.length) {
    const refs = headers.references.length > 10
      ? [headers.references[0], ...headers.references.slice(-9)]
      : headers.references;
    headerLines.push(`References: ${refs.map((r) => `<${r}>`).join(' ')}`);
  }
  headerLines.push('MIME-Version: 1.0');
  headerLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    textBody.replace(/\r?\n/g, '\r\n'),
  ].join('\r\n');

  const htmlPart = [
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlBody,
  ].join('\r\n');

  const closing = `--${boundary}--`;

  return `${headerLines.join('\r\n')}\r\n\r\n${textPart}\r\n${htmlPart}\r\n${closing}\r\n`;
}
