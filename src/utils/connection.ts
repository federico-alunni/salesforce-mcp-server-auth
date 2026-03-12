import jsforce from 'jsforce';
import { createHash } from 'crypto';
import { RequestContext } from '../types/connection.js';
import https from 'https';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Instance URL discovery cache
// ---------------------------------------------------------------------------
// We never store raw access tokens. The cache key is a SHA-256 digest of the
// token so that the in-memory map contains no secrets even if it were somehow
// inspected at runtime.
// ---------------------------------------------------------------------------

interface CachedInstanceUrl {
  instanceUrl: string;
  expiresAt: number;
}

const instanceUrlCache = new Map<string, CachedInstanceUrl>();
const INSTANCE_URL_CACHE_TTL = parseInt(process.env.MCP_CONNECTION_CACHE_TTL || '300000'); // 5 min default

/** SHA-256 digest of the token — used as the non-sensitive cache key. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Remove stale entries so the map does not grow unboundedly. */
function cleanExpiredEntries(): void {
  const now = Date.now();
  for (const [key, cached] of instanceUrlCache.entries()) {
    if (cached.expiresAt < now) {
      instanceUrlCache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Instance URL discovery via Salesforce userinfo endpoint
// ---------------------------------------------------------------------------

/**
 * Calls the Salesforce userinfo endpoint using the supplied Bearer token and
 * returns the instance URL for that org.
 *
 * The login URL defaults to `https://login.salesforce.com` but can be
 * overridden with the `SALESFORCE_LOGIN_URL` env var (e.g. to point at
 * `https://test.salesforce.com` for sandbox orgs).
 *
 * Results are cached by SHA-256(token) for `INSTANCE_URL_CACHE_TTL` ms to
 * avoid hitting the userinfo endpoint on every single tool call.
 */
async function discoverInstanceUrl(accessToken: string): Promise<string> {
  cleanExpiredEntries();

  const cacheKey = hashToken(accessToken);
  const cached = instanceUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug('Using cached instance URL for token');
    return cached.instanceUrl;
  }

  const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
  const userinfoUrl = new URL('/services/oauth2/userinfo', loginUrl);

  logger.salesforceCall('Discover instance URL via userinfo', { loginUrl: userinfoUrl.origin });

  const body = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        method: 'GET',
        hostname: userinfoUrl.hostname,
        path: userinfoUrl.pathname,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(
              `Salesforce userinfo request failed (HTTP ${res.statusCode}). ` +
              `Verify that the access token is valid and not expired.`
            ));
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on('error', (e: Error) => reject(new Error(`Userinfo request error: ${e.message}`)));
    req.end();
  });

  let instanceUrl: string;
  try {
    const json = JSON.parse(body);
    // `profile` is always present and takes the form https://<instance>.salesforce.com/id/...
    // We extract just the origin (scheme + host) as the instance URL.
    if (json.profile) {
      instanceUrl = new URL(json.profile as string).origin;
    } else if (json.urls?.rest) {
      // Fallback: derive from the REST URL template
      instanceUrl = new URL((json.urls.rest as string).replace('{version}', '')).origin;
    } else {
      throw new Error('Salesforce userinfo response did not contain a usable instance URL field.');
    }
  } catch (e: unknown) {
    throw new Error(
      `Failed to parse Salesforce userinfo response: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  instanceUrlCache.set(cacheKey, { instanceUrl, expiresAt: Date.now() + INSTANCE_URL_CACHE_TTL });
  logger.debug(`Discovered and cached instance URL: ${instanceUrl}`);
  return instanceUrl;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a jsforce Connection for the requesting user.
 *
 * The access token is sourced from the `Authorization: Bearer <token>` HTTP
 * header (extracted by the transport layer and placed in `context`). The
 * Salesforce instance URL is discovered automatically by calling the
 * userinfo endpoint — no instance URL needs to be configured or passed by
 * the client.
 */
export async function getConnectionForRequest(context: RequestContext): Promise<any> {
  const { accessToken } = context;
  const instanceUrl = await discoverInstanceUrl(accessToken);

  logger.debug(`Building jsforce connection for instance: ${instanceUrl}`);

  const conn = new jsforce.Connection({ instanceUrl, accessToken });
  setupConnectionLogging(conn);
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
