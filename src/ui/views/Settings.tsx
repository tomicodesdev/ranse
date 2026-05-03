import { useEffect, useState } from 'react';
import { API } from '../api';
import { NotificationsSection } from './NotificationsSection';

const ACTIONS = ['triage', 'summarize', 'draft', 'knowledge_query', 'escalation', 'conversational'] as const;
const PROVIDERS = ['openai', 'anthropic', 'google-ai-studio', 'grok', 'openrouter'];

const MODEL_HINTS: Record<string, string[]> = {
  'workers-ai': ['workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct'],
  openai: ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/gpt-5', 'openai/gpt-5-mini'],
  anthropic: ['anthropic/claude-opus-4-7', 'anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5'],
  'google-ai-studio': ['google-ai-studio/gemini-2.5-pro', 'google-ai-studio/gemini-2.5-flash'],
};

export function SettingsView() {
  const [providers, setProviders] = useState<string[]>([]);
  const [provDraft, setProvDraft] = useState({ provider: 'openai', api_key: '' });
  const [llmConfig, setLlmConfig] = useState<any[]>([]);
  const [aiDraftsEnabled, setAiDraftsEnabled] = useState(false);
  const [fromName, setFromName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [profile, setProfile] = useState({ name: '', email: '', signature_markdown: '', avatar_url: '' });
  const [saved, setSaved] = useState('');

  async function load() {
    const [p, l, w, me] = await Promise.all([
      API.providers(),
      API.llmConfig(),
      API.workspaceSettings(),
      API.myProfile(),
    ]);
    setProviders(p.providers ?? []);
    setLlmConfig(l.config ?? []);
    setAiDraftsEnabled(!!w.ai_drafts_enabled);
    setWorkspaceName(w.workspace_name ?? '');
    setFromName(w.from_name ?? '');
    setLogoUrl(w.logo_url ?? '');
    setProfile({
      name: me.name ?? '',
      email: me.email ?? '',
      signature_markdown: me.signature_markdown ?? '',
      avatar_url: me.avatar_url ?? '',
    });
  }
  useEffect(() => { load(); }, []);

  function flashSaved() {
    setSaved('Saved');
    setTimeout(() => setSaved(''), 1500);
  }

  const configByAction = Object.fromEntries(llmConfig.map((c) => [c.action_key, c]));

  return (
    <>
      <h1>Settings</h1>

      <h2>Workspace branding</h2>
      <div className="card">
        <p className="muted" style={{ marginBottom: 8 }}>
          Shown on outbound replies as the From-header display name and the HTML email header logo.
        </p>
        <div className="field">
          <label>From name</label>
          <input
            type="text"
            value={fromName}
            placeholder={workspaceName || 'Acme Support'}
            onChange={(e) => setFromName(e.target.value)}
            onBlur={async () => {
              await API.setWorkspaceSettings({ from_name: fromName });
              flashSaved();
            }}
          />
          {!fromName && workspaceName && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Falling back to workspace name: <strong>{workspaceName}</strong>
            </div>
          )}
        </div>
        <div className="field">
          <label>Logo</label>
          <div className="row">
            <input
              type="url"
              value={logoUrl}
              placeholder="https://example.com/logo.png"
              onChange={(e) => setLogoUrl(e.target.value)}
              onBlur={async () => {
                await API.setWorkspaceSettings({ logo_url: logoUrl });
                flashSaved();
              }}
            />
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const { url } = await API.uploadWorkspaceLogo(file);
                setLogoUrl(url);
                flashSaved();
                e.target.value = '';
              }}
            />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Paste a URL or upload an image (≤ 2MB, PNG/JPEG/WebP/GIF). Uploads are stored in your R2 bucket.
          </div>
          {logoUrl && <img src={logoUrl} alt="Logo preview" style={{ maxHeight: 40, marginTop: 8 }} />}
        </div>
      </div>

      <h2>My profile</h2>
      <div className="card">
        <p className="muted" style={{ marginBottom: 8 }}>
          Shown on replies you send manually. Display name appears in the From header (e.g. "Sarah · Acme Support"); signature is appended to the HTML body.
        </p>
        <div className="field">
          <label>Display name</label>
          <input
            type="text"
            value={profile.name}
            placeholder="Sarah"
            onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            onBlur={async () => {
              await API.setMyProfile({ name: profile.name });
              flashSaved();
            }}
          />
        </div>
        <div className="field">
          <label>Avatar <span className="muted" style={{ fontSize: 12 }}>(falls back to Gravatar from {profile.email || 'your email'})</span></label>
          <div className="row">
            <input
              type="url"
              value={profile.avatar_url}
              placeholder="https://example.com/avatar.jpg"
              onChange={(e) => setProfile({ ...profile, avatar_url: e.target.value })}
              onBlur={async () => {
                await API.setMyProfile({ avatar_url: profile.avatar_url });
                flashSaved();
              }}
            />
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const { url } = await API.uploadAvatar(file);
                setProfile((p) => ({ ...p, avatar_url: url }));
                flashSaved();
                e.target.value = '';
              }}
            />
          </div>
          {profile.avatar_url && (
            <img src={profile.avatar_url} alt="Avatar preview" style={{ width: 40, height: 40, borderRadius: '50%', marginTop: 8, objectFit: 'cover' }} />
          )}
        </div>
        <div className="field">
          <label>Email signature (markdown)</label>
          <textarea
            rows={4}
            value={profile.signature_markdown}
            placeholder={'Sarah Smith\nCustomer Success · Acme\n[acme.com](https://acme.com)'}
            onChange={(e) => setProfile({ ...profile, signature_markdown: e.target.value })}
            onBlur={async () => {
              await API.setMyProfile({ signature_markdown: profile.signature_markdown });
              flashSaved();
            }}
          />
        </div>
      </div>

      <h2>Preferences</h2>
      <div className="card">
        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">Auto-draft replies</div>
            <div className="setting-desc">
              Generate a suggested reply for every inbound email and post it to the approvals queue for a human to review and send. When off, the "Suggest with AI" button on a ticket still works on demand.
            </div>
          </div>
          <div className="setting-control">
            <input
              type="checkbox"
              checked={aiDraftsEnabled}
              onChange={async (e) => {
                const next = e.target.checked;
                setAiDraftsEnabled(next);
                await API.setWorkspaceSettings({ ai_drafts_enabled: next });
                flashSaved();
              }}
            />
          </div>
        </div>
      </div>

      <NotificationsSection onSaved={flashSaved} />

      <h2>LLM providers (BYOK)</h2>
      <div className="card">
        <p className="muted">Add API keys for providers you want to use. Without a key, Ranse falls back to Workers AI.</p>
        {providers.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {providers.map((p) => <span key={p} className="pill">{p} ✓</span>)}
          </div>
        )}
        <div className="row">
          <select value={provDraft.provider} onChange={(e) => setProvDraft({ ...provDraft, provider: e.target.value })}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <input type="password" placeholder="API key" value={provDraft.api_key} onChange={(e) => setProvDraft({ ...provDraft, api_key: e.target.value })} />
          <button className="primary" onClick={async () => {
            await API.setProvider(provDraft.provider, provDraft.api_key);
            setProvDraft({ ...provDraft, api_key: '' });
            setSaved('Provider key saved');
            await load();
          }}>Save</button>
        </div>
      </div>

      <h2>Model per agent action</h2>
      <div className="card">
        <p className="muted">Which model does each specialist use? Leave blank to use the defaults.</p>
        {ACTIONS.map((action) => {
          const cur = configByAction[action];
          return (
            <div key={action} className="row" style={{ marginBottom: 8 }}>
              <div style={{ flex: 0.4, fontWeight: 500 }}>{action}</div>
              <input
                placeholder="provider/model-id"
                defaultValue={cur?.model_name ?? ''}
                onBlur={async (e) => {
                  if (!e.target.value) return;
                  await API.setLlmConfig({ action_key: action, model_name: e.target.value });
                  setSaved(`Saved ${action}`);
                  await load();
                }}
              />
              <input
                placeholder="fallback (optional)"
                defaultValue={cur?.fallback_model ?? ''}
                onBlur={async (e) => {
                  if (!e.target.value) return;
                  await API.setLlmConfig({ action_key: action, model_name: cur?.model_name, fallback_model: e.target.value });
                  await load();
                }}
              />
            </div>
          );
        })}
        <details style={{ marginTop: 12 }}>
          <summary className="muted">Known model IDs</summary>
          {Object.entries(MODEL_HINTS).map(([p, list]) => (
            <div key={p} style={{ marginTop: 6 }}>
              <strong>{p}</strong>
              <div style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>{list.map((m) => <div key={m}>{m}</div>)}</div>
            </div>
          ))}
        </details>
      </div>

      {saved && <div className="success-banner" style={{ position: 'fixed', bottom: 20, right: 20 }}>{saved}</div>}
    </>
  );
}
