import express from "express";
import { wwwAuthValue } from "../../config.js";
import { logger } from "../../utils/logger.js";

/**
 * Decode a JWT payload and return true if the token's exp claim is in the past.
 * Does NOT verify the signature — expiry is a local check only.
 * Returns false for non-JWT strings so they pass through to Salesforce.
 */
function isJwtExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof payload.exp !== 'number') return false;
    return payload.exp * 1000 < Date.now();
  } catch {
    return false;
  }
}

export function send401(res: express.Response): void {
  res.set('WWW-Authenticate', wwwAuthValue);
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Bearer token check — runs before the MCP SDK handler on every /mcp request.
 * 1. Rejects missing/non-Bearer auth immediately.
 * 2. Rejects JWTs whose exp claim is already in the past (local check, no network).
 */
export function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    send401(res);
    return;
  }
  const token = auth.slice(7);
  if (isJwtExpired(token)) {
    logger.debug('Bearer token is expired (JWT exp), returning 401');
    send401(res);
    return;
  }
  next();
}
