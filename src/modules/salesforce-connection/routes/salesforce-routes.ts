// ============================================================================
// Module B — Salesforce account linking routes
//
// Endpoints:
//   GET  /salesforce/connect     → redirect user to Salesforce OAuth
//   GET  /salesforce/callback    → handle Salesforce OAuth callback
//   POST /salesforce/disconnect  → remove Salesforce connection
//   GET  /salesforce/status      → check connection status
// ============================================================================

import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../../mcp-auth/middleware.js';
import {
  salesforceConnectionService,
  initiateConnect,
  consumePendingMcpAuth,
  redeemSalesforceCode,
} from '../services/connection-service.js';
import { getOrCreateUser } from '../../mcp-auth/services/user-service.js';
import { generateAuthorizationCode } from '../../mcp-auth/services/auth-code-service.js';
import { logger } from '../../../shared/logger.js';

export function createSalesforceRoutes(): Router {
  const router = Router();

  // All salesforce routes require MCP authentication
  router.use(authMiddleware);

  // -----------------------------------------------------------------------
  // GET /salesforce/connect — initiate Salesforce account linking
  // -----------------------------------------------------------------------
  router.get('/connect', (req: Request, res: Response) => {
    const userId = req.principal!.userId;
    logger.auditLog('salesforce_connect_initiated', userId);

    const sfAuthUrl = initiateConnect(userId);
    res.redirect(302, sfAuthUrl);
  });

  // -----------------------------------------------------------------------
  // GET /salesforce/status — check if Salesforce is connected
  // -----------------------------------------------------------------------
  router.get('/status', async (req: Request, res: Response) => {
    const userId = req.principal!.userId;
    const connected = await salesforceConnectionService.isUserConnected(userId);
    res.json({ connected, userId });
  });

  // -----------------------------------------------------------------------
  // POST /salesforce/disconnect — remove Salesforce connection
  // -----------------------------------------------------------------------
  router.post('/disconnect', async (req: Request, res: Response) => {
    const userId = req.principal!.userId;
    await salesforceConnectionService.disconnectAccount(userId);
    res.json({ success: true, message: 'Salesforce account disconnected' });
  });

  return router;
}

// -----------------------------------------------------------------------
// Salesforce OAuth callback — does NOT require MCP auth (user is in browser)
//
// Handles two flows:
//  1. Combined MCP + SF login: initiated by GET /authorize, completes the
//     full OAuth flow and redirects back to the MCP client with an auth code.
//  2. Account linking: initiated by GET /salesforce/connect (user already
//     has an MCP token), just stores the SF connection and shows a page.
// -----------------------------------------------------------------------
export function createSalesforceCallbackRoute(): Router {
  const router = Router();

  router.get('/salesforce/callback', async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query as Record<string, string>;

    if (error) {
      logger.warn(`Salesforce OAuth error: ${error} — ${error_description}`);
      res.type('html').send(`<!DOCTYPE html><html><body>
        <h2>Salesforce Connection Failed</h2>
        <p>Error: ${escapeHtml(error_description || error)}</p>
        <p>You can close this window and try again.</p>
      </body></html>`);
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: 'Missing code or state parameter' });
      return;
    }

    // -----------------------------------------------------------------------
    // Flow 1: Combined MCP + Salesforce login
    // -----------------------------------------------------------------------
    const mcpPending = consumePendingMcpAuth(state);
    if (mcpPending) {
      try {
        const redemption = await redeemSalesforceCode(code, mcpPending.sfCodeVerifier);

        // Use the Salesforce user ID as a stable local identifier
        const sfIdentifier = redemption.sfUserId || `sforg_${redemption.sfOrgId}`;
        const user = getOrCreateUser(`sf_${sfIdentifier}`);
        redemption.commit(user.id);

        const mcpCode = generateAuthorizationCode({
          userId: user.id,
          clientId: mcpPending.clientId,
          redirectUri: mcpPending.mcpRedirectUri,
          codeChallenge: mcpPending.codeChallenge,
          codeChallengeMethod: mcpPending.codeChallengeMethod,
          scopes: mcpPending.scope.split(' '),
        });

        const redirectUrl = new URL(mcpPending.mcpRedirectUri);
        redirectUrl.searchParams.set('code', mcpCode);
        if (mcpPending.originalMcpState) redirectUrl.searchParams.set('state', mcpPending.originalMcpState);

        logger.auditLog('mcp_salesforce_login', user.id, { clientId: mcpPending.clientId });
        res.redirect(302, redirectUrl.toString());
      } catch (err) {
        logger.error('MCP Salesforce login callback error:', err);
        res.type('html').send(`<!DOCTYPE html><html><body>
          <h2>Authentication Failed</h2>
          <p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>
          <p>Please try again.</p>
        </body></html>`);
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Flow 2: Account linking (user already has MCP token)
    // -----------------------------------------------------------------------
    try {
      const connection = await salesforceConnectionService.handleOAuthCallback(state, code);
      res.type('html').send(`<!DOCTYPE html><html><head>
        <style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f9f0}
        .card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center;max-width:400px}
        .check{font-size:3rem;margin-bottom:1rem}h2{color:#2d7d2d;margin-top:0}</style></head>
        <body><div class="card">
        <div class="check">&#10004;</div>
        <h2>Salesforce Connected!</h2>
        <p>Your Salesforce account has been linked successfully.</p>
        <p>Org: ${escapeHtml(connection.salesforceOrgId || 'unknown')}</p>
        <p>You can close this window and return to your MCP client.</p>
        </div></body></html>`);
    } catch (err) {
      logger.error('Salesforce callback error:', err);
      res.type('html').send(`<!DOCTYPE html><html><body>
        <h2>Connection Failed</h2>
        <p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>
        <p>Please try again.</p>
      </body></html>`);
    }
  });

  return router;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
