import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { getConnectionForRequest, invalidateInstanceUrlCache } from "../../utils/connection.js";
import { logger } from "../../utils/logger.js";
import { classifySalesforceError, formatClassifiedError, SalesforceErrorType } from "../../utils/errorHandler.js";
import { RequestContext } from "../../types/connection.js";
import { asyncLocalStorage } from "../context.js";
import { handleSearchObjects } from "../../tools/search.js";
import { handleDescribeObject } from "../../tools/describe.js";
import { handleQueryRecords, QueryArgs } from "../../tools/query.js";
import { handleAggregateQuery, AggregateQueryArgs } from "../../tools/aggregateQuery.js";
import { handleDMLRecords, DMLArgs } from "../../tools/dml.js";
import { handleManageObject, ManageObjectArgs } from "../../tools/manageObject.js";
import { handleManageField, ManageFieldArgs } from "../../tools/manageField.js";
import { handleManageFieldPermissions, ManageFieldPermissionsArgs } from "../../tools/manageFieldPermissions.js";
import { handleSearchAll, SearchAllArgs, WithClause } from "../../tools/searchAll.js";
import { handleReadApex, ReadApexArgs } from "../../tools/readApex.js";
import { handleWriteApex, WriteApexArgs } from "../../tools/writeApex.js";
import { handleReadApexTrigger, ReadApexTriggerArgs } from "../../tools/readApexTrigger.js";
import { handleWriteApexTrigger, WriteApexTriggerArgs } from "../../tools/writeApexTrigger.js";
import { handleExecuteAnonymous, ExecuteAnonymousArgs } from "../../tools/executeAnonymous.js";
import { handleManageDebugLogs, ManageDebugLogsArgs } from "../../tools/manageDebugLogs.js";

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

export const callToolHandler = async (request: CallToolRequest) => {
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
        const objects = searchArgs.objects as Array<Record<string, unknown>>;
        if (!objects.every(obj => obj.name && Array.isArray(obj.fields))) {
          throw new Error('Each object must specify name and fields array');
        }
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

      default: {
        logger.warn(`Unknown tool called: ${name}`);
        const unknownResp = {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
        logger.info('Tool response:', unknownResp);
        return unknownResp;
      }
    }
  } catch (error) {
    const duration = Date.now() - startTime;
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
        throw new Error('__INVALID_SESSION_401_SENT__');
      } else {
        // SSE stream already started — HTTP 401 is not possible now.
        // Cache has been evicted; the next request with this token will hit the
        // pre-flight, call userinfo, get 401/403, and return HTTP 401 to Claude.ai.
        logger.warn(`[INVALID_SESSION] SSE headers already sent for ${toolName} — cache evicted; HTTP 401 will be returned on next request to trigger token refresh`);
      }
    }

    const errorMessage = formatClassifiedError(classified);
    const errorResp = {
      content: [{ type: "text", text: errorMessage }],
      isError: true,
    };
    logger.info('Tool response (error):', errorResp);
    return errorResp;
  }
};
