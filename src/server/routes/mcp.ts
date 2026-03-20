import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { discoverInstanceUrl } from "../../utils/connection.js";
import { classifySalesforceError, SalesforceErrorType } from "../../utils/errorHandler.js";
import { logger } from "../../utils/logger.js";
import { asyncLocalStorage } from "../../mcp/context.js";
import { createMCPServer } from "../../mcp/server.js";
import { send401 } from "../middleware/auth.js";
import { wwwAuthValue } from "../../config.js";

// Session ID → transport map for stateful mode
const transports: Record<string, StreamableHTTPServerTransport> = {};

export function registerMCPRoutes(app: express.Application): void {
  // Handle POST requests for client-to-server communication
  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      logger.verbose(`Received HTTP request${sessionId ? ` [Session: ${sessionId}]` : ' [New]'}`);
      logger.verbose(`Headers: ${JSON.stringify(req.headers)}`);
      logger.verbose(`Body: ${JSON.stringify(req.body)}`);

      if (sessionId && transports[sessionId]) {
        logger.verbose(`Reusing existing session: ${sessionId}`);
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        logger.verbose('Creating new Streamable HTTP transport for new session');
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
            logger.debug(`New session initialized: ${newSessionId}`);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
            logger.debug(`Session closed and removed: ${transport.sessionId}`);
          }
        };
        const sessionServer = createMCPServer();
        logger.verbose('Connecting new Streamable HTTP transport to server');
        await sessionServer.connect(transport);
      } else {
        logger.warn('Rejecting non-initialize request without valid session ID');
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: req.body?.id ?? null,
        });
        return;
      }

      // Pre-flight: for tools/call requests, validate the Salesforce token before
      // the MCP transport writes SSE headers (HTTP 200 + text/event-stream).
      // Once SSE headers are sent we can no longer return HTTP 401, so this is
      // the only place where we can trigger Claude.ai's token-refresh flow.
      if (req.body?.method === 'tools/call') {
        const token = (req.headers['authorization'] as string).slice(7);
        try {
          await discoverInstanceUrl(token);
        } catch (preflight) {
          const classified = classifySalesforceError(preflight);
          if (classified.type === SalesforceErrorType.INVALID_SESSION) {
            logger.warn('[INVALID_SESSION] Pre-flight token validation failed — returning HTTP 401 before SSE stream starts');
            send401(res);
            return;
          }
          throw preflight;
        }
      }

      // Store headers in AsyncLocalStorage for access in tool handlers
      await asyncLocalStorage.run({ headers: req.headers, res, wwwAuthenticate: wwwAuthValue }, async () => {
        logger.verbose('Handling Streamable HTTP request');
        await transport.handleRequest(req, res, req.body);
        logger.verbose('Streamable HTTP request handled successfully');
      });
      logger.verbose('Finished processing Streamable HTTP request');
    } catch (error) {
      logger.error('Error handling Streamable HTTP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: req.body?.id ?? null,
        });
      }
    }
  });

  // Handle GET requests for server-to-client notifications (stateful mode)
  app.get('/mcp', async (req, res) => {
    logger.verbose('Received GET request for server-to-client notifications');
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      logger.warn(`Session not found for GET request: ${sessionId}`);
      res.status(404).send('Session not found');
      return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
    logger.verbose(`Handled GET request for session: ${sessionId}`);
  });

  // Handle DELETE requests for session termination
  app.delete('/mcp', async (req, res) => {
    logger.verbose('Received DELETE request for session termination');
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports[sessionId]) {
      delete transports[sessionId];
      logger.debug(`Session terminated: ${sessionId}`);
    }
    res.status(200).send('Session terminated');
    logger.verbose(`Session termination response sent for session: ${sessionId}`);
  });
}
