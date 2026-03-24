// ============================================================================
// Module B — Salesforce Connection Layer — public API
// ============================================================================

export { salesforceConnectionService, initiateConnect, SalesforceNotConnectedError, SalesforceReconnectRequiredError } from './services/connection-service.js';
export { createSalesforceConnection, createConnectionFromToken, discoverInstanceUrl, invalidateInstanceUrlCache } from './services/salesforce-client.js';
export { createSalesforceRoutes, createSalesforceCallbackRoute } from './routes/salesforce-routes.js';
