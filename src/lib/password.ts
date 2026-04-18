/**
 * Password hashing using PBKDF2-HMAC-SHA256 (Web Crypto).
 *
 * Storage format: `pbkdf2$<iterations>$<saltB64>$<hashB64>`
 * The iteration count is embedded so we can raise it later and
 * transparently rehash on next login (see `needsRehash`).
 *
 * Target: OWASP 2023 minimum for PBKDF2-HMAC-SHA256 = 600_000 iterations.
 */

const CURRENT_ITERATIONS = 600_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  bytes: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    bytes * 8,
  );
  return new Uint8Array(derived);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('password_too_short');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, CURRENT_ITERATIONS, HASH_BYTES);
  return `pbkdf2$${CURRENT_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;

  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 100_000) return false;
    const salt = b64decode(parts[2]);
    const expected = b64decode(parts[3]);
    const check = await pbkdf2(password, salt, iterations, expected.length);
    return constantTimeEqual(expected, check);
  }

  // Legacy format: `<saltHex>:<sha256Hex>` — retained only to migrate pre-0.2 installs.
  if (stored.includes(':') && !stored.startsWith('pbkdf2$')) {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${saltHex}:${password}`),
    );
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (hex.length !== hashHex.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ hashHex.charCodeAt(i);
    return diff === 0;
  }

  return false;
}

export function needsRehash(stored: string): boolean {
  if (!stored.startsWith('pbkdf2$')) return true;
  const iters = parseInt(stored.split('$')[1] ?? '0', 10);
  return !Number.isFinite(iters) || iters < CURRENT_ITERATIONS;
}
