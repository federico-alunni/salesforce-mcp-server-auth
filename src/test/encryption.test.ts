// ============================================================================
// Tests — Encryption at rest
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';

process.env.MCP_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.MCP_LOG_LEVEL = 'ERROR';

describe('Encryption', async () => {
  const { encrypt, decrypt } = await import('../shared/security/encryption.js');

  it('should encrypt and decrypt a string', () => {
    const plaintext = 'my-secret-refresh-token-value';
    const encrypted = encrypt(plaintext);
    assert.notEqual(encrypted, plaintext);
    assert.ok(!encrypted.startsWith('plain:'));
    assert.equal(decrypt(encrypted), plaintext);
  });

  it('should produce different ciphertexts for same plaintext (random IV)', () => {
    const plaintext = 'same-value';
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    assert.notEqual(a, b);
    assert.equal(decrypt(a), plaintext);
    assert.equal(decrypt(b), plaintext);
  });

  it('should handle empty string', () => {
    assert.equal(decrypt(encrypt('')), '');
  });

  it('should handle long strings', () => {
    const long = 'x'.repeat(10000);
    assert.equal(decrypt(encrypt(long)), long);
  });
});
