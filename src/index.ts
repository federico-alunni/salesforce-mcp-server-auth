#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import express from "express";
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

import { getConnectionForRequest } from "./utils/connection.js";
import { logger } from "./utils/logger.js";
import { classifySalesforceError, formatClassifiedError } from "./utils/errorHandler.js";
import { RequestContext } from "./types/connection.js";
import { SEARCH_OBJECTS, handleSearchObjects } from "./tools/search.js";
import { DESCRIBE_OBJECT, handleDescribeObject } from "./tools/describe.js";
import { QUERY_RECORDS, handleQueryRecords, QueryArgs } from "./tools/query.js";
import { AGGREGATE_QUERY, handleAggregateQuery, AggregateQueryArgs } from "./tools/aggregateQuery.js";
import { DML_RECORDS, handleDMLRecords, DMLArgs } from "./tools/dml.js";
import { MANAGE_OBJECT, handleManageObject, ManageObjectArgs } from "./tools/manageObject.js";
import { MANAGE_FIELD, handleManageField, ManageFieldArgs } from "./tools/manageField.js";
import { MANAGE_FIELD_PERMISSIONS, handleManageFieldPermissions, ManageFieldPermissionsArgs } from "./tools/manageFieldPermissions.js";
import { SEARCH_ALL, handleSearchAll, SearchAllArgs, WithClause } from "./tools/searchAll.js";
import { READ_APEX, handleReadApex, ReadApexArgs } from "./tools/readApex.js";
import { WRITE_APEX, handleWriteApex, WriteApexArgs } from "./tools/writeApex.js";
import { READ_APEX_TRIGGER, handleReadApexTrigger, ReadApexTriggerArgs } from "./tools/readApexTrigger.js";
import { WRITE_APEX_TRIGGER, handleWriteApexTrigger, WriteApexTriggerArgs } from "./tools/writeApexTrigger.js";
import { EXECUTE_ANONYMOUS, handleExecuteAnonymous, ExecuteAnonymousArgs } from "./tools/executeAnonymous.js";
import { MANAGE_DEBUG_LOGS, handleManageDebugLogs, ManageDebugLogsArgs } from "./tools/manageDebugLogs.js";

// Load environment variables silently
dotenv.config();

// AsyncLocalStorage for passing HTTP headers to tool handlers
const asyncLocalStorage = new AsyncLocalStorage<{ headers?: Record<string, string | string[] | undefined> }>();

// Tool handlers
const _listToolsHandler = async () => ({
  tools: [
    SEARCH_OBJECTS, 
    DESCRIBE_OBJECT, 
    QUERY_RECORDS, 
    AGGREGATE_QUERY,
    DML_RECORDS,
    MANAGE_OBJECT,
    MANAGE_FIELD,
    MANAGE_FIELD_PERMISSIONS,
    SEARCH_ALL,
    READ_APEX,
    WRITE_APEX,
    READ_APEX_TRIGGER,
    WRITE_APEX_TRIGGER,
    EXECUTE_ANONYMOUS,
    MANAGE_DEBUG_LOGS
  ],
});

const _callToolHandler = async (request: CallToolRequest) => {
  const startTime = Date.now();
  const toolName = request.params.name;
  logger.info('Incoming request payload..');
  
  try {
    const { name, arguments: args } = request.params;
    if (!args) throw new Error('Arguments are required');

    // Extract the Bearer token from the Authorization header.
    // The header is injected by the client (e.g. LibreChat) before every
    // tool call; the server never stores credentials between requests.
    const store = asyncLocalStorage.getStore();
    const rawAuth = store?.headers?.['authorization'];
    const authStr = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
    const accessToken = authStr?.startsWith('Bearer ') ? authStr.slice(7) : undefined;

    if (!accessToken) {
      throw new Error(
        'Missing or malformed Authorization header. ' +
        'Expected: Authorization: Bearer <salesforce_access_token>'
      );
    }

    const requestContext: RequestContext = { accessToken };

    logger.debug('Bearer token received, length=' + accessToken.length);
    logger.toolCall(name, args);

    const conn = await getConnectionForRequest(requestContext);
    logger.debug('Salesforce connection established');

    switch (name) {
      case "salesforce_search_objects": {
        const { searchPattern } = args as { searchPattern: string };
        if (!searchPattern) throw new Error('searchPattern is required');
        const result = await handleSearchObjects(conn, searchPattern);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_describe_object": {
        const { objectName } = args as { objectName: string };
        if (!objectName) throw new Error('objectName is required');
        const result = await handleDescribeObject(conn, objectName);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_query_records": {
        const queryArgs = args as Record<string, unknown>;
        if (!queryArgs.objectName || !Array.isArray(queryArgs.fields)) {
          throw new Error('objectName and fields array are required for query');
        }
        // Type check and conversion
        const validatedArgs: QueryArgs = {
          objectName: queryArgs.objectName as string,
          fields: queryArgs.fields as string[],
          whereClause: queryArgs.whereClause as string | undefined,
          orderBy: queryArgs.orderBy as string | undefined,
          limit: queryArgs.limit as number | undefined
        };
        const result = await handleQueryRecords(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_aggregate_query": {
        const aggregateArgs = args as Record<string, unknown>;
        if (!aggregateArgs.objectName || !Array.isArray(aggregateArgs.selectFields) || !Array.isArray(aggregateArgs.groupByFields)) {
          throw new Error('objectName, selectFields array, and groupByFields array are required for aggregate query');
        }
        // Type check and conversion
        const validatedArgs: AggregateQueryArgs = {
          objectName: aggregateArgs.objectName as string,
          selectFields: aggregateArgs.selectFields as string[],
          groupByFields: aggregateArgs.groupByFields as string[],
          whereClause: aggregateArgs.whereClause as string | undefined,
          havingClause: aggregateArgs.havingClause as string | undefined,
          orderBy: aggregateArgs.orderBy as string | undefined,
          limit: aggregateArgs.limit as number | undefined
        };
        const result = await handleAggregateQuery(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_dml_records": {
        const dmlArgs = args as Record<string, unknown>;
        if (!dmlArgs.operation || !dmlArgs.objectName || !Array.isArray(dmlArgs.records)) {
          throw new Error('operation, objectName, and records array are required for DML');
        }
        const validatedArgs: DMLArgs = {
          operation: dmlArgs.operation as 'insert' | 'update' | 'delete' | 'upsert',
          objectName: dmlArgs.objectName as string,
          records: dmlArgs.records as Record<string, any>[],
          externalIdField: dmlArgs.externalIdField as string | undefined
        };
        const result = await handleDMLRecords(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true, validatedArgs.records.length);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_manage_object": {
        const objectArgs = args as Record<string, unknown>;
        if (!objectArgs.operation || !objectArgs.objectName) {
          throw new Error('operation and objectName are required for object management');
        }
        const validatedArgs: ManageObjectArgs = {
          operation: objectArgs.operation as 'create' | 'update',
          objectName: objectArgs.objectName as string,
          label: objectArgs.label as string | undefined,
          pluralLabel: objectArgs.pluralLabel as string | undefined,
          description: objectArgs.description as string | undefined,
          nameFieldLabel: objectArgs.nameFieldLabel as string | undefined,
          nameFieldType: objectArgs.nameFieldType as 'Text' | 'AutoNumber' | undefined,
          nameFieldFormat: objectArgs.nameFieldFormat as string | undefined,
          sharingModel: objectArgs.sharingModel as 'ReadWrite' | 'Read' | 'Private' | 'ControlledByParent' | undefined
        };
        const result = await handleManageObject(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_manage_field": {
        const fieldArgs = args as Record<string, unknown>;
        if (!fieldArgs.operation || !fieldArgs.objectName || !fieldArgs.fieldName) {
          throw new Error('operation, objectName, and fieldName are required for field management');
        }
        const validatedArgs: ManageFieldArgs = {
          operation: fieldArgs.operation as 'create' | 'update',
          objectName: fieldArgs.objectName as string,
          fieldName: fieldArgs.fieldName as string,
          label: fieldArgs.label as string | undefined,
          type: fieldArgs.type as string | undefined,
          required: fieldArgs.required as boolean | undefined,
          unique: fieldArgs.unique as boolean | undefined,
          externalId: fieldArgs.externalId as boolean | undefined,
          length: fieldArgs.length as number | undefined,
          precision: fieldArgs.precision as number | undefined,
          scale: fieldArgs.scale as number | undefined,
          referenceTo: fieldArgs.referenceTo as string | undefined,
          relationshipLabel: fieldArgs.relationshipLabel as string | undefined,
          relationshipName: fieldArgs.relationshipName as string | undefined,
          deleteConstraint: fieldArgs.deleteConstraint as 'Cascade' | 'Restrict' | 'SetNull' | undefined,
          picklistValues: fieldArgs.picklistValues as Array<{ label: string; isDefault?: boolean }> | undefined,
          description: fieldArgs.description as string | undefined,
          grantAccessTo: fieldArgs.grantAccessTo as string[] | undefined
        };
        const result = await handleManageField(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_manage_field_permissions": {
        const permArgs = args as Record<string, unknown>;
        if (!permArgs.operation || !permArgs.objectName || !permArgs.fieldName) {
          throw new Error('operation, objectName, and fieldName are required for field permissions management');
        }
        const validatedArgs: ManageFieldPermissionsArgs = {
          operation: permArgs.operation as 'grant' | 'revoke' | 'view',
          objectName: permArgs.objectName as string,
          fieldName: permArgs.fieldName as string,
          profileNames: permArgs.profileNames as string[] | undefined,
          readable: permArgs.readable as boolean | undefined,
          editable: permArgs.editable as boolean | undefined
        };
        const result = await handleManageFieldPermissions(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_search_all": {
        const searchArgs = args as Record<string, unknown>;
        if (!searchArgs.searchTerm || !Array.isArray(searchArgs.objects)) {
          throw new Error('searchTerm and objects array are required for search');
        }

        // Validate objects array
        const objects = searchArgs.objects as Array<Record<string, unknown>>;
        if (!objects.every(obj => obj.name && Array.isArray(obj.fields))) {
          throw new Error('Each object must specify name and fields array');
        }

        // Type check and conversion
        const validatedArgs: SearchAllArgs = {
          searchTerm: searchArgs.searchTerm as string,
          searchIn: searchArgs.searchIn as "ALL FIELDS" | "NAME FIELDS" | "EMAIL FIELDS" | "PHONE FIELDS" | "SIDEBAR FIELDS" | undefined,
          objects: objects.map(obj => ({
            name: obj.name as string,
            fields: obj.fields as string[],
            where: obj.where as string | undefined,
            orderBy: obj.orderBy as string | undefined,
            limit: obj.limit as number | undefined
          })),
          withClauses: searchArgs.withClauses as WithClause[] | undefined,
          updateable: searchArgs.updateable as boolean | undefined,
          viewable: searchArgs.viewable as boolean | undefined
        };

        const result = await handleSearchAll(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_read_apex": {
        const apexArgs = args as Record<string, unknown>;
        
        // Type check and conversion
        const validatedArgs: ReadApexArgs = {
          className: apexArgs.className as string | undefined,
          namePattern: apexArgs.namePattern as string | undefined,
          includeMetadata: apexArgs.includeMetadata as boolean | undefined
        };

        const result = await handleReadApex(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_write_apex": {
        const apexArgs = args as Record<string, unknown>;
        if (!apexArgs.operation || !apexArgs.className || !apexArgs.body) {
          throw new Error('operation, className, and body are required for writing Apex');
        }
        
        // Type check and conversion
        const validatedArgs: WriteApexArgs = {
          operation: apexArgs.operation as 'create' | 'update',
          className: apexArgs.className as string,
          apiVersion: apexArgs.apiVersion as string | undefined,
          body: apexArgs.body as string
        };

        const result = await handleWriteApex(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_read_apex_trigger": {
        const triggerArgs = args as Record<string, unknown>;
        
        // Type check and conversion
        const validatedArgs: ReadApexTriggerArgs = {
          triggerName: triggerArgs.triggerName as string | undefined,
          namePattern: triggerArgs.namePattern as string | undefined,
          includeMetadata: triggerArgs.includeMetadata as boolean | undefined
        };

        const result = await handleReadApexTrigger(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_write_apex_trigger": {
        const triggerArgs = args as Record<string, unknown>;
        if (!triggerArgs.operation || !triggerArgs.triggerName || !triggerArgs.body) {
          throw new Error('operation, triggerName, and body are required for writing Apex trigger');
        }
        
        // Type check and conversion
        const validatedArgs: WriteApexTriggerArgs = {
          operation: triggerArgs.operation as 'create' | 'update',
          triggerName: triggerArgs.triggerName as string,
          objectName: triggerArgs.objectName as string | undefined,
          apiVersion: triggerArgs.apiVersion as string | undefined,
          body: triggerArgs.body as string
        };

        const result = await handleWriteApexTrigger(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_execute_anonymous": {
        const executeArgs = args as Record<string, unknown>;
        if (!executeArgs.apexCode) {
          throw new Error('apexCode is required for executing anonymous Apex');
        }
        
        // Type check and conversion
        const validatedArgs: ExecuteAnonymousArgs = {
          apexCode: executeArgs.apexCode as string,
          logLevel: executeArgs.logLevel as 'NONE' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'FINE' | 'FINER' | 'FINEST' | undefined
        };

        const result = await handleExecuteAnonymous(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      case "salesforce_manage_debug_logs": {
        const debugLogsArgs = args as Record<string, unknown>;
        if (!debugLogsArgs.operation || !debugLogsArgs.username) {
          throw new Error('operation and username are required for managing debug logs');
        }
        
        // Type check and conversion
        const validatedArgs: ManageDebugLogsArgs = {
          operation: debugLogsArgs.operation as 'enable' | 'disable' | 'retrieve',
          username: debugLogsArgs.username as string,
          logLevel: debugLogsArgs.logLevel as 'NONE' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'FINE' | 'FINER' | 'FINEST' | undefined,
          expirationTime: debugLogsArgs.expirationTime as number | undefined,
          limit: debugLogsArgs.limit as number | undefined,
          logId: debugLogsArgs.logId as string | undefined,
          includeBody: debugLogsArgs.includeBody as boolean | undefined
        };

        const result = await handleManageDebugLogs(conn, validatedArgs);
        logger.toolResult(name, Date.now() - startTime, true);
        logger.info('Tool response:', result);
        return result;
      }

      default:
        logger.warn(`Unknown tool called: ${name}`);
        const unknownResp = {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
        logger.info('Tool response:', unknownResp);
        return unknownResp;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    
    // Classify the error for better user feedback
    const classified = classifySalesforceError(error);
    
    logger.error(
      `Tool ${toolName} failed after ${duration}ms [${classified.type}]:`, 
      classified.message
    );
    logger.verbose('Error details:', error);
    
    // Use classified error message for user-friendly feedback
    const errorMessage = formatClassifiedError(classified);
    const errorResp = {
      content: [{
        type: "text",
        text: errorMessage,
      }],
      isError: true,
    };
    logger.info('Tool response (error):', errorResp);
    return errorResp;
  }
};

function createMCPServer(): Server {
  const server = new Server(
    {
      name: "salesforce-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, _listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, _callToolHandler);
  return server;
}

async function runServer() {
  const port = parseInt(process.env.MCP_SERVER_PORT || '3000');

  logger.info('Starting Salesforce MCP Server (Streamable HTTP)...');
  logger.debug('Configuration:', {
    transport: 'streamable-http',
    port,
    loginUrl: process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com',
    logLevel: process.env.MCP_LOG_LEVEL || 'INFO',
  });

  await runStreamableHTTPServer(port);
}

async function runStreamableHTTPServer(port: number) {
  const app = express();
  app.use(express.json());

  const serverUrl = process.env.MCP_SERVER_URL || 'https://salesforce-mcp-server-org.up.railway.app';
  const oauthScopes = process.env.MCP_OAUTH_SCOPES || 'api refresh_token offline_access web openid';

  // Store transports by session ID for stateful mode
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    logger.verbose('Health check requested');
    res.json({
      status: 'healthy',
      transport: 'streamable-http',
      auth: 'Authorization: Bearer <salesforce_access_token>',
      instanceDiscovery: `${process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'}/services/oauth2/userinfo`,
      instanceUrlCacheTTL: parseInt(process.env.MCP_CONNECTION_CACHE_TTL || '300000'),
      toolsAvailable: 15,
      oauthProtectedResource: `${serverUrl}/.well-known/oauth-protected-resource`,
    });
    logger.verbose('Health check response sent');
  });

  // OAuth 2.0 Protected Resource Metadata (RFC 9728) — publicly accessible, no auth required
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: serverUrl,
      authorization_servers: ['https://login.salesforce.com'],
      scopes_supported: oauthScopes.split(' '),
    });
  });

  // Bearer token check — runs before the MCP SDK handler on every /mcp request,
  // including the initial initialize. Returns 401 + WWW-Authenticate when the
  // Authorization header is missing or not a Bearer token.
  app.use('/mcp', (req, res, next) => {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${serverUrl}/.well-known/oauth-protected-resource", scope="${oauthScopes}"`,
      );
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  // Handle POST requests for client-to-server communication
  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;
      
      logger.verbose(`Received HTTP request${sessionId ? ` [Session: ${sessionId}]` : ' [New]'}`);
      logger.verbose(`Headers: ${JSON.stringify(req.headers)}`);
      logger.verbose(`Body: ${JSON.stringify(req.body)}`);
      
      if (sessionId && transports[sessionId]) {
        // Reuse existing transport for this session
        logger.verbose(`Reusing existing session: ${sessionId}`);
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session — create a fresh Server + transport pair per the MCP spec
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
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: req.body?.id ?? null,
        });
        return;
      }

      // Store headers in AsyncLocalStorage for access in tool handlers
      await asyncLocalStorage.run({ headers: req.headers }, async () => {
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
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: req.body?.id ?? null,
        });
      }
    }
  });
  
  // Handle GET requests for server-to-client notifications (if using stateful mode)
  app.get('/mcp', async (req, res) => {
    logger.verbose('Received GET request for server-to-client notifications');
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      logger.warn(`Invalid or missing session ID for GET request: ${sessionId}`);
      res.status(400).send('Invalid or missing session ID');
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
  
  app.listen(port, () => {
    logger.info(`Salesforce MCP Server running on Streamable HTTP port ${port}`);
    logger.info(`Connect to: http://localhost:${port}/mcp`);
  });
}

runServer().catch((error) => {
  logger.error("Fatal error running server:", error);
  process.exit(1);
});