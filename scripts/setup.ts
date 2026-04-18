#!/usr/bin/env bun
/**
 * Local development setup — writes .dev.vars with localhost runtime-var
 * overrides and freshly generated random secrets. Runs only for local dev;
 * the Deploy-to-Cloudflare flow uses scripts/deploy.ts instead.
 *
 * Runtime vars that have defaults in wrangler.jsonc (APP_NAME,
 * LLM_DEFAULT_MODEL, CLOUDFLARE_AI_GATEWAY, CLOUDFLARE_AI_GATEWAY_URL)
 * are NOT redeclared here — wrangler dev reads them from wrangler.jsonc.
 */
import { existsSync, writeFileSync } from 'node:fs';

function randomHex(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

const path = '.dev.vars';
if (existsSync(path)) {
  console.log('.dev.vars already exists — leaving as-is.');
  process.exit(0);
}

const contents = `# Local dev overrides. Override runtime vars here; leave blank entries blank.
APP_URL=http://localhost:8787
ADMIN_EMAIL=you@example.com
SUPPORT_DOMAIN=support.example.com

# Secrets — generated now for this workstation only.
COOKIE_SIGNING_KEY=${randomHex(32)}
ADMIN_BOOTSTRAP_TOKEN=${randomHex(16)}

# LLM providers (BYOK). Add keys below to enable non-Workers-AI providers.
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_AI_STUDIO_API_KEY=
GROK_API_KEY=
OPENROUTER_API_KEY=

# Optional — gateway auth token if you enable authentication on the gateway.
CLOUDFLARE_AI_GATEWAY_TOKEN=
`;

writeFileSync(path, contents, { mode: 0o600 });
console.log(`✓ wrote ${path} with localhost overrides + generated secrets`);
console.log('  Next: bun run db:migrate:local && bun run dev');
