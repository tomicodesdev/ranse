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

type Step = 1 | 2 | 3 | 4;

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
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState('');
  const [checks, setChecks] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

  function next(to: Step) {
    setError('');
    setStep(to);
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
            {error && <div className="error">{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
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
