// ============================================================================
// Module A — MCP Auth Layer — public API
// ============================================================================

export { authMiddleware, send401 } from './middleware.js';
export { tokenService } from './services/token-service.js';
export { getOrCreateUser, getUserById } from './services/user-service.js';
export { createLocalOAuthRoutes } from './routes/oauth-routes.js';
export { createLegacyOAuthRoutes } from './routes/legacy-oauth-routes.js';
