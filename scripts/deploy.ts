#!/usr/bin/env bun
/**
 * Ranse deploy orchestrator. Runs under `bun scripts/deploy.ts`.
 *
 * Cloudflare's Deploy-to-Cloudflare button invokes the npm "deploy" script
 * with CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID injected, plus
 * WRANGLER_CI_OVERRIDE_NAME = the Worker script name the user picked. The
 * Deploy button auto-provisions resources (D1, KV, R2, queues) on the very
 * first deploy and prefixes them with the Worker name; subsequent
 * Workers Builds runs do NOT auto-provision, so this script does the
 * equivalent work itself, idempotently:
 *
 *   1. Validate required env.
 *   2. Resolve effective Worker name from WRANGLER_CI_OVERRIDE_NAME (or
 *      WORKER_NAME, or wrangler.jsonc `name`).
 *   3. Look up / create D1, KV, R2, queues using `${workerName}-{kind}`.
 *   4. Write a deploy-time wrangler.deploy.jsonc with real IDs + final names.
 *   5. Build, then `wrangler deploy --config wrangler.deploy.jsonc`.
 *   6. Apply D1 migrations, push secrets.
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import Cloudflare from 'cloudflare';

const SECRET_KEYS = [
  'COOKIE_SIGNING_KEY',
  'ADMIN_SETUP_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_AI_STUDIO_API_KEY',
  'GROK_API_KEY',
  'OPENROUTER_API_KEY',
  'CEREBRAS_API_KEY',
];

const DEPLOY_CONFIG_PATH = 'wrangler.deploy.jsonc';

function run(cmd: string, opts: { allowFail?: boolean } = {}) {
  console.log(`\n$ ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    if (!opts.allowFail) throw err;
    console.warn(`(non-fatal) ${(err as Error).message}`);
  }
}

/** Values we refuse to accept as real secrets — anyone hitting the Deploy
 * button should never end up with these in production. */
const PLACEHOLDER_PATTERNS = [
  /^change-me/i,
  /^your-/i,
  /^replace-/i,
  /placeholder/i,
  /example\.com/i,
  /^todo/i,
];

function looksLikePlaceholder(value: string): boolean {
  if (!value) return true;
  if (value.length < 16) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

/**
 * Ensure the named AI Gateway exists for this account. Mirrors vibesdk's
 * ensureAIGateway(): probes with a GET, 404-tolerant, creates on miss. The
 * gateway is what `env.AI.gateway(name)` resolves against at runtime.
 */
async function ensureAIGateway(
  cf: Cloudflare,
  accountId: string,
  gatewayName: string,
): Promise<'exists' | 'created' | 'skipped'> {
  const id = gatewayName.slice(0, 64);
  try {
    await cf.aiGateway.get(id, { account_id: accountId });
    console.log(`  · AI Gateway "${id}" already exists`);
    return 'exists';
  } catch (err: any) {
    if (err?.status !== 404) {
      console.warn(`  · AI Gateway probe failed (non-fatal): ${err?.message ?? err}`);
      return 'skipped';
    }
  }
  try {
    await cf.aiGateway.create({
      account_id: accountId,
      id,
      cache_invalidate_on_update: true,
      cache_ttl: 3600,
      collect_logs: true,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
      rate_limiting_technique: 'sliding',
      authentication: false,
    });
    console.log(`  · AI Gateway "${id}" created`);
    return 'created';
  } catch (err: any) {
    console.warn(`  · AI Gateway create failed (non-fatal): ${err?.message ?? err}`);
    return 'skipped';
  }
}

async function ensureD1(cf: Cloudflare, accountId: string, name: string): Promise<string> {
  for await (const db of cf.d1.database.list({ account_id: accountId })) {
    if (db.name === name && db.uuid) {
      console.log(`  · D1 "${name}" exists (uuid: ${db.uuid})`);
      return db.uuid;
    }
  }
  const created = await cf.d1.database.create({ account_id: accountId, name });
  if (!created.uuid) throw new Error(`D1 create returned no uuid for "${name}"`);
  console.log(`  · D1 "${name}" created (uuid: ${created.uuid})`);
  return created.uuid;
}

async function ensureKV(cf: Cloudflare, accountId: string, title: string): Promise<string> {
  for await (const ns of cf.kv.namespaces.list({ account_id: accountId })) {
    if (ns.title === title) {
      console.log(`  · KV "${title}" exists (id: ${ns.id})`);
      return ns.id;
    }
  }
  const created = await cf.kv.namespaces.create({ account_id: accountId, title });
  console.log(`  · KV "${title}" created (id: ${created.id})`);
  return created.id;
}

async function ensureR2(cf: Cloudflare, accountId: string, name: string): Promise<void> {
  const list = await cf.r2.buckets.list({ account_id: accountId });
  if (list.buckets?.some((b) => b.name === name)) {
    console.log(`  · R2 bucket "${name}" exists`);
    return;
  }
  await cf.r2.buckets.create({ account_id: accountId, name });
  console.log(`  · R2 bucket "${name}" created`);
}

async function ensureQueue(cf: Cloudflare, accountId: string, queueName: string): Promise<void> {
  for await (const q of cf.queues.list({ account_id: accountId })) {
    if (q.queue_name === queueName) {
      console.log(`  · Queue "${queueName}" exists`);
      return;
    }
  }
  await cf.queues.create({ account_id: accountId, queue_name: queueName });
  console.log(`  · Queue "${queueName}" created`);
}

function generateIfMissing(key: string): void {
  const existing = process.env[key];
  if (existing && !looksLikePlaceholder(existing)) return;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  process.env[key] = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  console.log(
    existing
      ? `  · regenerated ${key} (prefilled value looked like a placeholder)`
      : `  · generated ${key} (random 32-byte hex)`,
  );
}

/**
 * Worker name source order:
 *   1. WRANGLER_CI_OVERRIDE_NAME — set by Workers Builds CI to the script
 *      name the user picked at Deploy-to-Cloudflare time.
 *   2. WORKER_NAME — manual override for self-hosted CI / local prod deploys.
 *   3. wrangler.jsonc `name` — the OSS template default.
 */
function resolveWorkerName(templateName: string): string {
  return (
    process.env.WRANGLER_CI_OVERRIDE_NAME ||
    process.env.WORKER_NAME ||
    templateName
  );
}

/**
 * Provision missing resources, then write a deploy-time wrangler.deploy.jsonc
 * with real IDs + Worker-name-prefixed resource names.
 *
 * Naming rule: every resource that uses the template's worker-name prefix
 * (`{templateName}-...`) gets rewritten to `{workerName}-...`. Resources
 * without that prefix are left alone.
 */
async function provisionAndPatchConfig(
  cf: Cloudflare,
  accountId: string,
  workerName: string,
): Promise<{ configPath: string; dbName?: string }> {
  const wrangler = parseJsonc(readFileSync('wrangler.jsonc', 'utf8')) as any;
  const templateName: string = wrangler.name;
  const sub = (s: string) =>
    s.startsWith(`${templateName}-`)
      ? `${workerName}-${s.slice(templateName.length + 1)}`
      : s === templateName
        ? workerName
        : s;

  let dbName: string | undefined;
  for (const db of (wrangler.d1_databases ?? []) as any[]) {
    db.database_name = sub(db.database_name);
    db.database_id = await ensureD1(cf, accountId, db.database_name);
    dbName = db.database_name;
  }

  // KV: the template puts a friendly placeholder in `id` (e.g. "ranse-cache").
  // We treat that as the namespace title, look up / create, then store the
  // real namespace id back into `id` for wrangler.
  for (const kv of (wrangler.kv_namespaces ?? []) as any[]) {
    const title = sub(kv.id);
    kv.id = await ensureKV(cf, accountId, title);
  }

  for (const r2 of (wrangler.r2_buckets ?? []) as any[]) {
    r2.bucket_name = sub(r2.bucket_name);
    await ensureR2(cf, accountId, r2.bucket_name);
  }

  for (const p of (wrangler.queues?.producers ?? []) as any[]) {
    p.queue = sub(p.queue);
    await ensureQueue(cf, accountId, p.queue);
  }
  for (const c of (wrangler.queues?.consumers ?? []) as any[]) {
    c.queue = sub(c.queue);
  }

  wrangler.name = workerName;

  writeFileSync(DEPLOY_CONFIG_PATH, JSON.stringify(wrangler, null, 2));
  console.log(`  · Wrote ${DEPLOY_CONFIG_PATH} (worker name: ${workerName})`);
  return { configPath: DEPLOY_CONFIG_PATH, dbName };
}

async function main() {
  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.error('CLOUDFLARE_API_TOKEN is required.');
    process.exit(1);
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error('CLOUDFLARE_ACCOUNT_ID is required.');
    process.exit(1);
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const cf = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });

  console.log('· Ensuring AI Gateway');
  // Gateway name is hardcoded in src/llm/core.ts (GATEWAY_NAME) — keep the
  // literal in sync here.
  await ensureAIGateway(cf, accountId, 'ranse');

  const templateConfig = parseJsonc(readFileSync('wrangler.jsonc', 'utf8')) as any;
  const workerName = resolveWorkerName(templateConfig.name);
  console.log(`· Provisioning resources for Worker "${workerName}"`);
  const { configPath, dbName } = await provisionAndPatchConfig(cf, accountId, workerName);

  console.log('· Preparing deploy-time secrets');
  generateIfMissing('COOKIE_SIGNING_KEY');
  generateIfMissing('ADMIN_SETUP_TOKEN');

  const secretsPresent = SECRET_KEYS.filter((k) => process.env[k]);
  const prodVarsPath = '.prod.vars';
  writeFileSync(
    prodVarsPath,
    `${secretsPresent.map((k) => `${k}=${process.env[k]}`).join('\n')}\n`,
    { mode: 0o600 },
  );
  console.log(`· Wrote ${prodVarsPath} with ${secretsPresent.length} keys`);

  if (existsSync('package.json') && existsSync('index.html')) {
    run('bun run build');
  }

  run(`wrangler deploy --config ${configPath}`);

  if (dbName) {
    run(`wrangler d1 migrations apply ${dbName} --config ${configPath} --remote`, {
      allowFail: false,
    });
  }

  if (secretsPresent.length > 0) {
    run(`wrangler secret bulk ${prodVarsPath} --config ${configPath}`);
  }

  const setupToken = process.env.ADMIN_SETUP_TOKEN ?? '';
  const bar = '━'.repeat(72);
  console.log(`\n${bar}`);
  console.log('  ✓ DEPLOY COMPLETE — SAVE THIS VALUE NOW');
  console.log(bar);
  console.log('\n  ADMIN_SETUP_TOKEN (one-time use at /setup):\n');
  console.log(`    ${setupToken}\n`);
  console.log('  You will NOT be able to retrieve this from the dashboard later');
  console.log('  (Cloudflare secrets are write-only). If you lose it, rotate it:\n');
  console.log('    wrangler secret put ADMIN_SETUP_TOKEN\n');
  console.log('  Then visit the Worker URL and finish the /setup wizard.');
  console.log(`${bar}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
