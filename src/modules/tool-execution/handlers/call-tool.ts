// ============================================================================
// Module C — call tool handler
//
// KEY CHANGE from the old architecture:
// - In LOCAL mode: resolves the user principal from the local JWT stored in
//   req.principal (set by Module A middleware), then asks Module B for a
//   valid Salesforce connection for that user.
// - In LEGACY mode: extracts the raw Salesforce access token from the
//   Authorization header (backward compatible).
//
// Tools never see OAuth details — they receive a jsforce.Connection.
// ============================================================================

import { asyncLocalStorage } from '../context.js';
import { logger } from '../../../shared/logger.js';
import { classifySalesforceError, formatClassifiedError, SalesforceErrorType } from '../../../shared/error-handler.js';
import { getSalesforceConnectionForRequest, SalesforceNotConnectedError, SalesforceReconnectRequiredError } from '../adapters/salesforce-adapter.js';
import { invalidateInstanceUrlCache } from '../../salesforce-connection/services/salesforce-client.js';

// Tool handlers
import { handleSearchObjects } from '../tools/search.js';
import { handleDescribeObject } from '../tools/describe.js';
import { handleQueryRecords } from '../tools/query.js';
import { handleAggregateQuery } from '../tools/aggregateQuery.js';
import { handleDMLRecords } from '../tools/dml.js';
import { handleManageObject } from '../tools/manageObject.js';
import { handleManageField } from '../tools/manageField.js';
import { handleManageFieldPermissions } from '../tools/manageFieldPermissions.js';
import { handleSearchAll } from '../tools/searchAll.js';
import { handleReadApex } from '../tools/readApex.js';
import { handleWriteApex } from '../tools/writeApex.js';
import { handleReadApexTrigger } from '../tools/readApexTrigger.js';
import { handleWriteApexTrigger } from '../tools/writeApexTrigger.js';
import { handleExecuteAnonymous } from '../tools/executeAnonymous.js';
import { handleManageDebugLogs } from '../tools/manageDebugLogs.js';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

function returnResult(name: string, startTime: number, result: ToolResult): ToolResult {
  if (result?.isError) {
    const text = result.content?.[0]?.text ?? '';
    const classified = classifySalesforceError(new Error(text));
    if (classified.type === SalesforceErrorType.INVALID_SESSION) {
      throw new Error(text);
    }
  }
  logger.toolResult(name, Date.now() - startTime, !result?.isError);
  return result;
}

export const callToolHandler = async (request: any): Promise<ToolResult> => {
  const startTime = Date.now();
  const toolName = request.params.name;

  try {
    const { name, arguments: args } = request.params;
    if (!args) throw new Error('Arguments are required');

    // Resolve Salesforce connection via the adapter
    const store = asyncLocalStorage.getStore() as any;
    const principal = store?.principal; // set by Module A middleware (local mode)
    const rawAuth = store?.headers?.['authorization'];
    const authStr = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
    const rawBearerToken = authStr?.startsWith('Bearer ') ? authStr.slice(7) : undefined;

    const conn = await getSalesforceConnectionForRequest(principal, rawBearerToken);
    logger.debug('Salesforce connection established');
    logger.toolCall(name, args);

    // Dispatch to the appropriate tool handler
    switch (name) {
      case 'salesforce_search_objects': {
        const { searchPattern } = args;
        if (!searchPattern) throw new Error('searchPattern is required');
        return returnResult(name, startTime, await handleSearchObjects(conn, searchPattern));
      }
      case 'salesforce_describe_object': {
        const { objectName } = args;
        if (!objectName) throw new Error('objectName is required');
        return returnResult(name, startTime, await handleDescribeObject(conn, objectName));
      }
      case 'salesforce_query_records': {
        if (!args.objectName || !Array.isArray(args.fields)) throw new Error('objectName and fields array are required');
        return returnResult(name, startTime, await handleQueryRecords(conn, args));
      }
      case 'salesforce_aggregate_query': {
        if (!args.objectName || !Array.isArray(args.selectFields) || !Array.isArray(args.groupByFields))
          throw new Error('objectName, selectFields, and groupByFields are required');
        return returnResult(name, startTime, await handleAggregateQuery(conn, args));
      }
      case 'salesforce_dml_records': {
        if (!args.operation || !args.objectName || !Array.isArray(args.records))
          throw new Error('operation, objectName, and records array are required');
        return returnResult(name, startTime, await handleDMLRecords(conn, args));
      }
      case 'salesforce_manage_object': {
        if (!args.operation || !args.objectName) throw new Error('operation and objectName are required');
        return returnResult(name, startTime, await handleManageObject(conn, args));
      }
      case 'salesforce_manage_field': {
        if (!args.operation || !args.objectName || !args.fieldName)
          throw new Error('operation, objectName, and fieldName are required');
        return returnResult(name, startTime, await handleManageField(conn, args));
      }
      case 'salesforce_manage_field_permissions': {
        if (!args.operation || !args.objectName || !args.fieldName)
          throw new Error('operation, objectName, and fieldName are required');
        return returnResult(name, startTime, await handleManageFieldPermissions(conn, args));
      }
      case 'salesforce_search_all': {
        if (!args.searchTerm || !Array.isArray(args.objects)) throw new Error('searchTerm and objects array are required');
        return returnResult(name, startTime, await handleSearchAll(conn, args));
      }
      case 'salesforce_read_apex':
        return returnResult(name, startTime, await handleReadApex(conn, args));
      case 'salesforce_write_apex': {
        if (!args.operation || !args.className || !args.body) throw new Error('operation, className, and body are required');
        return returnResult(name, startTime, await handleWriteApex(conn, args));
      }
      case 'salesforce_read_apex_trigger':
        return returnResult(name, startTime, await handleReadApexTrigger(conn, args));
      case 'salesforce_write_apex_trigger': {
        if (!args.operation || !args.triggerName || !args.body) throw new Error('operation, triggerName, and body are required');
        return returnResult(name, startTime, await handleWriteApexTrigger(conn, args));
      }
      case 'salesforce_execute_anonymous': {
        if (!args.apexCode) throw new Error('apexCode is required');
        return returnResult(name, startTime, await handleExecuteAnonymous(conn, args));
      }
      case 'salesforce_manage_debug_logs': {
        if (!args.operation || !args.username) throw new Error('operation and username are required');
        return returnResult(name, startTime, await handleManageDebugLogs(conn, args));
      }
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const classified = classifySalesforceError(error);
    logger.error(`Tool ${toolName} failed after ${duration}ms [${classified.type}]:`, classified.message);

    // Business errors from Module B — return clear user-facing messages
    if (error instanceof SalesforceNotConnectedError) {
      return {
        content: [{ type: 'text', text: `Salesforce account not connected. Please connect your Salesforce account via /salesforce/connect before using tools.` }],
        isError: true,
      };
    }
    if (error instanceof SalesforceReconnectRequiredError) {
      return {
        content: [{ type: 'text', text: `Salesforce connection expired or was revoked. Please reconnect your Salesforce account via /salesforce/connect.` }],
        isError: true,
      };
    }

    // INVALID_SESSION — trigger HTTP 401 for legacy token refresh flow
    if (classified.type === SalesforceErrorType.INVALID_SESSION) {
      const store = asyncLocalStorage.getStore() as any;
      const httpRes = store?.res;
      const rawToken = store?.headers?.['authorization']?.slice(7);
      if (rawToken) invalidateInstanceUrlCache(rawToken);

      if (httpRes && !httpRes.headersSent) {
        logger.warn(`[INVALID_SESSION] Returning HTTP 401 for ${toolName}`);
        httpRes.set('WWW-Authenticate', store?.wwwAuthenticate || 'Bearer');
        httpRes.status(401).json({ error: 'Unauthorized' });
        throw new Error('__INVALID_SESSION_401_SENT__');
      }
    }

    return {
      content: [{ type: 'text', text: formatClassifiedError(classified) }],
      isError: true,
    };
  }
};
