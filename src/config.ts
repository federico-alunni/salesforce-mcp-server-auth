export const port = parseInt(process.env.MCP_SERVER_PORT || '3000');
export const serverUrl = process.env.MCP_SERVER_URL || 'https://salesforce-mcp-server-org.up.railway.app';
export const oauthScopes = process.env.MCP_OAUTH_SCOPES || 'api refresh_token offline_access web openid id';
export const salesforceLoginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
export const wwwAuthValue = `Bearer resource_metadata="${serverUrl}/.well-known/oauth-protected-resource/mcp", scope="${oauthScopes}"`;
export const oauthAliases = (process.env.MCP_OAUTH_WELL_KNOWN_ALIASES ?? '/.well-known/oauth-protected-resource/mcp')
  .split(',').map(p => p.trim()).filter(p => p.length > 0);
export const authServerMetadataCacheTTL = parseInt(process.env.MCP_AUTH_SERVER_METADATA_CACHE_TTL || '3600000');
