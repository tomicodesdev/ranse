-- Migration number: 0005 	 2026-05-03T11:00:00.000Z

-- Per-workspace notification channels. Subscribers fan out events
-- (ticket.created, message.inbound, etc.) to channels (email, slack)
-- via the WEBHOOKS queue. Adding a new channel kind or event type
-- doesn't require schema changes — `kind` and `events` are free-form.
CREATE TABLE IF NOT EXISTS notification_channel (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notif_workspace_enabled
  ON notification_channel(workspace_id, enabled);
