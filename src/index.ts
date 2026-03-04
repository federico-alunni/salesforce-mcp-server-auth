#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import express from "express";
import { AsyncLocalStorage } from "async_hooks";

import { getConnectionForRequest, validateAuthConfig } from "./utils/connection.js";
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

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  const toolName = request.params.name;
  logger.info('Incoming request payload..');
  
  try {
    const { name, arguments: args } = request.params;
    if (!args) throw new Error('Arguments are required');

    // Extract auth context from HTTP headers
    // x-mcp-auth-mode decides which flow to use (defaults to 'strict')
    let requestContext: RequestContext | undefined;

    const store = asyncLocalStorage.getStore();
    if (store?.headers) {
      const h = store.headers;

      // Helper to normalise single-value headers
      const str = (v: string | string[] | undefined): string | undefined =>
        v ? (Array.isArray(v) ? v[0] : v) : undefined;

      const requestAuthMode = (str(h['x-mcp-auth-mode']) ?? 'strict') as 'strict' | 'oauth';
      const instanceHeader  = str(h['x-salesforce-instance-url']);

      logger.debug('Auth headers received:', {
        'x-mcp-auth-mode': requestAuthMode,
        'x-salesforce-instance-url': instanceHeader ?? 'MISSING',
      });

      if (requestAuthMode === 'oauth') {
        const clientId     = str(h['x-salesforce-client-id']);
        const clientSecret = str(h['x-salesforce-client-secret']);

        logger.debug('OAuth client-credentials headers:', {
          'x-salesforce-client-id':     clientId     ? `${clientId.substring(0, 8)}...` : 'MISSING',
          'x-salesforce-client-secret': clientSecret ? '***' : 'MISSING',
          'x-salesforce-instance-url':  instanceHeader ?? 'MISSING',
        });

        if (clientId && clientSecret && instanceHeader) {
          requestContext = {
            requestAuthMode: 'oauth',
            oauthCredentials: { clientId, clientSecret, instanceUrl: instanceHeader },
          };
          logger.debug('OAuth client-credentials context built from headers');
        } else {
          logger.warn('Missing required oauth headers', {
            hasClientId:     !!clientId,
            hasClientSecret: !!clientSecret,
            hasInstanceUrl:  !!instanceHeader,
          });
        }
      } else {
        // strict (default)
        const authHeader     = str(h['x-salesforce-access-token']);
        const usernameHeader = str(h['x-salesforce-username']);
        const userIdHeader   = str(h['x-salesforce-user-id']);

        logger.debug('Strict auth headers:', {
          'x-salesforce-access-token': authHeader ? `${authHeader.substring(0, 8)}...` : 'MISSING',
          'x-salesforce-instance-url': instanceHeader ?? 'MISSING',
          'x-salesforce-username':     usernameHeader ?? 'MISSING',
          'x-salesforce-user-id':      userIdHeader   ?? 'MISSING',
        });

        if (authHeader && instanceHeader) {
          requestContext = {
            requestAuthMode: 'strict',
            salesforceAuth: {
              accessToken: authHeader,
              instanceUrl: instanceHeader,
              username:    usernameHeader,
              userId:      userIdHeader,
            },
          };
          logger.debug('Strict OAuth context built from headers');
        } else {
          logger.warn('Missing required strict auth headers', {
            hasAccessToken: !!authHeader,
            hasInstanceUrl: !!instanceHeader,
          });
        }
      }
    } else {
      logger.warn('No AsyncLocalStorage store or headers found');
    }

    // Log user context if available
    if (requestContext?.salesforceAuth) {
      const { username, userId } = requestContext.salesforceAuth;
      logger.userOperation(name, username, userId, name);
    }

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
});

type TransportType = 'sse' | 'streamable-http';

function getTransportType(): TransportType {
  // Check command line arguments first
  if (process.argv.includes('--sse')) return 'sse';
  if (process.argv.includes('--http') || process.argv.includes('--streamable-http')) return 'streamable-http';
  
  // Check environment variable
  const envTransport = process.env.MCP_TRANSPORT_TYPE?.toLowerCase() as TransportType;
  if (envTransport && ['sse', 'streamable-http'].includes(envTransport)) {
    return envTransport;
  }
  
  // Legacy environment variable for backward compatibility
  if (process.env.MCP_SERVER_HTTP === 'true') return 'streamable-http';
  
  // Default to streamable-http
  return 'streamable-http';
}

async function runServer() {
  const transportType = getTransportType();
  const port = parseInt(process.env.MCP_SERVER_PORT || '3000');
  
  // Fail fast if the auth configuration is invalid
  validateAuthConfig();

  logger.info(`Starting Salesforce MCP Server with ${transportType} transport...`);
  logger.debug('Configuration:', {
    transport: transportType,
    port: port,
    instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
    logLevel: process.env.MCP_LOG_LEVEL || 'INFO'
  });
  
  switch (transportType) {
    case 'sse':
      await runSSEServer(port);
      break;
    case 'streamable-http':
      await runStreamableHTTPServer(port);
      break;
    default:
      throw new Error(`Unsupported transport type: ${transportType}`);
  }
}

async function runSSEServer(port: number) {
  const app = express();
  app.use(express.json());
  
  // Store transports by session ID
  const transports: Record<string, SSEServerTransport> = {};
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    const currentAuthMode = process.env.MCP_AUTH_MODE || 'strict';
    res.json({
      status: 'healthy',
      authMode: currentAuthMode,
      authHeaders: {
        strict: {
          required: ['x-mcp-auth-mode (value: strict, or omit for default)', 'x-salesforce-access-token', 'x-salesforce-instance-url'],
          optional: ['x-salesforce-username', 'x-salesforce-user-id'],
        },
        oauth: {
          required: ['x-mcp-auth-mode (value: oauth)', 'x-salesforce-client-id', 'x-salesforce-client-secret', 'x-salesforce-instance-url'],
        },
      },
      toolsAvailable: 15,
      transport: 'sse',
      cacheEnabled: true,
      cacheTTL: parseInt(process.env.MCP_CONNECTION_CACHE_TTL || '300000')
    });
  });
  
  // SSE endpoint for establishing connection
  app.get('/sse', async (req, res) => {
    try {
      const transport = new SSEServerTransport('/messages', res);
      transports[transport.sessionId] = transport;
      
      // Clean up when client disconnects
      res.on('close', () => {
        delete transports[transport.sessionId];
        logger.debug(`SSE connection closed: ${transport.sessionId}`);
      });
      
      await server.connect(transport);
      logger.info(`New SSE connection established: ${transport.sessionId}`);
    } catch (error) {
      logger.error('Error setting up SSE connection:', error);
      if (!res.headersSent) {
        res.status(500).send('Failed to establish SSE connection');
      }
    }
  });
  
  // Message endpoint for receiving client messages
  app.post('/messages', async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string;
      const transport = transports[sessionId];
      
      if (!transport) {
        logger.warn(`Invalid SSE session ID: ${sessionId}`);
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid session ID' },
          id: null
        });
        return;
      }
      
      // Store headers in AsyncLocalStorage for access in tool handlers
      await asyncLocalStorage.run({ headers: req.headers }, async () => {
        await transport.handlePostMessage(req, res, req.body);
      });
    } catch (error) {
      logger.error('Error handling SSE message:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });
  
  app.listen(port, () => {
    logger.info(`Salesforce MCP Server running on SSE port ${port}`);
    logger.info(`SSE endpoint: http://localhost:${port}/sse`);
    logger.info(`Messages endpoint: http://localhost:${port}/messages`);
  });
}

async function runStreamableHTTPServer(port: number) {
  const app = express();
  app.use(express.json());
  
  // Store transports by session ID for stateful mode
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  
  // Health check endpoint
  app.get('/health', (req, res) => {
    logger.verbose('Health check requested');
    const currentAuthMode = process.env.MCP_AUTH_MODE || 'strict';
    res.json({
      status: 'healthy',
      authMode: currentAuthMode,
      authHeaders: {
        strict: {
          required: ['x-mcp-auth-mode (value: strict, or omit for default)', 'x-salesforce-access-token', 'x-salesforce-instance-url'],
          optional: ['x-salesforce-username', 'x-salesforce-user-id'],
        },
        oauth: {
          required: ['x-mcp-auth-mode (value: oauth)', 'x-salesforce-client-id', 'x-salesforce-client-secret', 'x-salesforce-instance-url'],
        },
      },
      toolsAvailable: 15,
      transport: 'streamable-http',
      cacheEnabled: true,
      cacheTTL: parseInt(process.env.MCP_CONNECTION_CACHE_TTL || '300000')
    });
    logger.verbose('Health check response sent');
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
        // Reuse existing transport
        logger.verbose(`Reusing existing session: ${sessionId}`);
        transport = transports[sessionId];
      } else {
        // Create new transport (stateless mode for simplicity)
        logger.verbose('Creating new Streamable HTTP transport (stateless mode)');
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless mode
        });
        logger.verbose('Connecting new Streamable HTTP transport');
        await server.connect(transport);
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
          id: null,
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