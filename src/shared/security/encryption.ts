// ============================================================================
// Token encryption at rest — AES-256-GCM
// ============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { storage } from '../config/index.js';
import { logger } from '../logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = storage.encryptionKey;
  if (!hex || hex.length !== 64) {
    logger.warn('MCP_ENCRYPTION_KEY not set or invalid (need 64 hex chars). Tokens will be stored in plaintext.');
    return Buffer.alloc(0);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string. Returns a base64 blob: iv + authTag + ciphertext.
 * If no encryption key is configured, returns the plaintext prefixed with "plain:".
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  if (key.length === 0) return `plain:${plaintext}`;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypt a blob produced by `encrypt()`.
 */
export function decrypt(blob: string): string {
  if (blob.startsWith('plain:')) return blob.slice(6);

  const key = getKey();
  if (key.length === 0) throw new Error('Cannot decrypt: MCP_ENCRYPTION_KEY is not configured');

  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
