export class ApiRequestError extends Error {
  code: string;
  status: number;
  details?: unknown;
  requestId?: string;
  constructor(init: { code: string; message: string; status: number; details?: unknown; requestId?: string }) {
    super(init.message);
    this.name = 'ApiRequestError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
  }
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'include',
  });
  if (!res.ok) {
    let body: any;
    try {
      body = await res.json();
    } catch {
      body = { error: 'http_error', message: res.statusText };
    }
    throw new ApiRequestError({
      code: body?.error ?? 'http_error',
      message: body?.message ?? body?.error ?? `HTTP ${res.status}`,
      status: res.status,
      details: body?.details,
      requestId: body?.requestId,
    });
  }
  return res.json();
}

export const API = {
  setupStatus: () => api<{ completed: boolean }>('/setup/status'),
  bootstrap: (body: any) => api('/setup/bootstrap', { method: 'POST', body: JSON.stringify(body) }),
  addMailbox: (body: any) => api('/setup/mailbox', { method: 'POST', body: JSON.stringify(body) }),
  provision: (body: {
    api_token: string;
    account_id: string;
    domain: string;
    mailbox_address: string;
    worker_name: string;
  }) => api<{ ok: boolean; steps: any[] }>('/setup/provision', { method: 'POST', body: JSON.stringify(body) }),
  verify: () => api('/setup/verify', { method: 'POST' }),
  login: (email: string, password: string) =>
    api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => api('/auth/logout', { method: 'POST' }),
  me: () => api<any>('/auth/me'),
  tickets: (status?: string) => api<any>(`/api/tickets${status ? `?status=${status}` : ''}`),
  ticket: (id: string) => api<any>(`/api/tickets/${id}`),
  setStatus: (id: string, status: string) =>
    api(`/api/tickets/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  addNote: (id: string, body: string) =>
    api(`/api/tickets/${id}/note`, { method: 'POST', body: JSON.stringify({ body }) }),
  reply: (id: string, body: string, subject?: string) =>
    api<{ ok: boolean; messageId?: string; error?: string }>(`/api/tickets/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body, subject }),
    }),
  draftWithAI: (id: string) =>
    api<{ ok: boolean; subject?: string; body?: string; error?: string }>(`/api/tickets/${id}/draft`, { method: 'POST' }),
  setTicketAiDrafts: (id: string, enabled: boolean | null) =>
    api(`/api/tickets/${id}/ai-drafts`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  workspaceSettings: () =>
    api<{ ai_drafts_enabled: boolean }>('/api/settings/workspace'),
  setWorkspaceSettings: (settings: { ai_drafts_enabled: boolean }) =>
    api('/api/settings/workspace', { method: 'POST', body: JSON.stringify(settings) }),
  approvals: () => api<any>('/api/approvals'),
  approve: (id: string, edits?: any) =>
    api(`/api/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ edits }) }),
  reject: (id: string, reason?: string) =>
    api(`/api/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  llmConfig: () => api<any>('/api/settings/llm'),
  setLlmConfig: (body: any) =>
    api('/api/settings/llm', { method: 'POST', body: JSON.stringify(body) }),
  providers: () => api<{ providers: string[] }>('/api/settings/providers'),
  setProvider: (provider: string, api_key: string) =>
    api('/api/settings/providers', { method: 'POST', body: JSON.stringify({ provider, api_key }) }),
};
