import { useState } from 'react';
import { API } from '../api';

interface AdminForm {
  setup_token: string;
  workspace_name: string;
  admin_name: string;
  admin_email: string;
  admin_password: string;
}

interface MailboxForm {
  address: string;
  display_name: string;
}

interface ProvisionForm {
  enabled: boolean;
  api_token: string;
  account_id: string;
  worker_name: string;
}

interface ProvisionStep {
  id: string;
  label: string;
  status: 'ok' | 'fail' | 'skipped';
  message?: string;
  dns_records?: Array<{ type: string; name: string; content: string; priority?: number }>;
}

type Step = 1 | 2 | 3 | 4;

function detectWorkerName(): string {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname;
  if (host.endsWith('.workers.dev')) return host.split('.')[0];
  return '';
}

export function SetupView({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>(1);
  const [admin, setAdmin] = useState<AdminForm>({
    setup_token: '',
    workspace_name: '',
    admin_name: '',
    admin_email: '',
    admin_password: '',
  });
  const [mailbox, setMailbox] = useState<MailboxForm>({ address: '', display_name: '' });
  const [provision, setProvision] = useState<ProvisionForm>({
    enabled: false,
    api_token: '',
    account_id: '',
    worker_name: detectWorkerName(),
  });
  const [showToken, setShowToken] = useState(false);
  const [showApiToken, setShowApiToken] = useState(false);
  const [provisionSteps, setProvisionSteps] = useState<ProvisionStep[] | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState('');
  const [checks, setChecks] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

  function next(to: Step) {
    setError('');
    setStep(to);
  }

  async function runProvision() {
    setError('');
    if (!mailbox.address || !provision.api_token || !provision.account_id || !provision.worker_name) {
      setError('Fill in mailbox address, API token, account ID, and Worker name first.');
      return;
    }
    setProvisioning(true);
    setProvisionSteps(null);
    try {
      const domain = mailbox.address.split('@')[1];
      const res = await API.provision({
        api_token: provision.api_token,
        account_id: provision.account_id,
        domain,
        mailbox_address: mailbox.address,
        worker_name: provision.worker_name,
      });
      setProvisionSteps(res.steps);
      if (!res.ok) setError('Some steps failed — review below and retry.');
    } catch (err: any) {
      setError(err.message || 'Provisioning failed');
    } finally {
      setProvisioning(false);
    }
  }

  async function finish() {
    setError('');
    setSubmitting(true);
    try {
      await API.bootstrap(admin);
      await API.addMailbox(mailbox);
      const v = await API.verify();
      setChecks(v);
      setStep(4);
    } catch (err: any) {
      setError(err.message || 'Setup failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="center">
      <div className="auth-card card">
        <h1>Welcome to Ranse</h1>
        <p className="muted">
          Step {step === 4 ? '3' : step} of 3
          {step === 4 && ' — all set.'}
        </p>

        {step === 1 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              next(2);
            }}
          >
            <h2>Step 1 · Admin account</h2>
            <div className="field">
              <label>Setup token</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showToken ? 'text' : 'password'}
                  value={admin.setup_token}
                  onChange={(e) => setAdmin({ ...admin, setup_token: e.target.value })}
                  placeholder="Paste your ADMIN_SETUP_TOKEN"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  style={{ paddingRight: 56 }}
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  style={{
                    position: 'absolute',
                    right: 4,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    padding: '4px 10px',
                    fontSize: 12,
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                  }}
                >
                  {showToken ? 'Hide' : 'Show'}
                </button>
              </div>
              <div className="muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
                Find it in your Cloudflare deploy build log, or rotate with
                <code style={{ display: 'inline-block', margin: '0 4px' }}>
                  wrangler secret put ADMIN_SETUP_TOKEN
                </code>
                . One-time use.
              </div>
            </div>
            <div className="field">
              <label>Workspace name</label>
              <input
                value={admin.workspace_name}
                onChange={(e) => setAdmin({ ...admin, workspace_name: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label>Your name</label>
              <input
                value={admin.admin_name}
                onChange={(e) => setAdmin({ ...admin, admin_name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Admin email</label>
              <input
                type="email"
                value={admin.admin_email}
                onChange={(e) => setAdmin({ ...admin, admin_email: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label>Password (min 12 chars)</label>
              <input
                type="password"
                value={admin.admin_password}
                onChange={(e) => setAdmin({ ...admin, admin_password: e.target.value })}
                required
                minLength={12}
              />
            </div>
            {error && <div className="error">{error}</div>}
            <button type="submit" className="primary" style={{ width: '100%' }}>
              Next
            </button>
          </form>
        )}

        {step === 2 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              next(3);
            }}
          >
            <h2>Step 2 · Support mailbox</h2>
            <p className="muted">
              The address to receive support email. You'll route this address to the Ranse Worker
              in the Cloudflare Email dashboard.
            </p>
            <div className="field">
              <label>Mailbox address</label>
              <input
                type="email"
                placeholder="support@yourdomain.com"
                value={mailbox.address}
                onChange={(e) => setMailbox({ ...mailbox, address: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label>Display name</label>
              <input
                placeholder="Acme Support"
                value={mailbox.display_name}
                onChange={(e) => setMailbox({ ...mailbox, display_name: e.target.value })}
              />
            </div>
            <details
              style={{ marginTop: 12, padding: 10, background: 'var(--bg-soft)', borderRadius: 6, border: '1px solid var(--border)' }}
              open={provision.enabled}
              onToggle={(e) => setProvision({ ...provision, enabled: (e.target as HTMLDetailsElement).open })}
            >
              <summary style={{ cursor: 'pointer', fontWeight: 500 }}>
                Auto-configure Cloudflare (optional)
              </summary>
              <p className="muted" style={{ marginTop: 8 }}>
                Paste a scoped API token and Ranse will onboard the sending domain, add DKIM/SPF/DMARC DNS records (if the zone is on Cloudflare), enable Email Routing, and create a rule that forwards <code>{mailbox.address || 'your mailbox'}</code> to this Worker. Token is used once and not stored.
              </p>
              <p className="muted" style={{ fontSize: 12 }}>
                Required token permissions:{' '}
                <strong>
                  Account · Email Sending: Edit, Zone · Zone: Read, Zone · DNS: Edit, Zone · Email Routing Rules: Edit
                </strong>
                .{' '}
                <a
                  href="https://dash.cloudflare.com/profile/api-tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  Create token →
                </a>
              </p>
              <div className="field">
                <label>Cloudflare API token</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showApiToken ? 'text' : 'password'}
                    value={provision.api_token}
                    onChange={(e) => setProvision({ ...provision, api_token: e.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="cf_xxx..."
                    style={{ paddingRight: 56 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiToken((v) => !v)}
                    style={{
                      position: 'absolute',
                      right: 4,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      padding: '4px 10px',
                      fontSize: 12,
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {showApiToken ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
              <div className="field">
                <label>Cloudflare account ID</label>
                <input
                  value={provision.account_id}
                  onChange={(e) => setProvision({ ...provision, account_id: e.target.value })}
                  placeholder="0fd7f5d92bfc8b08c568e8e3cf575394"
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="muted">Dashboard → right sidebar → Account ID.</span>
              </div>
              <div className="field">
                <label>This Worker's script name</label>
                <input
                  value={provision.worker_name}
                  onChange={(e) => setProvision({ ...provision, worker_name: e.target.value })}
                  placeholder="ranse"
                />
                <span className="muted">Auto-detected from your Worker URL.</span>
              </div>
              <button
                type="button"
                onClick={runProvision}
                disabled={provisioning}
                style={{ marginTop: 6 }}
              >
                {provisioning ? 'Provisioning…' : provisionSteps ? 'Retry' : 'Run auto-configure'}
              </button>
              {provisionSteps && (
                <div style={{ marginTop: 12 }}>
                  {provisionSteps.map((s) => (
                    <div key={s.id} className={`step ${s.status === 'ok' ? 'ok' : s.status === 'fail' ? 'fail' : ''}`}>
                      <span className="dot" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div>{s.label}</div>
                        {s.status === 'fail' && s.message && (
                          <pre
                            style={{
                              marginTop: 4,
                              padding: 6,
                              background: 'var(--bg)',
                              border: '1px solid var(--border)',
                              borderRadius: 4,
                              fontSize: 11,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}
                          >
                            {s.message}
                          </pre>
                        )}
                      </div>
                    </div>
                  ))}
                  {provisionSteps.some((s) => s.dns_records && s.status === 'skipped') && (
                    <div style={{ marginTop: 10 }}>
                      <strong style={{ fontSize: 13 }}>Add these at your registrar:</strong>
                      <pre
                        style={{
                          marginTop: 6,
                          padding: 8,
                          background: 'var(--bg)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          fontSize: 11,
                          overflow: 'auto',
                        }}
                      >
                        {provisionSteps
                          .flatMap((s) => s.dns_records ?? [])
                          .map((r, i) => `${i + 1}. ${r.type}  ${r.name}  →  ${r.content}${r.priority ? ` (priority ${r.priority})` : ''}`)
                          .join('\n')}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </details>
            {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => next(1)} style={{ flex: 1 }}>
                ← Back
              </button>
              <button type="submit" className="primary" style={{ flex: 2 }}>
                Next
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <>
            <h2>Step 3 · Review & finish</h2>
            <p className="muted">
              Double-check these values before committing. You can't undo setup without resetting
              the database.
            </p>
            <dl className="review">
              <dt>Workspace</dt>
              <dd>{admin.workspace_name}</dd>
              <dt>Admin</dt>
              <dd>
                {admin.admin_name
                  ? `${admin.admin_name} · ${admin.admin_email}`
                  : admin.admin_email}
              </dd>
              <dt>Password</dt>
              <dd>{'•'.repeat(Math.min(admin.admin_password.length, 16))}</dd>
              <dt>Mailbox</dt>
              <dd>
                {mailbox.address}
                {mailbox.display_name ? ` (${mailbox.display_name})` : ''}
              </dd>
            </dl>
            {error && <div className="error">{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => next(2)}
                disabled={submitting}
                style={{ flex: 1 }}
              >
                ← Back
              </button>
              <button
                type="button"
                className="primary"
                onClick={finish}
                disabled={submitting}
                style={{ flex: 2 }}
              >
                {submitting ? 'Setting up…' : 'Finish setup'}
              </button>
            </div>
          </>
        )}

        {step === 4 && checks && (
          <>
            <h2>All set</h2>
            <div className="step ok">
              <span className="dot" />
              Workspace + admin created
            </div>
            <div className="step ok">
              <span className="dot" />
              Mailbox added
            </div>
            {Object.entries<any>(checks.checks).map(([k, v]) => (
              <div key={k} className={`step ${v.ok ? 'ok' : 'fail'}`}>
                <span className="dot" />
                {k.toUpperCase()} {v.ok ? 'OK' : `— ${v.message}`}
              </div>
            ))}
            <p className="muted" style={{ marginTop: 16 }}>
              Next: in Cloudflare → Email Routing, add your support address and set the destination
              to the <code>ranse</code> Worker. Then send a test email.
            </p>
            <button className="primary" style={{ width: '100%' }} onClick={onDone}>
              Enter inbox
            </button>
          </>
        )}
      </div>
    </div>
  );
}
