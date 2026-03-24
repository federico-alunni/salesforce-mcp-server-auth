// ============================================================================
// Module A — Auth middleware for /mcp routes
// Validates local JWT and attaches LocalPrincipal to request.
// In legacy mode, validates Salesforce Bearer token format.
// ============================================================================

import type { Request, Response, NextFunction } from 'express';
import { authMode, serverUrl, mcpAuth } from '../../shared/config/index.js';
import { tokenService } from './services/token-service.js';
import { logger } from '../../shared/logger.js';
import type { LocalPrincipal } from '../../types/index.js';

// Extend Express Request to carry the principal
declare global {
  namespace Express {
    interface Request {
      principal?: LocalPrincipal;
      rawBody?: string;
    }
  }
}

const wwwAuthLocal = `Bearer realm="${serverUrl}", error="invalid_token"`;
const wwwAuthLegacy = `Bearer resource_metadata="${serverUrl}/.well-known/oauth-protected-resource"`;

export function send401(res: Response, mode?: string) {
  res.set('WWW-Authenticate', (mode ?? authMode) === 'local' ? wwwAuthLocal : wwwAuthLegacy);
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Local auth middleware — validates our own JWT.
 */
async function localAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    send401(res, 'local');
    return;
  }

  const token = auth.slice(7);
  const principal = await tokenService.validateAccessToken(token);
  if (!principal) {
    logger.debug('Local JWT validation failed');
    send401(res, 'local');
    return;
  }

  req.principal = principal;
  next();
}

/**
 * Legacy auth middleware — just checks Bearer format and JWT expiry.
 * The token is the Salesforce access token passed through directly.
 */
function legacyAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    send401(res, 'legacy');
    return;
  }

  const token = auth.slice(7);

  // Check JWT expiry if it looks like a JWT
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
        logger.debug('Bearer token is expired (JWT exp), returning 401');
        send401(res, 'legacy');
        return;
      }
    }
  } catch { /* not a JWT — let it pass through to Salesforce */ }

  next();
}

/**
 * Dispatches to the correct middleware based on MCP_AUTH_MODE.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (authMode === 'local') {
    localAuthMiddleware(req, res, next);
  } else {
    legacyAuthMiddleware(req, res, next);
  }
}
