import { useEffect, useState } from 'react';
import { API, ApiRequestError } from '../api';

type Meta = Awaited<ReturnType<typeof API.notificationsMeta>>;
type ChannelMeta = Meta['channels'][number];
type EventMeta = Meta['events'][number];
type Channel = Awaited<ReturnType<typeof API.listNotificationChannels>>['channels'][number];

interface Props {
  onSaved: () => void;
}

export function NotificationsSection({ onSaved }: Props) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const [m, c] = await Promise.all([
      API.notificationsMeta(),
      API.listNotificationChannels(),
    ]);
    setMeta(m);
    setChannels(c.channels);
  }
  useEffect(() => { load(); }, []);

  if (!meta) return null;

  return (
    <>
      <h2>Notifications</h2>
      <div className="card">
        <p className="muted" style={{ marginBottom: 12 }}>
          Send a notification when something happens in your inbox. Add as many channels as you like — each can subscribe to its own set of events.
        </p>

        {channels.length === 0 && !adding && (
          <div className="muted" style={{ fontSize: 13, padding: '12px 0' }}>
            No channels yet. Add one to start receiving notifications.
          </div>
        )}

        {channels.map((ch) => (
          <ChannelRow
            key={ch.id}
            channel={ch}
            meta={meta}
            onChange={async (updates) => {
              await API.updateNotificationChannel(ch.id, updates);
              await load();
              onSaved();
            }}
            onDelete={async () => {
              if (!confirm('Delete this notification channel?')) return;
              await API.deleteNotificationChannel(ch.id);
              await load();
            }}
            onTest={async () => {
              setError('');
              try {
                await API.testNotificationChannel(ch.id);
                onSaved();
              } catch (e) {
                setError(e instanceof ApiRequestError ? e.message : String(e));
              }
            }}
          />
        ))}

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

        {adding ? (
          <AddChannelForm
            meta={meta}
            onCancel={() => setAdding(false)}
            onSave={async (body) => {
              await API.createNotificationChannel(body);
              setAdding(false);
              await load();
              onSaved();
            }}
          />
        ) : (
          <button style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
            + Add channel
          </button>
        )}
      </div>
    </>
  );
}

function ChannelRow({
  channel,
  meta,
  onChange,
  onDelete,
  onTest,
}: {
  channel: Channel;
  meta: Meta;
  onChange: (u: { enabled?: boolean; events?: string[] }) => Promise<void>;
  onDelete: () => Promise<void>;
  onTest: () => Promise<void>;
}) {
  const handler = meta.channels.find((c) => c.kind === channel.kind);
  return (
    <div className="setting-row">
      <div className="setting-info">
        <div className="setting-label">
          {handler?.label ?? channel.kind}
          <span className="muted" style={{ fontSize: 12, marginLeft: 8, fontWeight: 400 }}>
            {channel.target}
          </span>
        </div>
        <div className="setting-desc" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
          {meta.events.map((ev) => {
            const subscribed = channel.events.includes(ev.name);
            return (
              <label
                key={ev.name}
                className="pill"
                style={{
                  cursor: 'pointer',
                  background: subscribed ? 'var(--accent-soft)' : 'var(--bg-hover)',
                  color: subscribed ? 'var(--accent)' : 'var(--text-muted)',
                  textTransform: 'none',
                  letterSpacing: 0,
                }}
                title={ev.description}
              >
                <input
                  type="checkbox"
                  checked={subscribed}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...channel.events, ev.name]
                      : channel.events.filter((n) => n !== ev.name);
                    if (next.length === 0) {
                      alert('A channel must subscribe to at least one event.');
                      return;
                    }
                    onChange({ events: next });
                  }}
                />
                {ev.name}
              </label>
            );
          })}
        </div>
      </div>
      <div className="setting-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={onTest} title="Send a test notification">Test</button>
        <button onClick={onDelete} className="danger">Delete</button>
        <input
          type="checkbox"
          checked={channel.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
          title={channel.enabled ? 'Enabled' : 'Disabled'}
        />
      </div>
    </div>
  );
}

function AddChannelForm({
  meta,
  onCancel,
  onSave,
}: {
  meta: Meta;
  onCancel: () => void;
  onSave: (body: { kind: string; target: string; events: string[]; label?: string }) => Promise<void>;
}) {
  const [kind, setKind] = useState<string>(meta.channels[0]?.kind ?? '');
  const [target, setTarget] = useState('');
  const [events, setEvents] = useState<string[]>(meta.events.map((e) => e.name));
  const [error, setError] = useState('');
  const handler = meta.channels.find((c) => c.kind === kind) as ChannelMeta | undefined;

  return (
    <div style={{ marginTop: 16, padding: 16, border: '1px dashed var(--border)', borderRadius: 8 }}>
      <div className="field">
        <label>Channel type</label>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {meta.channels.map((c) => (
            <option key={c.kind} value={c.kind}>{c.label} — {c.description}</option>
          ))}
        </select>
      </div>
      {handler && (
        <div className="field">
          <label>{handler.targetLabel}</label>
          <input
            type="text"
            value={target}
            placeholder={handler.targetPlaceholder}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
      )}
      <div className="field">
        <label>Events to deliver</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {meta.events.map((ev: EventMeta) => (
            <label key={ev.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={events.includes(ev.name)}
                onChange={(e) => {
                  setEvents((prev) =>
                    e.target.checked ? [...prev, ev.name] : prev.filter((n) => n !== ev.name),
                  );
                }}
                style={{ marginTop: 3 }}
              />
              <div>
                <div style={{ fontWeight: 500 }}>{ev.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>{ev.description}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
      {error && <div className="error" style={{ marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="primary"
          onClick={async () => {
            setError('');
            if (!target.trim()) {
              setError('Target is required.');
              return;
            }
            if (events.length === 0) {
              setError('Pick at least one event.');
              return;
            }
            try {
              await onSave({ kind, target: target.trim(), events });
            } catch (e: any) {
              setError(e?.message ?? 'Failed to save.');
            }
          }}
        >
          Save channel
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
