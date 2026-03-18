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

import { getConnectionForRequest, discoverInstanceUrl, invalidateInstanceUrlCache } from "./utils/connection.js";
import { logger } from "./utils/logger.js";
import { classifySalesforceError, formatClassifiedError, SalesforceErrorType } from "./utils/errorHandler.js";
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

// AsyncLocalStorage for passing HTTP headers (and response object) to tool handlers
const asyncLocalStorage = new AsyncLocalStorage<{
  headers?: Record<string, string | string[] | undefined>;
  res?: express.Response;
  wwwAuthenticate?: string;
}>();

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

/**
 * Finalize a tool result: re-throw INVALID_SESSION errors so the outer catch
 * handler can evict the cache and return HTTP 401 to Claude.ai.
 * Tool handlers catch all errors internally and return isError:true — without
 * this re-throw, INVALID_SESSION would never reach the outer catch block.
 */
function returnResult(name: string, startTime: number, result: any): any {
  if (result?.isError) {
    const text = (result.content?.[0]?.text ?? '') as string;
    const classified = classifySalesforceError(new Error(text));
    if (classified.type === SalesforceErrorType.INVALID_SESSION) {
      throw new Error(text); // propagate to outer catch for cache eviction + HTTP 401
    }
  }
  logger.toolResult(name, Date.now() - startTime, !result?.isError);
  logger.info('Tool response:', result);
  return result;
}

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
        return returnResult(name, startTime, result);
      }

      case "salesforce_describe_object": {
        const { objectName } = args as { objectName: string };
        if (!objectName) throw new Error('objectName is required');
        const result = await handleDescribeObject(conn, objectName);
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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
        return returnResult(name, startTime, result);
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

    // INVALID_SESSION means Salesforce rejected the token (expired or revoked).
    // Write HTTP 401 directly so Claude.ai triggers its token-refresh flow instead
    // of treating this as a regular tool error.
    if (classified.type === SalesforceErrorType.INVALID_SESSION) {
      const store = asyncLocalStorage.getStore();
      const httpRes = store?.res;
      // Evict the cached instance URL so the next pre-flight re-validates the
      // token against Salesforce and can return HTTP 401 before SSE starts.
      const rawToken = (store?.headers?.['authorization'] as string | undefined)?.slice(7);
      if (rawToken) invalidateInstanceUrlCache(rawToken);
      if (httpRes && !httpRes.headersSent) {
        logger.warn(`[INVALID_SESSION] Salesforce rejected token for ${toolName}, returning HTTP 401`);
        httpRes.set('WWW-Authenticate', store.wwwAuthenticate || 'Bearer');
        httpRes.status(401).json({ error: 'Unauthorized' });
        // Throw so the MCP SDK does not attempt to write its own response.
        // The client already has the 401; any "headers already sent" noise is harmless.
        throw new Error('__INVALID_SESSION_401_SENT__');
      } else {
        // SSE stream already started — HTTP 401 is not possible now.
        // Cache has been evicted; the next request with this token will hit the
        // pre-flight, call userinfo, get 401/403, and return HTTP 401 to Claude.ai.
        logger.warn(`[INVALID_SESSION] SSE headers already sent for ${toolName} — cache evicted; HTTP 401 will be returned on next request to trigger token refresh`);
      }
    }

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

  // Universal request logging — runs before every route handler, including
  // unauthenticated and non-existent routes. Logs arrival at INFO and
  // response status (DEBUG), headers and body (VERBOSE) via res.on('finish').
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

  const serverUrl = process.env.MCP_SERVER_URL || 'https://salesforce-mcp-server-org.up.railway.app';
  const oauthScopes = process.env.MCP_OAUTH_SCOPES || 'api refresh_token offline_access web openid id';
  // Additional paths that should mirror the OAuth protected resource metadata.
  // Useful when clients construct the well-known URL differently (e.g. appending /mcp).
  const oauthAliasesRaw = process.env.MCP_OAUTH_WELL_KNOWN_ALIASES ?? '/.well-known/oauth-protected-resource/mcp';
  const oauthAliases = oauthAliasesRaw.split(',').map(p => p.trim()).filter(p => p.length > 0);

  // Store transports by session ID for stateful mode
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // Root route — basic server info for browser / probe requests
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
      instanceDiscovery: `${process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'}/services/oauth2/userinfo`,
      instanceUrlCacheTTL: parseInt(process.env.MCP_CONNECTION_CACHE_TTL || '300000'),
      toolsAvailable: 15,
      oauthProtectedResource: `${serverUrl}/.well-known/oauth-protected-resource`,
    });
    logger.verbose('Health check response sent');
  });

  // OAuth 2.0 Protected Resource Metadata (RFC 9728) — publicly accessible, no auth required
  const oauthMetadataHandler = (_req: express.Request, res: express.Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({
      resource: serverUrl,
      authorization_servers: [process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com'],
      scopes_supported: oauthScopes.split(' '),
      bearer_methods_supported: ['header'],
    });
  };
  // CORS preflight for discovery endpoints
  const corsPreflight = (_req: express.Request, res: express.Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
  };

  app.options('/.well-known/oauth-protected-resource', corsPreflight);
  app.get('/.well-known/oauth-protected-resource', oauthMetadataHandler);
  // Register configurable aliases (MCP_OAUTH_WELL_KNOWN_ALIASES)
  for (const alias of oauthAliases) {
    app.options(alias, corsPreflight);
    app.get(alias, oauthMetadataHandler);
    logger.debug(`OAuth metadata also served at: ${alias}`);
  }

  // --- Authorization Server Metadata (proxied from Salesforce) ---
  // Provides RFC 8414 / OpenID Connect discovery so clients that perform
  // root-based /.well-known/oauth-authorization-server discovery against
  // this server's origin can locate the Salesforce authorization endpoints.
  const salesforceLoginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
  const authServerMetadataCacheTTL = parseInt(process.env.MCP_AUTH_SERVER_METADATA_CACHE_TTL || '3600000');
  let authServerMetadataCache: { data: unknown; fetchedAt: number } | null = null;

  async function fetchAuthServerMetadata(): Promise<unknown> {
    const now = Date.now();
    if (authServerMetadataCache && (now - authServerMetadataCache.fetchedAt) < authServerMetadataCacheTTL) {
      return authServerMetadataCache.data;
    }
    const discoveryUrl = `${salesforceLoginUrl}/.well-known/openid-configuration`;
    logger.debug(`Fetching authorization server metadata from ${discoveryUrl}`);
    const response = await fetch(discoveryUrl);
    if (!response.ok) {
      throw new Error(`Upstream metadata fetch failed: ${response.status} ${response.statusText}`);
    }
    const metadata = await response.json();
    authServerMetadataCache = { data: metadata, fetchedAt: now };
    return metadata;
  }

  const authServerMetadataHandler = async (_req: express.Request, res: express.Response) => {
    try {
      const metadata = await fetchAuthServerMetadata();
      res.set('Access-Control-Allow-Origin', '*');
      res.json(metadata);
    } catch (error) {
      logger.error('Failed to fetch authorization server metadata:', error);
      res.redirect(302, `${salesforceLoginUrl}/.well-known/openid-configuration`);
    }
  };

  app.options('/.well-known/oauth-authorization-server', corsPreflight);
  app.get('/.well-known/oauth-authorization-server', authServerMetadataHandler);
  app.options('/.well-known/oauth-authorization-server/mcp', corsPreflight);
  app.get('/.well-known/oauth-authorization-server/mcp', authServerMetadataHandler);
  // Also support OpenID Connect discovery path for clients that use it
  app.options('/.well-known/openid-configuration', corsPreflight);
  app.get('/.well-known/openid-configuration', authServerMetadataHandler);

  // Helper — sends 401 + WWW-Authenticate and returns the header value for reuse
  const wwwAuthValue = `Bearer resource_metadata="${serverUrl}/.well-known/oauth-protected-resource", scope="${oauthScopes}"`;
  const send401 = (res: express.Response) => {
    res.set('WWW-Authenticate', wwwAuthValue);
    res.status(401).json({ error: 'Unauthorized' });
  };

  // Bearer token check — runs before the MCP SDK handler on every /mcp request.
  // 1. Rejects missing/non-Bearer auth immediately.
  // 2. Rejects JWTs whose exp claim is already in the past (local check, no network).
  app.use('/mcp', (req, res, next) => {
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
  
  // Catch-all: log and reject requests to any route not defined above
  app.use((req, res) => {
    logger.warn(`[HTTP] 404 Not Found: ${req.method} ${req.path}`);
    res.status(404).json({ error: 'Not Found' });
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