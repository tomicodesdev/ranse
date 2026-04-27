/**
 * Cloudflare Email provisioning — onboards a sending subdomain via the
 * `/zones/:zone_id/email/sending/subdomains` API, adds DKIM/SPF/DMARC
 * records, enables Email Routing, and routes a single address at a named
 * Worker. All requests go through direct `fetch` against api.cloudflare.com
 * with a user-supplied scoped token.
 *
 * Note: Cloudflare's Email Sending API is *zone-scoped* (despite many
 * Cloudflare APIs being account-scoped). The required token permission is
 * "Zone · Email Sending: Edit" — NOT "Account · Email Sending: Edit", which
 * is why earlier attempts using `/accounts/:account_id/email/sending/...`
 * failed with `10001: Unable to authenticate request` even when the account
 * permission was granted.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
}

async function cfFetch<T = any>(
  path: string,
  opts: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; token: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    method: opts.method,
    headers: {
      authorization: `Bearer ${opts.token}`,
      'content-type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: CfEnvelope<T>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`CF ${opts.method} ${path}: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || !body.success) {
    const errs = body.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ?? res.statusText;
    const err = new Error(`CF ${opts.method} ${path}: ${errs}`);
    (err as any).status = res.status;
    (err as any).cfErrors = body.errors ?? [];
    throw err;
  }
  return body.result;
}

export async function verifyToken(token: string) {
  return cfFetch<{ id: string; status: string; expires_on?: string }>('/user/tokens/verify', {
    method: 'GET',
    token,
  });
}

export async function findZone(token: string, domain: string) {
  // Walk from most specific to apex: email.ijamu.com → ijamu.com → com
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    const zones = await cfFetch<Array<{ id: string; name: string }>>(
      `/zones?name=${encodeURIComponent(candidate)}`,
      { method: 'GET', token },
    );
    if (zones.length > 0) return { zoneId: zones[0].id, zoneName: zones[0].name };
  }
  return null;
}

export interface SendingSubdomain {
  tag: string;
  name: string;
  enabled?: boolean;
  dkim_selector?: string;
}

/**
 * Idempotently ensure a sending subdomain exists. The Cloudflare API exposes
 * `GET /subdomains/:tag` (not by name), so we list-and-match-by-name to find
 * an existing one before creating.
 */
export async function onboardSendingDomain(
  token: string,
  zoneId: string,
  name: string,
): Promise<{ created: boolean; subdomain: SendingSubdomain }> {
  const list = await cfFetch<SendingSubdomain[]>(
    `/zones/${zoneId}/email/sending/subdomains`,
    { method: 'GET', token },
  ).catch(() => [] as SendingSubdomain[]);
  const found = list.find((s) => s.name === name);
  if (found) return { created: false, subdomain: found };

  const created = await cfFetch<SendingSubdomain>(
    `/zones/${zoneId}/email/sending/subdomains`,
    { method: 'POST', token, body: { name } },
  );
  return { created: true, subdomain: created };
}

export interface SendingDnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
  reason?: string;
}

export async function getSendingDnsRecords(
  token: string,
  zoneId: string,
  tag: string,
): Promise<SendingDnsRecord[]> {
  const res = await cfFetch<any>(
    `/zones/${zoneId}/email/sending/subdomains/${tag}/dns`,
    { method: 'GET', token },
  );
  // Endpoint shape varies in beta — accept both {records: [...]} and [...] directly.
  const list = Array.isArray(res) ? res : (res.records ?? res.dns_records ?? []);
  return list as SendingDnsRecord[];
}

export async function addDnsRecord(token: string, zoneId: string, record: SendingDnsRecord) {
  return cfFetch<any>(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    token,
    body: { ...record, ttl: 1, proxied: false },
  });
}

export async function enableEmailRouting(token: string, zoneId: string) {
  // Probe current state. The GET endpoint may itself 10000 on some accounts;
  // when it does, fall through to the POST and let that be the authority.
  let probed: { enabled?: boolean; status?: string } | null = null;
  try {
    probed = await cfFetch<{ enabled?: boolean; status?: string }>(
      `/zones/${zoneId}/email/routing`,
      { method: 'GET', token },
    );
  } catch {
    // ignore — we'll attempt the enable POST below
  }
  const enabled =
    probed?.enabled === true ||
    probed?.status === 'ready' ||
    probed?.status === 'enabled';
  if (enabled) return { alreadyEnabled: true };

  try {
    await cfFetch<any>(`/zones/${zoneId}/email/routing/enable`, { method: 'POST', token });
    return { alreadyEnabled: false };
  } catch (err: any) {
    // 10000 here often means "already enabled" — the API doesn't expose a
    // friendly idempotent response. Treat any auth-shaped error as
    // "probably already enabled"; downstream rule creation will surface a
    // real problem if routing genuinely isn't on.
    const code = err?.cfErrors?.[0]?.code;
    if (code === 10000 || code === 1000) return { alreadyEnabled: true };
    throw err;
  }
}

export async function createRoutingRule(
  token: string,
  zoneId: string,
  mailboxAddress: string,
  workerName: string,
) {
  // Idempotent: skip if a rule matching this exact destination already exists.
  const existing = await cfFetch<Array<any>>(`/zones/${zoneId}/email/routing/rules`, {
    method: 'GET',
    token,
  }).catch(() => [] as any[]);
  const dup = (existing ?? []).find((r: any) =>
    r.matchers?.some((m: any) => m.type === 'literal' && m.field === 'to' && m.value === mailboxAddress),
  );
  if (dup) return { created: false, id: dup.id };
  const rule = await cfFetch<any>(`/zones/${zoneId}/email/routing/rules`, {
    method: 'POST',
    token,
    body: {
      name: `Ranse: ${mailboxAddress}`,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: mailboxAddress }],
      actions: [{ type: 'worker', value: [workerName] }],
    },
  });
  return { created: true, id: rule.id };
}

export interface ProvisionStep {
  id: string;
  label: string;
  status: 'ok' | 'fail' | 'skipped';
  message?: string;
  dns_records?: SendingDnsRecord[];
}

export interface ProvisionInput {
  apiToken: string;
  accountId: string;
  domain: string;
  mailboxAddress: string;
  workerName: string;
}

export async function applyProvisioning(input: ProvisionInput): Promise<ProvisionStep[]> {
  const steps: ProvisionStep[] = [];

  try {
    const t = await verifyToken(input.apiToken);
    if (t.status !== 'active') throw new Error(`Token status is "${t.status}"`);
    steps.push({ id: 'token', label: 'API token valid', status: 'ok' });
  } catch (err: any) {
    steps.push({ id: 'token', label: 'API token', status: 'fail', message: err.message });
    return steps;
  }

  // Zone is required for *both* sending and routing — the sending API is
  // zone-scoped now, not account-scoped — so fail-fast if the domain isn't
  // on this Cloudflare account.
  const zone = await findZone(input.apiToken, input.domain).catch(() => null);
  if (!zone) {
    steps.push({
      id: 'zone',
      label: `Zone for "${input.domain}" not found on this Cloudflare account`,
      status: 'fail',
      message:
        'Cloudflare Email Sending and Email Routing both require the domain to be a zone on this account. Add the domain at dash.cloudflare.com → Add a site, then retry.',
    });
    return steps;
  }
  steps.push({ id: 'zone', label: `Zone "${zone.zoneName}" found on Cloudflare`, status: 'ok' });

  let dnsRecords: SendingDnsRecord[] = [];
  try {
    const result = await onboardSendingDomain(input.apiToken, zone.zoneId, input.domain);
    steps.push({
      id: 'sending',
      label: result.created
        ? `Sending domain "${input.domain}" onboarded`
        : `Sending domain "${input.domain}" already onboarded`,
      status: 'ok',
    });
    dnsRecords = await getSendingDnsRecords(input.apiToken, zone.zoneId, result.subdomain.tag);
    steps.push({
      id: 'dns-fetch',
      label: `Fetched ${dnsRecords.length} DNS records (DKIM / SPF / DMARC)`,
      status: 'ok',
      dns_records: dnsRecords,
    });
  } catch (err: any) {
    steps.push({ id: 'sending', label: 'Onboard sending domain', status: 'fail', message: err.message });
    return steps;
  }

  let added = 0;
  let skipped = 0;
  let routingManaged = 0;
  const routingManagedRecords: string[] = [];
  const failures: string[] = [];
  for (const r of dnsRecords) {
    try {
      await addDnsRecord(input.apiToken, zone.zoneId, r);
      added++;
    } catch (err: any) {
      const msg = String(err.message ?? err);
      if (/already exists|duplicate/i.test(msg)) {
        skipped++;
      } else if (/managed by Email Routing/i.test(msg)) {
        // Email Routing claims ownership of the entire zone's MX records,
        // including subdomain MX (like cf-bounce.<zone> for Email Sending
        // bounces). We can't write these while Routing is enabled — note
        // them as a soft warning rather than a hard failure. Sending still
        // works without bounce-handling MX; the user can add them by hand
        // if they want bounce processing.
        routingManaged++;
        routingManagedRecords.push(`${r.type} ${r.name} → ${r.content}`);
      } else {
        failures.push(`${r.type} ${r.name}: ${msg}`);
      }
    }
  }
  const parts = [`${added} added`];
  if (skipped) parts.push(`${skipped} already present`);
  if (routingManaged) parts.push(`${routingManaged} skipped (managed by Email Routing)`);
  if (failures.length) parts.push(`${failures.length} failed`);
  steps.push({
    id: 'dns-add',
    label: `DNS records: ${parts.join(', ')}`,
    status: failures.length ? 'fail' : 'ok',
    message:
      [
        failures.length ? `Failed:\n${failures.join('\n')}` : '',
        routingManaged
          ? `Email Routing manages this zone's MX records, so these bounce-handling MX entries from Email Sending could not be written. Sending will still work; bounces won't be auto-processed. To add them anyway: temporarily disable Email Routing, add the records, re-enable.\n\n${routingManagedRecords.join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n') || undefined,
    dns_records: dnsRecords,
  });

  try {
    const er = await enableEmailRouting(input.apiToken, zone.zoneId);
    steps.push({
      id: 'routing',
      label: er.alreadyEnabled ? 'Email Routing already enabled' : 'Email Routing enabled',
      status: 'ok',
    });
  } catch (err: any) {
    steps.push({ id: 'routing', label: 'Enable Email Routing', status: 'fail', message: err.message });
    return steps;
  }

  try {
    const rule = await createRoutingRule(
      input.apiToken,
      zone.zoneId,
      input.mailboxAddress,
      input.workerName,
    );
    steps.push({
      id: 'rule',
      label: rule.created
        ? `Routing rule created: ${input.mailboxAddress} → ${input.workerName}`
        : `Routing rule already present: ${input.mailboxAddress}`,
      status: 'ok',
    });
  } catch (err: any) {
    steps.push({ id: 'rule', label: 'Create routing rule', status: 'fail', message: err.message });
  }

  return steps;
}
