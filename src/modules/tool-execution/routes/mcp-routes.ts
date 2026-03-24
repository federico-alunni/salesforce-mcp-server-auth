// ============================================================================
// Module C — MCP protocol routes (/mcp)
// ============================================================================

import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { asyncLocalStorage } from '../context.js';
import { createMCPServer } from '../mcp-server.js';
import { logger } from '../../../shared/logger.js';
import { send401 } from '../../mcp-auth/middleware.js';
import { authMode, legacy } from '../../../shared/config/index.js';
import { discoverInstanceUrl } from '../../salesforce-connection/services/salesforce-client.js';
import { classifySalesforceError, SalesforceErrorType } from '../../../shared/error-handler.js';

// Session ID → transport map
const transports: Record<string, StreamableHTTPServerTransport> = {};

export function createMCPRoutes(): Router {
  const router = Router();

  // POST /mcp — client-to-server communication
  router.post('/', async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            transports[newSessionId] = transport;
            logger.debug(`New session initialized: ${newSessionId}`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
            logger.debug(`Session closed: ${transport.sessionId}`);
          }
        };
        const sessionServer = createMCPServer();
        await sessionServer.connect(transport);
      } else {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: req.body?.id ?? null,
        });
        return;
      }

      // Pre-flight validation (legacy mode only — in local mode, Module B handles token validity)
      if (authMode === 'legacy' && req.body?.method === 'tools/call') {
        const token = (req.headers['authorization'] as string).slice(7);
        try {
          await discoverInstanceUrl(token);
        } catch (preflight) {
          const classified = classifySalesforceError(preflight);
          if (classified.type === SalesforceErrorType.INVALID_SESSION) {
            send401(res, 'legacy');
            return;
          }
          throw preflight;
        }
      }

      // Run the MCP handler with context available via AsyncLocalStorage
      const wwwAuthValue = legacy.wwwAuthValue;
      await asyncLocalStorage.run(
        { headers: req.headers, res, wwwAuthenticate: wwwAuthValue, principal: req.principal },
        async () => {
          await transport.handleRequest(req, res, req.body);
        },
      );
    } catch (error) {
      logger.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: req.body?.id ?? null,
        });
      }
    }
  });

  // GET /mcp — server-to-client notifications
  router.get('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(404).send('Session not found');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  router.delete('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports[sessionId]) {
      delete transports[sessionId];
    }
    res.status(200).send('Session terminated');
  });

  return router;
}
