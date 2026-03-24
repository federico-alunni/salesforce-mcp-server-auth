// ============================================================================
// Express application factory
// Wires all three modules together based on MCP_AUTH_MODE.
// ============================================================================

import express from 'express';
import { port, serverUrl, authMode, salesforce } from '../config/index.js';
import { logger } from '../logger.js';

// Module A — MCP Auth
import { authMiddleware } from '../../modules/mcp-auth/middleware.js';
import { createLocalOAuthRoutes } from '../../modules/mcp-auth/routes/oauth-routes.js';
import { createLegacyOAuthRoutes } from '../../modules/mcp-auth/routes/legacy-oauth-routes.js';

// Module B — Salesforce Connection
import { createSalesforceRoutes, createSalesforceCallbackRoute } from '../../modules/salesforce-connection/routes/salesforce-routes.js';

// Module C — Tool Execution
import { createMCPRoutes } from '../../modules/tool-execution/routes/mcp-routes.js';

export function createApp(): express.Application {
  const app = express();

  // ---------------------------------------------------------------------------
  // Body parsing (preserve rawBody for legacy token proxy)
  // ---------------------------------------------------------------------------
  app.use(express.json());
  app.use(express.urlencoded({
    extended: false,
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  // ---------------------------------------------------------------------------
  // Global CORS
  // ---------------------------------------------------------------------------
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Last-Event-Id, Mcp-Protocol-Version');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // ---------------------------------------------------------------------------
  // Request logging
  // ---------------------------------------------------------------------------
  app.use((req, res, next) => {
    const startTime = Date.now();
    const sessionId = req.headers['mcp-session-id'];
    logger.httpRequest(req.method, req.path, req.ip ?? req.socket.remoteAddress ?? 'unknown', req.headers['user-agent'], sessionId as string, req.headers, req.body);

    const bodyChunks: Buffer[] = [];
    if (logger.isVerbose()) {
      const originalWrite = res.write.bind(res);
      const originalEnd = res.end.bind(res);
      res.write = (chunk: any, ...args: any[]) => {
        if (chunk && bodyChunks.length < 10) {
          try { bodyChunks.push(chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk))); } catch { /* */ }
        }
        return (originalWrite as any)(chunk, ...args);
      };
      res.end = (chunk: any, ...args: any[]) => {
        if (chunk && typeof chunk !== 'function' && bodyChunks.length < 10) {
          try { bodyChunks.push(chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk))); } catch { /* */ }
        }
        return (originalEnd as any)(chunk, ...args);
      };
    }

    res.on('finish', () => {
      const responseBody = logger.isVerbose() ? Buffer.concat(bodyChunks).toString('utf8') : undefined;
      logger.httpResponse(req.method, req.path, res.statusCode, Date.now() - startTime, res.getHeaders(), responseBody);
    });
    next();
  });

  // ---------------------------------------------------------------------------
  // Info routes
  // ---------------------------------------------------------------------------
  app.get('/', (_req, res) => {
    res.json({
      name: 'salesforce-mcp-server',
      version: '1.0.0',
      status: 'running',
      authMode,
      endpoints: {
        mcp: '/mcp',
        health: '/health',
        ...(authMode === 'local' ? {
          salesforceConnect: '/salesforce/connect',
          salesforceStatus: '/salesforce/status',
          salesforceDisconnect: '/salesforce/disconnect',
        } : {}),
      },
    });
  });

  app.get('/favicon.ico', (_req, res) => { res.status(204).end(); });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      authMode,
      transport: 'streamable-http',
      toolsAvailable: 15,
    });
  });

  // ---------------------------------------------------------------------------
  // Module A — OAuth routes (mode-dependent)
  // ---------------------------------------------------------------------------
  if (authMode === 'local') {
    logger.info('Auth mode: LOCAL — MCP clients authenticate to this server');
    app.use(createLocalOAuthRoutes());
  } else {
    logger.info('Auth mode: LEGACY — MCP clients authenticate directly to Salesforce');
    app.use(createLegacyOAuthRoutes());
  }

  // ---------------------------------------------------------------------------
  // Module B — Salesforce account linking routes (local mode only)
  // ---------------------------------------------------------------------------
  if (authMode === 'local') {
    // Callback route does NOT require MCP auth (browser redirect)
    app.use(createSalesforceCallbackRoute());
    // Other SF routes require MCP auth
    app.use('/salesforce', createSalesforceRoutes());
  }

  // ---------------------------------------------------------------------------
  // Module C — MCP protocol routes (always behind auth middleware)
  // ---------------------------------------------------------------------------
  app.use('/mcp', authMiddleware);
  app.use('/mcp', createMCPRoutes());

  // ---------------------------------------------------------------------------
  // 404
  // ---------------------------------------------------------------------------
  app.use((req, res) => {
    logger.warn(`[HTTP] 404 Not Found: ${req.method} ${req.path}`);
    res.status(404).json({ error: 'Not Found' });
  });

  return app;
}

export async function startServer(): Promise<void> {
  logger.info('Starting Salesforce MCP Server (Streamable HTTP)...');
  logger.info(`Auth mode: ${authMode.toUpperCase()}`);
  logger.debug('Configuration:', { port, serverUrl, authMode, salesforceLoginUrl: salesforce.loginUrl });

  const app = createApp();
  app.listen(port, () => {
    logger.info(`Salesforce MCP Server running on port ${port}`);
    logger.info(`Connect to: http://localhost:${port}/mcp`);
    if (authMode === 'local') {
      logger.info(`Salesforce connect: ${serverUrl}/salesforce/connect`);
    }
  });
}
