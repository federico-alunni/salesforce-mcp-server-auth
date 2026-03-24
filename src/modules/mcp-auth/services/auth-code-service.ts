// ============================================================================
// Module A — Authorization Code Service
// Manages short-lived authorization codes for the OAuth 2.0 PKCE flow.
// ============================================================================

import { randomBytes, createHash } from 'crypto';
import type { AuthorizationCodeRecord } from '../../../types/index.js';
import { mcpAuth } from '../../../shared/config/index.js';
import { logger } from '../../../shared/logger.js';

// In-memory store — codes are very short-lived (5 min default).
// For multi-instance deployments, replace with Redis or DB.
const codes = new Map<string, AuthorizationCodeRecord>();

export function generateAuthorizationCode(params: {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scopes: string[];
}): string {
  const code = randomBytes(32).toString('hex');
  const record: AuthorizationCodeRecord = {
    code,
    userId: params.userId,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    scopes: params.scopes,
    expiresAt: Date.now() + mcpAuth.authCodeTTL * 1000,
  };
  codes.set(code, record);
  logger.debug(`Generated auth code for user=${params.userId} client=${params.clientId}`);
  return code;
}

export function redeemAuthorizationCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string,
): AuthorizationCodeRecord | null {
  const record = codes.get(code);
  if (!record) {
    logger.debug('Auth code not found');
    return null;
  }

  // Single use
  codes.delete(code);

  // Check expiry
  if (record.expiresAt < Date.now()) {
    logger.debug('Auth code expired');
    return null;
  }

  // Validate client_id
  if (record.clientId !== clientId) {
    logger.debug('Auth code client_id mismatch');
    return null;
  }

  // Validate redirect_uri
  if (record.redirectUri !== redirectUri) {
    logger.debug('Auth code redirect_uri mismatch');
    return null;
  }

  // Validate PKCE
  if (!verifyCodeChallenge(codeVerifier, record.codeChallenge, record.codeChallengeMethod)) {
    logger.debug('Auth code PKCE verification failed');
    return null;
  }

  return record;
}

function verifyCodeChallenge(verifier: string, challenge: string, method: string): boolean {
  if (method === 'S256') {
    const computed = createHash('sha256').update(verifier).digest('base64url');
    return computed === challenge;
  }
  if (method === 'plain') {
    return verifier === challenge;
  }
  return false;
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of codes.entries()) {
    if (record.expiresAt < now) codes.delete(key);
  }
}, 60_000);
