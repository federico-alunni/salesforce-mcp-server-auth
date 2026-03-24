// ============================================================================
// Module C — Salesforce Adapter
// Resolves a jsforce Connection for the authenticated user.
// Decouples tool execution from auth details.
// ============================================================================

import { authMode } from '../../../shared/config/index.js';
import { logger } from '../../../shared/logger.js';
import type { LocalPrincipal } from '../../../types/index.js';
import { salesforceConnectionService, SalesforceNotConnectedError, SalesforceReconnectRequiredError } from '../../salesforce-connection/index.js';
import { createSalesforceConnection, createConnectionFromToken } from '../../salesforce-connection/services/salesforce-client.js';

/**
 * Get a jsforce Connection for the given request context.
 *
 * - In LOCAL mode: resolves the user's stored Salesforce tokens via Module B.
 * - In LEGACY mode: uses the raw Bearer token from the Authorization header.
 */
export async function getSalesforceConnectionForRequest(
  principal: LocalPrincipal | undefined,
  rawBearerToken: string | undefined,
): Promise<any> {

  if (authMode === 'local') {
    if (!principal) {
      throw new Error('No authenticated user principal. Please authenticate first.');
    }

    const ctx = await salesforceConnectionService.getValidAccessContext(principal.userId);
    logger.debug(`Resolved SF access context for user=${principal.userId} instance=${ctx.instanceUrl}`);
    return createSalesforceConnection(ctx.accessToken, ctx.instanceUrl);
  }

  // Legacy mode — token comes directly from Authorization header
  if (!rawBearerToken) {
    throw new Error('Missing or malformed Authorization header. Expected: Authorization: Bearer <salesforce_access_token>');
  }

  logger.debug('Legacy mode: building connection from raw Bearer token');
  return createConnectionFromToken(rawBearerToken);
}

export { SalesforceNotConnectedError, SalesforceReconnectRequiredError };
