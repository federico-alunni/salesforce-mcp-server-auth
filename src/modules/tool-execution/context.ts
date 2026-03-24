// ============================================================================
// Module C — AsyncLocalStorage context for MCP request handling
// ============================================================================

import { AsyncLocalStorage } from 'async_hooks';

export const asyncLocalStorage = new AsyncLocalStorage<Record<string, any>>();
