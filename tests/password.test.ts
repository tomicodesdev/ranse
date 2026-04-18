import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash } from '../src/lib/password';

describe('password hashing', () => {
  it('rejects passwords shorter than 12 chars', async () => {
    await expect(hashPassword('short')).rejects.toThrow('password_too_short');
  });

  it('hashes to the pbkdf2 versioned format', async () => {
    const stored = await hashPassword('correct-horse-battery');
    const parts = stored.split('$');
    expect(parts[0]).toBe('pbkdf2');
    expect(Number(parts[1])).toBeGreaterThanOrEqual(600_000);
    expect(parts).toHaveLength(4);
  });

  it('verifies the correct password', async () => {
    const stored = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-battery', stored)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('wrong-password-123', stored)).toBe(false);
  });

  it('produces a different hash for the same password due to random salt', async () => {
    const a = await hashPassword('correct-horse-battery');
    const b = await hashPassword('correct-horse-battery');
    expect(a).not.toEqual(b);
  });

  it('verifies the legacy sha256 format (migration path)', async () => {
    // Pre-0.2 hashes look like `<saltHex>:<sha256Hex>`
    // matching `sha256Hex(saltHex + ':' + password)`.
    const salt = 'a'.repeat(32);
    const password = 'legacy-password-123';
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${salt}:${password}`),
    );
    const hashHex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const stored = `${salt}:${hashHex}`;

    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
    expect(needsRehash(stored)).toBe(true);
  });

  it('signals needsRehash=false for fresh hashes', async () => {
    const stored = await hashPassword('correct-horse-battery');
    expect(needsRehash(stored)).toBe(false);
  });
});
