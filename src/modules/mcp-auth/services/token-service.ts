// ============================================================================
// Module A — Token Service
// Issues and validates local JWTs for MCP client sessions.
// ============================================================================

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { mcpAuth } from '../../../shared/config/index.js';
import type { ITokenService, LocalPrincipal, McpTokenRecord } from '../../../types/index.js';
import { logger } from '../../../shared/logger.js';

// ---------------------------------------------------------------------------
// Minimal JWT implementation using HMAC-SHA256 (HS256)
// No external dependency needed for symmetric JWTs.
// ---------------------------------------------------------------------------

function base64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

function sign(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const signature = createHmac('sha256', getSecret()).update(data).digest();
  return `${data}.${base64url(signature)}`;
}

function verify(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const data = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', getSecret()).update(data).digest();
  const actual = base64urlDecode(parts[2]);

  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(base64urlDecode(parts[1]).toString());

    // Check expiry
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    // Check issuer
    if (payload.iss !== mcpAuth.jwtIssuer) return null;

    return payload;
  } catch {
    return null;
  }
}

function getSecret(): string {
  if (!mcpAuth.jwtSecret) {
    throw new Error('MCP_JWT_SECRET is not configured. Set it to a random string of at least 32 characters.');
  }
  return mcpAuth.jwtSecret;
}

// ---------------------------------------------------------------------------
// Refresh token store — opaque tokens with rotating strategy
// ---------------------------------------------------------------------------

interface RefreshTokenRecord {
  userId: string;
  scopes: string[];
  expiresAt: number;
}

const refreshTokens = new Map<string, RefreshTokenRecord>();

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of refreshTokens.entries()) {
    if (record.expiresAt < now) refreshTokens.delete(key);
  }
}, 300_000);

// ---------------------------------------------------------------------------
// Public API — implements ITokenService
// ---------------------------------------------------------------------------

export const tokenService: ITokenService = {
  async generateAccessToken(userId: string, scopes: string[]): Promise<string> {
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      jti,
      sub: userId,
      iss: mcpAuth.jwtIssuer,
      aud: mcpAuth.jwtAudience,
      iat: now,
      exp: now + mcpAuth.accessTokenTTL,
      scope: scopes.join(' '),
    };
    const jwt = sign(payload);
    logger.debug(`Issued local access token jti=${jti} for user=${userId}`);
    return jwt;
  },

  async validateAccessToken(token: string): Promise<LocalPrincipal | null> {
    const payload = verify(token);
    if (!payload) return null;

    return {
      userId: payload.sub as string,
      sessionId: payload.jti as string,
      scopes: typeof payload.scope === 'string' ? (payload.scope as string).split(' ') : [],
    };
  },

  async generateRefreshToken(userId: string, scopes: string[]): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + mcpAuth.refreshTokenTTL * 1000;
    refreshTokens.set(token, { userId, scopes, expiresAt });
    logger.debug(`Issued refresh token for user=${userId}`);
    return token;
  },

  async validateRefreshToken(token: string): Promise<{ userId: string; scopes: string[] } | null> {
    const record = refreshTokens.get(token);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      refreshTokens.delete(token);
      return null;
    }
    // Rotate: invalidate old token on use
    refreshTokens.delete(token);
    return { userId: record.userId, scopes: record.scopes };
  },
};
