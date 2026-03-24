// ============================================================================
// Module B — Salesforce Client Factory
// Builds jsforce Connection instances from an access context.
// Shared between local and legacy modes.
// ============================================================================

import jsforce from 'jsforce';
import { createHash } from 'crypto';
import https from 'https';
import { salesforce } from '../../../shared/config/index.js';
import { logger } from '../../../shared/logger.js';

// ---------------------------------------------------------------------------
// Instance URL discovery (used only in legacy mode)
// ---------------------------------------------------------------------------
const instanceUrlCache = new Map<string, { instanceUrl: string; expiresAt: number }>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cleanExpiredEntries() {
  const now = Date.now();
  for (const [key, cached] of instanceUrlCache.entries()) {
    if (cached.expiresAt < now) instanceUrlCache.delete(key);
  }
}

async function tryUserinfo(loginOrigin: string, accessToken: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const url = new URL('/services/oauth2/userinfo', loginOrigin);
    const req = https.request({
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else if (res.statusCode! >= 300 && res.statusCode! < 500) resolve(null);
        else reject(new Error(`Userinfo at ${loginOrigin} failed (HTTP ${res.statusCode})`));
      });
    });
    req.on('error', (e: Error) => reject(new Error(`Userinfo request error: ${e.message}`)));
    req.end();
  });
}

function parseInstanceUrl(body: string): string {
  const json = JSON.parse(body);
  if (json.profile) return new URL(json.profile).origin;
  if (json.urls?.rest) return new URL(json.urls.rest.replace('{version}', '')).origin;
  throw new Error('Salesforce userinfo response did not contain a usable instance URL field.');
}

export function invalidateInstanceUrlCache(accessToken: string) {
  instanceUrlCache.delete(hashToken(accessToken));
  logger.debug('Invalidated cached instance URL for token');
}

export async function discoverInstanceUrl(accessToken: string): Promise<string> {
  cleanExpiredEntries();
  const cacheKey = hashToken(accessToken);
  const cached = instanceUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.instanceUrl;

  const explicitLoginUrl = process.env.SALESFORCE_LOGIN_URL;
  const candidates = explicitLoginUrl
    ? [explicitLoginUrl]
    : ['https://login.salesforce.com', 'https://test.salesforce.com'];

  let instanceUrl: string | undefined;
  const tried: string[] = [];

  for (const candidate of candidates) {
    logger.salesforceCall('Discover instance URL via userinfo', { loginUrl: candidate });
    const body = await tryUserinfo(candidate, accessToken);
    if (body === null) { tried.push(candidate); continue; }
    instanceUrl = parseInstanceUrl(body);
    break;
  }

  if (!instanceUrl) {
    throw new Error(`Unable to discover Salesforce instance URL. All candidates returned 401/403/3xx: [${tried.join(', ')}].`);
  }

  instanceUrlCache.set(cacheKey, { instanceUrl, expiresAt: Date.now() + salesforce.connectionCacheTTL });
  return instanceUrl;
}

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

export function createSalesforceConnection(accessToken: string, instanceUrl: string): any {
  const conn = new jsforce.Connection({ instanceUrl, accessToken });
  setupConnectionLogging(conn);
  return conn;
}

/**
 * Legacy mode: build connection from raw Bearer token (auto-discovers instance URL).
 */
export async function createConnectionFromToken(accessToken: string): Promise<any> {
  const instanceUrl = await discoverInstanceUrl(accessToken);
  return createSalesforceConnection(accessToken, instanceUrl);
}

// ---------------------------------------------------------------------------
// Logging interceptors
// ---------------------------------------------------------------------------

function setupConnectionLogging(conn: any) {
  if ((conn as any)._baseUrl) {
    const originalRequest = conn.request.bind(conn);
    conn.request = function (info: any, callback?: any) {
      const startTime = Date.now();
      const method = info.method || 'GET';
      const url = typeof info === 'string' ? info : (info.url || 'unknown');
      logger.salesforceRequest(method, url, info.body);

      if (callback) {
        return originalRequest(info, function (err: any, result: any) {
          const duration = Date.now() - startTime;
          if (err) logger.debug(`[SF API Error] ${method} ${url} - ${err.message || err} (${duration}ms)`);
          else logger.salesforceResponse(method, url, 200, result, duration);
          callback(err, result);
        });
      }
      return originalRequest(info).then(
        (result: any) => { logger.salesforceResponse(method, url, 200, result, Date.now() - startTime); return result; },
        (err: any) => { logger.debug(`[SF API Error] ${method} ${url} - ${err.message || err} (${Date.now() - startTime}ms)`); throw err; },
      );
    } as any;
  }

  const originalQuery = conn.query.bind(conn);
  conn.query = function (soql: string, callback?: any) {
    const startTime = Date.now();
    logger.soqlQuery(soql);

    if (callback) {
      return originalQuery(soql, function (err: any, result: any) {
        if (!err && result) logger.soqlResult(soql, result.totalSize || result.records?.length || 0, Date.now() - startTime);
        callback(err, result);
      });
    }
    return originalQuery(soql).then(
      (result: any) => { logger.soqlResult(soql, result.totalSize || result.records?.length || 0, Date.now() - startTime); return result; },
      (err: any) => { throw err; },
    );
  } as any;
}
