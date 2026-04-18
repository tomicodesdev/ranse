# Installation

There are two supported install paths: **one-click deploy** (recommended) and **manual Wrangler**.

## Path A — One-click deploy

1. Click the **Deploy to Cloudflare** button in the README. Cloudflare will:
   - Fork the Ranse repo into your GitHub.
   - Create a new Worker in your Cloudflare account.
   - Provision D1, R2, KV, Queues, and Durable Objects from `wrangler.jsonc`.
   - Prompt you for the variables declared with empty-string defaults.
2. Fill in the prompts:
   - `APP_URL` — leave blank on first deploy; update after you know the Worker URL.
   - `ADMIN_EMAIL` — your admin account email.
   - `SUPPORT_DOMAIN` — the domain you'll use for support email.
   - `CLOUDFLARE_API_TOKEN` — build-time token Cloudflare auto-injects; leave as-is.
3. Cloudflare runs `bun run deploy` which:
   - Generates `COOKIE_SIGNING_KEY` and `ADMIN_BOOTSTRAP_TOKEN` if not set.
   - Builds the React console (`vite build`).
   - Applies D1 migrations.
   - Pushes Worker secrets in bulk.
4. Open your Worker URL. You'll be redirected to `/setup`.

### After deploy

- Grab `ADMIN_BOOTSTRAP_TOKEN` from Cloudflare → your Worker → Settings → Variables and Secrets. **You need it once** to create the first admin.
- Finish the `/setup` wizard (admin account → mailbox → verification).

## Path B — Manual Wrangler

```bash
git clone https://github.com/tomicodesdev/ranse.git
cd ranse
bun install
bun run setup                 # generates .dev.vars
bun run db:migrate:local
bun run dev
```

For production:

```bash
# in .prod.vars, fill in your API keys
export CLOUDFLARE_API_TOKEN=...
bun run deploy
```

## Email onboarding

Ranse **deploys** in one click but email still requires a short guided step:

1. In the Cloudflare dashboard, go to **Email** → **Email Routing**.
2. Add your domain (e.g. `acme.com`) if not already configured. Verify the required DNS records (MX + SPF).
3. Add a **custom address**: `support@acme.com`.
4. Set the **action** to **Send to a Worker** and pick the `ranse` Worker.
5. Add the mailbox in Ranse's `/setup` wizard using the same address.

## Verification checklist

The `/setup` wizard runs these checks automatically after you add a mailbox:

- [x] D1 reachable
- [x] R2 write + delete works
- [x] KV write works
- [x] AI binding answers a test prompt
- [x] At least one mailbox configured

If any check fails, fix it before going live — the wizard blocks completion.

## Troubleshooting

**"invalid_bootstrap_token"** — double-check the value from your Worker's secrets; it's a one-time use.

**Email arrives but no ticket appears** — check Worker logs. Confirm the `support@` address is routed to the `ranse` Worker. Confirm the same address is registered as a mailbox in Ranse.

**LLM calls fail** — without any provider API keys and without the `AI` binding configured, the triage/draft specialists will throw. Either:
- use the default Workers AI path (leave `LLM_DEFAULT_MODEL` on a `workers-ai/*` model), or
- add a provider key in **Settings → LLM providers (BYOK)**.

**AI Gateway** — `scripts/deploy.ts` ensures an AI Gateway named `ranse` exists in your account (creates it with cache_ttl=3600, logs on, no rate limits by default). No manual step needed. To disable: set `CLOUDFLARE_AI_GATEWAY` to an empty string in `wrangler.jsonc` vars — the LLM dispatcher then falls back to direct provider URLs.
