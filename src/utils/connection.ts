import jsforce from 'jsforce';
import { RequestContext, OAuthClientCredentialsContext } from '../types/connection.js';
import https from 'https';
import querystring from 'querystring';
import { logger } from './logger.js';

// Connection cache with TTL
interface CachedConnection {
  connection: any; // jsforce Connection type
  expiresAt: number;
  username?: string;
}

const connectionCache = new Map<string, CachedConnection>();
const CONNECTION_CACHE_TTL = parseInt(process.env.MCP_CONNECTION_CACHE_TTL || '300000'); // 5 minutes default

/**
 * Validates that MCP_AUTH_MODE is one of the accepted values.
 * Credentials are no longer held in env vars — they arrive as per-request
 * headers, so no secret validation is needed at startup.
 */
export function validateAuthConfig(): void {
  const authMode = process.env.MCP_AUTH_MODE || 'strict';
  const valid = ['strict', 'oauth', 'both'];

  if (!valid.includes(authMode)) {
    throw new Error(
      `Invalid MCP_AUTH_MODE value "${authMode}". Supported values: strict, oauth, both`
    );
  }

  logger.info(`Auth mode: ${authMode}. ${
    authMode === 'strict' ? 'Only per-request access-token headers accepted.' :
    authMode === 'oauth'  ? 'Only per-request client-credentials headers accepted.' :
                            'Both strict and oauth per-request headers accepted.'
  }`);
}

/**
 * Get a cache key for a given access token.
 * Uses the full token as the key to avoid collisions between different tokens
 * that share the same prefix. The cache is in-memory only and never logged.
 */
function getCacheKey(accessToken: string): string {
  return `token_${accessToken}`;
}

/**
 * Clean expired connections from cache
 */
function cleanExpiredConnections(): void {
  const now = Date.now();
  for (const [key, cached] of connectionCache.entries()) {
    if (cached.expiresAt < now) {
      logger.debug(`Removing expired connection from cache: ${key}`);
      connectionCache.delete(key);
    }
  }
}

/**
 * Build a per-org cache key for client-credentials connections.
 */
function getOAuthCacheKey(instanceUrl: string, clientId: string): string {
  return `oauth_${instanceUrl}_${clientId.substring(0, 8)}`;
}

/**
 * Creates a Salesforce connection using the OAuth 2.0 Client Credentials flow.
 * Credentials are supplied per-request via headers, enabling multi-org usage.
 */
async function createOAuthClientCredentialsConnection(credentials: OAuthClientCredentialsContext): Promise<any> {
  const { clientId, clientSecret, instanceUrl } = credentials;

  logger.salesforceCall('OAuth 2.0 Client Credentials (x-mcp-auth-mode: oauth)', { instanceUrl });

  const tokenUrl = new URL('/services/oauth2/token', instanceUrl);
  const requestBody = querystring.stringify({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const tokenResponse = await new Promise<any>((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: tokenUrl.hostname,
        path: tokenUrl.pathname,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(
                `OAuth token request failed (HTTP ${res.statusCode}): ` +
                `${parsed.error} - ${parsed.error_description}`
              ));
            } else {
              resolve(parsed);
            }
          } catch (e: unknown) {
            reject(new Error(`Failed to parse OAuth token response: ${e instanceof Error ? e.message : String(e)}`));
          }
        });
      }
    );

    req.on('error', (e) => reject(new Error(`OAuth request error: ${e.message}`)));
    req.write(requestBody);
    req.end();
  });

  logger.debug('OAuth client-credentials token received successfully');

  const conn = new jsforce.Connection({
    instanceUrl: tokenResponse.instance_url,
    accessToken: tokenResponse.access_token,
  });

  setupConnectionLogging(conn);
  return conn;
}

/**
 * Get or create a Salesforce connection based on:
 *   - `x-mcp-auth-mode` request header  → 'strict' (default) or 'oauth'
 *   - `MCP_AUTH_MODE` environment var    → 'strict' | 'oauth' | 'both' (server gate)
 *
 * strict: requires x-salesforce-access-token + x-salesforce-instance-url headers.
 * oauth:  requires x-salesforce-client-id + x-salesforce-client-secret +
 *         x-salesforce-instance-url headers. Supports multiple orgs simultaneously.
 */
export async function getConnectionForRequest(context?: RequestContext): Promise<any> {
  // Clean expired connections periodically
  cleanExpiredConnections();

  const serverMode = process.env.MCP_AUTH_MODE || 'strict';
  const requestMode = context?.requestAuthMode ?? 'strict';

  // Enforce server-level gate
  if (serverMode !== 'both' && serverMode !== requestMode) {
    throw new Error(
      `This server is configured for MCP_AUTH_MODE=${serverMode} but the request ` +
      `supplied x-mcp-auth-mode: ${requestMode}. ` +
      `Set MCP_AUTH_MODE=both on the server to accept both modes.`
    );
  }

  // ── oauth mode ────────────────────────────────────────────────────────────
  if (requestMode === 'oauth') {
    if (!context?.oauthCredentials) {
      throw new Error(
        'x-mcp-auth-mode: oauth requires the following headers: ' +
        'x-salesforce-client-id, x-salesforce-client-secret, x-salesforce-instance-url.'
      );
    }

    const { clientId, instanceUrl } = context.oauthCredentials;
    const cacheKey = getOAuthCacheKey(instanceUrl, clientId);
    const cached = connectionCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      logger.debug(`Using cached OAuth client-credentials connection for: ${instanceUrl}`);
      return cached.connection;
    }

    const conn = await createOAuthClientCredentialsConnection(context.oauthCredentials);

    connectionCache.set(cacheKey, {
      connection: conn,
      expiresAt: Date.now() + CONNECTION_CACHE_TTL,
    });

    logger.debug(`Created and cached OAuth client-credentials connection for: ${instanceUrl}`);
    return conn;
  }

  // ── strict mode (default) ─────────────────────────────────────────────────
  if (!context?.salesforceAuth) {
    throw new Error(
      'x-mcp-auth-mode: strict (default) requires per-request OAuth credentials via HTTP headers. ' +
      'Required: x-salesforce-access-token, x-salesforce-instance-url. ' +
      'Optional: x-salesforce-username, x-salesforce-user-id.'
    );
  }

  const { accessToken, instanceUrl, username, userId } = context.salesforceAuth;

  const cacheKey = getCacheKey(accessToken);
  const cached = connectionCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    logger.debug(`Using cached connection for user: ${username || userId || 'unknown'}`);
    return cached.connection;
  }

  logger.userOperation('create-connection', username, userId);
  const conn = new jsforce.Connection({
    instanceUrl,
    accessToken,
  });

  setupConnectionLogging(conn);

  connectionCache.set(cacheKey, {
    connection: conn,
    expiresAt: Date.now() + CONNECTION_CACHE_TTL,
    username: username || userId,
  });

  logger.debug(`Created and cached new connection for user: ${username || userId || 'unknown'}`);
  return conn;
}

/**
 * Setup logging for Salesforce API calls on a connection
 */
function setupConnectionLogging(conn: any): void {
  // Intercept request method if available
  if (conn._baseUrl) {
    const originalRequest = conn.request.bind(conn);
    conn.request = function(info: any, callback?: any) {
      const startTime = Date.now();
      const method = info.method || 'GET';
      const url = typeof info === 'string' ? info : (info.url || 'unknown');
      
      logger.salesforceRequest(method, url, info.body);
      
      // Handle both callback and promise style
      if (callback) {
        return originalRequest(info, function(err: any, result: any) {
          const duration = Date.now() - startTime;
          if (err) {
            logger.debug(`[SF API Error] ${method} ${url} - ${err.message || err} (${duration}ms)`);
          } else {
            logger.salesforceResponse(method, url, 200, result, duration);
          }
          callback(err, result);
        });
      } else {
        return originalRequest(info).then(
          (result: any) => {
            const duration = Date.now() - startTime;
            logger.salesforceResponse(method, url, 200, result, duration);
            return result;
          },
          (err: any) => {
            const duration = Date.now() - startTime;
            logger.debug(`[SF API Error] ${method} ${url} - ${err.message || err} (${duration}ms)`);
            throw err;
          }
        );
      }
    };
  }
  
  // Intercept query method
  const originalQuery = conn.query.bind(conn);
  conn.query = function(soql: string, callback?: any) {
    const startTime = Date.now();
    logger.soqlQuery(soql);
    
    if (callback) {
      return originalQuery(soql, function(err: any, result: any) {
        const duration = Date.now() - startTime;
        if (!err && result) {
          logger.soqlResult(soql, result.totalSize || result.records?.length || 0, duration);
        }
        callback(err, result);
      });
    } else {
      return originalQuery(soql).then(
        (result: any) => {
          const duration = Date.now() - startTime;
          logger.soqlResult(soql, result.totalSize || result.records?.length || 0, duration);
          return result;
        },
        (err: any) => {
          throw err;
        }
      );
    }
  };
}
