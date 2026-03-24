// ============================================================================
// Module C — list tools handler
// ============================================================================

import { SEARCH_OBJECTS } from '../tools/search.js';
import { DESCRIBE_OBJECT } from '../tools/describe.js';
import { QUERY_RECORDS } from '../tools/query.js';
import { AGGREGATE_QUERY } from '../tools/aggregateQuery.js';
import { DML_RECORDS } from '../tools/dml.js';
import { MANAGE_OBJECT } from '../tools/manageObject.js';
import { MANAGE_FIELD } from '../tools/manageField.js';
import { MANAGE_FIELD_PERMISSIONS } from '../tools/manageFieldPermissions.js';
import { SEARCH_ALL } from '../tools/searchAll.js';
import { READ_APEX } from '../tools/readApex.js';
import { WRITE_APEX } from '../tools/writeApex.js';
import { READ_APEX_TRIGGER } from '../tools/readApexTrigger.js';
import { WRITE_APEX_TRIGGER } from '../tools/writeApexTrigger.js';
import { EXECUTE_ANONYMOUS } from '../tools/executeAnonymous.js';
import { MANAGE_DEBUG_LOGS } from '../tools/manageDebugLogs.js';

export const ALL_TOOLS = [
  SEARCH_OBJECTS, DESCRIBE_OBJECT, QUERY_RECORDS, AGGREGATE_QUERY, DML_RECORDS,
  MANAGE_OBJECT, MANAGE_FIELD, MANAGE_FIELD_PERMISSIONS, SEARCH_ALL,
  READ_APEX, WRITE_APEX, READ_APEX_TRIGGER, WRITE_APEX_TRIGGER,
  EXECUTE_ANONYMOUS, MANAGE_DEBUG_LOGS,
];

export const listToolsHandler = async () => ({ tools: ALL_TOOLS });
