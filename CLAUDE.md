# Ranse — contributor notes

## Migrations

New migrations use a **timestamp prefix**, not a sequential counter:

```
YYYYMMDD_HHMMSS_<short_name>.sql
```

Example: `20260503_120000_notification_channels.sql`.

Why: `wrangler d1` sorts the `migrations/` directory alphabetically and applies anything not in the `d1_migrations` tracking table — it doesn't care about the format. Sequential numbering (`0004_`, `0005_`, ...) silently breaks when two contributors land migrations on parallel branches with the same number. Timestamps remove the collision.

Old migrations (`0001_init.sql` through `0005_notification_channels.sql`) stay as-is — `0` < `2` alphabetically, so old + new sort correctly together. **Don't rename applied migrations** — `wrangler` keys the tracking table on filename, so a rename re-runs the migration under the new name.

Create with `wrangler d1 migrations create ranse-db <name>`, then **rename the generated `0006_<name>.sql` to the timestamp form** before committing.
