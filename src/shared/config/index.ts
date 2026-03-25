// ============================================================================
// Centralised configuration — single source of truth for all modules
// ============================================================================

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === 'true' || v === '1';
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export const port = envInt('PORT', envInt('MCP_SERVER_PORT', 3000));
export const serverUrl = env('MCP_SERVER_URL', 'http://localhost:3000');

// ---------------------------------------------------------------------------
// Auth mode — feature flag for migration
// ---------------------------------------------------------------------------
import type { AuthMode } from '../../types/index.js';
export const authMode: AuthMode = (env('MCP_AUTH_MODE', 'local') as AuthMode);

// ---------------------------------------------------------------------------
// MCP Auth (Module A)
// ---------------------------------------------------------------------------
export const mcpAuth = {
  jwtSecret: env('MCP_JWT_SECRET', ''),   // MUST be set in production
  jwtIssuer: env('MCP_JWT_ISSUER', serverUrl),
  jwtAudience: env('MCP_JWT_AUDIENCE', serverUrl),
  accessTokenTTL: envInt('MCP_ACCESS_TOKEN_TTL', 3600),          // seconds
  refreshTokenTTL: envInt('MCP_REFRESH_TOKEN_TTL', 2592000),      // seconds (30 days)
  authCodeTTL: envInt('MCP_AUTH_CODE_TTL', 300),                  // seconds
  allowedClientIds: env('MCP_ALLOWED_CLIENT_IDS', '*').split(',').map(s => s.trim()),
  oauthScopes: env('MCP_OAUTH_SCOPES', 'mcp:tools mcp:read'),
};

// ---------------------------------------------------------------------------
// Salesforce Connection (Module B)
// ---------------------------------------------------------------------------
export const salesforce = {
  loginUrl: env('SALESFORCE_LOGIN_URL', 'https://login.salesforce.com'),
  clientId: env('SALESFORCE_CLIENT_ID', ''),
  clientSecret: env('SALESFORCE_CLIENT_SECRET', ''),
  callbackPath: '/salesforce/callback',
  get callbackUrl() { return `${serverUrl}${this.callbackPath}`; },
  scopes: env('SALESFORCE_OAUTH_SCOPES', 'api refresh_token offline_access web openid id'),
  connectionCacheTTL: envInt('MCP_CONNECTION_CACHE_TTL', 300_000),
};

// ---------------------------------------------------------------------------
// Storage & Security (Module B persistence)
// ---------------------------------------------------------------------------
export const storage = {
  dataDir: env('MCP_DATA_DIR', '.data'),
  encryptionKey: env('MCP_ENCRYPTION_KEY', ''),  // 32-byte hex for AES-256-GCM
};

// ---------------------------------------------------------------------------
// Legacy compat — values used by the old proxy flow
// ---------------------------------------------------------------------------
export const legacy = {
  oauthScopes: env('MCP_LEGACY_OAUTH_SCOPES', 'api refresh_token offline_access web openid id'),
  wwwAuthValue: `Bearer resource_metadata="${serverUrl}/.well-known/oauth-protected-resource", scope="api refresh_token offline_access web openid id"`,
  oauthAliases: env('MCP_OAUTH_WELL_KNOWN_ALIASES', '/.well-known/oauth-protected-resource/mcp')
    .split(',').map(p => p.trim()).filter(p => p.length > 0),
  authServerMetadataCacheTTL: envInt('MCP_AUTH_SERVER_METADATA_CACHE_TTL', 3_600_000),
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
export const logging = {
  level: env('MCP_LOG_LEVEL', 'INFO').toUpperCase(),
  timestamps: envBool('MCP_LOG_TIMESTAMPS', true),
};
