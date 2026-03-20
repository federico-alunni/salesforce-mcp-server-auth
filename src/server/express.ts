import express from "express";
import { port, serverUrl, salesforceLoginUrl } from "../config.js";
import { logger } from "../utils/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerMCPRoutes } from "./routes/mcp.js";

function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Universal request logging — runs before every route handler
  app.use((req, res, next) => {
    const startTime = Date.now();
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    logger.httpRequest(
      req.method,
      req.path,
      req.ip ?? req.socket.remoteAddress ?? 'unknown',
      req.headers['user-agent'],
      sessionId,
      req.headers as Record<string, string | string[] | undefined>,
      req.body
    );

    // At VERBOSE level intercept write/end to capture the response body.
    // Capped at 10 chunks to avoid buffering large streaming responses.
    const bodyChunks: Buffer[] = [];
    if (logger.isVerbose()) {
      const originalWrite = res.write.bind(res);
      const originalEnd = res.end.bind(res);
      (res as any).write = (chunk: any, ...args: any[]) => {
        if (chunk && bodyChunks.length < 10) {
          try { bodyChunks.push(chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk))); } catch { /* ignore */ }
        }
        return (originalWrite as any)(chunk, ...args);
      };
      (res as any).end = (chunk?: any, ...args: any[]) => {
        if (chunk && typeof chunk !== 'function' && bodyChunks.length < 10) {
          try { bodyChunks.push(chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk))); } catch { /* ignore */ }
        }
        return (originalEnd as any)(chunk, ...args);
      };
    }

    res.on('finish', () => {
      const responseBody = logger.isVerbose() ? Buffer.concat(bodyChunks).toString('utf8') : undefined;
      logger.httpResponse(
        req.method,
        req.path,
        res.statusCode,
        Date.now() - startTime,
        res.getHeaders() as Record<string, number | string | string[] | undefined>,
        responseBody
      );
    });
    next();
  });

  // Root route — basic server info
  app.get('/', (_req, res) => {
    res.json({
      name: 'salesforce-mcp-server',
      version: '1.0.0',
      status: 'running',
      endpoints: { mcp: '/mcp', health: '/health' },
    });
  });

  // Suppress browser favicon requests silently
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    logger.verbose('Health check requested');
    res.json({
      status: 'healthy',
      transport: 'streamable-http',
      auth: 'Authorization: Bearer <salesforce_access_token>',
      instanceDiscovery: `${salesforceLoginUrl}/services/oauth2/userinfo`,
      instanceUrlCacheTTL: parseInt(process.env.MCP_CONNECTION_CACHE_TTL || '300000'),
      toolsAvailable: 15,
      oauthProtectedResource: `${serverUrl}/.well-known/oauth-protected-resource`,
    });
    logger.verbose('Health check response sent');
  });

  // OAuth discovery routes (no auth required)
  registerOAuthRoutes(app);

  // Bearer token auth guard for all /mcp routes
  app.use('/mcp', authMiddleware);

  // MCP protocol routes
  registerMCPRoutes(app);

  // Catch-all 404
  app.use((req, res) => {
    logger.warn(`[HTTP] 404 Not Found: ${req.method} ${req.path}`);
    res.status(404).json({ error: 'Not Found' });
  });

  return app;
}

export async function startServer(): Promise<void> {
  logger.info('Starting Salesforce MCP Server (Streamable HTTP)...');
  logger.debug('Configuration:', {
    transport: 'streamable-http',
    port,
    loginUrl: salesforceLoginUrl,
    logLevel: process.env.MCP_LOG_LEVEL || 'INFO',
  });

  const app = createApp();
  app.listen(port, () => {
    logger.info(`Salesforce MCP Server running on Streamable HTTP port ${port}`);
    logger.info(`Connect to: http://localhost:${port}/mcp`);
  });
}
