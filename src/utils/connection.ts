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
 * Salesforce access tokens have the form `00Dxxxxxxxxx!sessionId`.
 * Extract the org ID prefix for logging — never used as a secret.
 */
function extractOrgId(token: string): string {
  const match = token.match(/^(00D[a-zA-Z0-9]{9,15})!/);
  return match ? match[1] : '(unknown)';
}

/**
 * Attempt a single userinfo call against the given login origin.
 * Returns the raw response body on HTTP 200, or null on 401/403
 * (so the caller can try the next candidate), or throws on other errors.
 */
async function tryUserinfo(loginOrigin: string, accessToken: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const url = new URL('/services/oauth2/userinfo', loginOrigin);
    const req = https.request(
      {
        method: 'GET',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 500) {
            // 3xx = wrong host (e.g. Lightning URL); 4xx = token rejected / not valid for this endpoint.
            // All 4xx (not just 401/403) must be treated as "skip to next candidate" — e.g.
            // test.salesforce.com returns 404 "Bad_Id" for production-org tokens.
            logger.debug(`Userinfo at ${loginOrigin} → HTTP ${res.statusCode} body: ${data.slice(0, 500)}`);
            resolve(null);
          } else {
            // 5xx = server-side error; propagate so the caller can fail loudly.
            logger.debug(`Userinfo at ${loginOrigin} → HTTP ${res.statusCode} body: ${data.slice(0, 500)}`);
            reject(new Error(`Userinfo at ${loginOrigin} failed (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on('error', (e: Error) => reject(new Error(`Userinfo request error: ${e.message}`)));
    req.end();
  });
}

/**
 * Parse an instance URL out of a Salesforce userinfo JSON body.
 */
function parseInstanceUrl(body: string): string {
  const json = JSON.parse(body);
  // `profile` takes the form https://<instance>.salesforce.com/id/...
  if (json.profile) return new URL(json.profile as string).origin;
  // Fallback: REST URL template
  if (json.urls?.rest) return new URL((json.urls.rest as string).replace('{version}', '')).origin;
  throw new Error('Salesforce userinfo response did not contain a usable instance URL field.');
}

/**
 * Discover the Salesforce instance URL for the given access token.
 *
 * Strategy (no configuration needed for multi-org support):
 *   1. If SALESFORCE_LOGIN_URL is set, use only that origin (explicit override).
 *   2. Otherwise try login.salesforce.com  → covers all production orgs.
 *   3. On 401/403 fall back to test.salesforce.com → covers sandbox orgs.
 *   4. If both fail the org likely has "Prevent Login from login.salesforce.com"
 *      enabled; the error message explains what to do.
 *
 * Results are cached by SHA-256(token) for MCP_CONNECTION_CACHE_TTL ms.
 */
/** Evict a token's cached instance URL, forcing re-validation on the next request. */
export function invalidateInstanceUrlCache(accessToken: string): void {
  const cacheKey = hashToken(accessToken);
  instanceUrlCache.delete(cacheKey);
  logger.debug('Invalidated cached instance URL for token — next pre-flight will re-validate against Salesforce');
}

export async function discoverInstanceUrl(accessToken: string): Promise<string> {
  cleanExpiredEntries();

  const cacheKey = hashToken(accessToken);
  const cached = instanceUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug('Using cached instance URL for token');
    return cached.instanceUrl;
  }

  const orgId = extractOrgId(accessToken);

  // If an explicit login URL is configured, use it exclusively (single-org override).
  const explicitLoginUrl = process.env.SALESFORCE_LOGIN_URL;
  const candidates = explicitLoginUrl
    ? [explicitLoginUrl]
    : ['https://login.salesforce.com', 'https://test.salesforce.com'];

  let instanceUrl: string | undefined;
  const tried: string[] = [];

  for (const candidate of candidates) {
    logger.salesforceCall('Discover instance URL via userinfo', { loginUrl: candidate, orgId });
    const body = await tryUserinfo(candidate, accessToken);
    if (body === null) {
      tried.push(candidate);
      logger.debug(`Userinfo at ${candidate} rejected token for org ${orgId} — trying next candidate`);
      continue;
    }
    try {
      instanceUrl = parseInstanceUrl(body);
    } catch (e: unknown) {
      throw new Error(
        `Failed to parse Salesforce userinfo response from ${candidate}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    logger.debug(`Discovered instance URL for org ${orgId} via ${candidate}: ${instanceUrl}`);
    break;
  }

  if (!instanceUrl) {
    const triedList = tried.join(', ');
    const hint = explicitLoginUrl
      ? `SALESFORCE_LOGIN_URL is set to ${explicitLoginUrl} — verify the URL is correct and that the Connected App has the "id" scope enabled.`
      : `Set the SALESFORCE_LOGIN_URL environment variable to your org's My Domain URL, or enable "Allow Login from login.salesforce.com" in Setup → Security → Session Settings.`;
    throw new Error(
      `Unable to discover Salesforce instance URL for org ${orgId}. ` +
      `All candidates returned 401/403/3xx: [${triedList}]. ${hint}`
    );
  }

  instanceUrlCache.set(cacheKey, { instanceUrl, expiresAt: Date.now() + INSTANCE_URL_CACHE_TTL });
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
