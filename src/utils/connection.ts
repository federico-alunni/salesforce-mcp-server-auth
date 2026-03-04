import jsforce from 'jsforce';
import { ConnectionType, ConnectionConfig, SalesforceCLIResponse, RequestContext } from '../types/connection.js';
import https from 'https';
import querystring from 'querystring';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const execAsync = promisify(exec);

// Connection cache with TTL
interface CachedConnection {
  connection: any; // jsforce Connection type
  expiresAt: number;
  username?: string;
}

const connectionCache = new Map<string, CachedConnection>();
const CONNECTION_CACHE_TTL = parseInt(process.env.MCP_CONNECTION_CACHE_TTL || '300000'); // 5 minutes default

// Fixed cache key for the shared OAuth client-credentials connection
const OAUTH_SHARED_CACHE_KEY = 'oauth_shared';

/**
 * Validates that the required environment variables are present for the
 * configured MCP_AUTH_MODE.  Throws on misconfiguration so the server
 * fails fast at startup rather than on the first request.
 */
export function validateAuthConfig(): void {
  const authMode = process.env.MCP_AUTH_MODE || 'strict';

  if (authMode === 'oauth') {
    const missing: string[] = [];
    if (!process.env.OAUTH_CLIENT_ID)     missing.push('OAUTH_CLIENT_ID');
    if (!process.env.OAUTH_CLIENT_SECRET) missing.push('OAUTH_CLIENT_SECRET');
    if (!process.env.SALESFORCE_INSTANCE_URL) missing.push('SALESFORCE_INSTANCE_URL');
    if (missing.length > 0) {
      throw new Error(
        `MCP_AUTH_MODE=oauth requires the following environment variables: ${missing.join(', ')}`
      );
    }
    logger.info('Auth mode: oauth (client credentials). Shared connection will be created on first request.');
  } else if (authMode === 'strict') {
    logger.info('Auth mode: strict. Per-request OAuth headers required.');
  } else {
    throw new Error(
      `Invalid MCP_AUTH_MODE value "${authMode}". Supported values: strict, oauth`
    );
  }
}

/**
 * Get a cache key for a given access token
 * Uses first 8 chars of token for logging purposes
 */
function getCacheKey(accessToken: string): string {
  // Use a hash-like approach - first 8 chars for identification
  return `token_${accessToken.substring(0, 8)}`;
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
 * Creates a Salesforce connection using the OAuth 2.0 Client Credentials flow.
 * Reads OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, and SALESFORCE_INSTANCE_URL from env.
 */
async function createOAuthClientCredentialsConnection(): Promise<any> {
  const clientId = process.env.OAUTH_CLIENT_ID!;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET!;
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL!;

  logger.salesforceCall('OAuth 2.0 Client Credentials (MCP_AUTH_MODE=oauth)', { instanceUrl });

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
 * Get or create a Salesforce connection based on the configured MCP_AUTH_MODE.
 *
 * - strict (default): per-request OAuth credentials supplied via HTTP headers are required.
 * - oauth: a shared connection is established with the Salesforce org using the
 *   OAuth 2.0 Client Credentials flow (OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET).
 *   Per-request headers are ignored in this mode.
 */
export async function getConnectionForRequest(context?: RequestContext): Promise<any> {
  // Clean expired connections periodically
  cleanExpiredConnections();

  const authMode = process.env.MCP_AUTH_MODE || 'strict';

  // ── oauth mode ────────────────────────────────────────────────────────────
  if (authMode === 'oauth') {
    // Return cached shared connection if still valid
    const cached = connectionCache.get(OAUTH_SHARED_CACHE_KEY);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug('Using cached shared OAuth client-credentials connection');
      return cached.connection;
    }

    // Obtain a fresh token via client credentials flow
    const conn = await createOAuthClientCredentialsConnection();

    connectionCache.set(OAUTH_SHARED_CACHE_KEY, {
      connection: conn,
      expiresAt: Date.now() + CONNECTION_CACHE_TTL,
    });

    logger.debug('Created and cached new shared OAuth client-credentials connection');
    return conn;
  }

  // ── strict mode (default) ─────────────────────────────────────────────────
  if (!context?.salesforceAuth) {
    throw new Error(
      'OAuth authentication required. This MCP server requires per-request OAuth credentials via HTTP headers. ' +
      'Please provide the following headers: x-salesforce-access-token, x-salesforce-instance-url, ' +
      'x-salesforce-username (optional), and x-salesforce-user-id (optional).'
    );
  }

  // Per-user authentication
  const { accessToken, instanceUrl, username, userId } = context.salesforceAuth;

  // Check cache first
  const cacheKey = getCacheKey(accessToken);
  const cached = connectionCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    logger.debug(`Using cached connection for user: ${username || userId || 'unknown'}`);
    return cached.connection;
  }

  // Create new connection with OAuth token
  logger.userOperation('create-connection', username, userId);
  const conn = new jsforce.Connection({
    instanceUrl,
    accessToken,
  });

  // Add request/response logging
  setupConnectionLogging(conn);

  // Cache the connection
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

/**
 * Executes the Salesforce CLI command to get org information
 * @returns Parsed response from sf org display --json command
 */
async function getSalesforceOrgInfo(): Promise<SalesforceCLIResponse> {
  try {
    const command = 'sf org display --json';
    const cwdLog = process.cwd();
    logger.debug(`Executing Salesforce CLI command: ${command} in directory: ${cwdLog}`);

    // Use execAsync and handle both success and error cases
    let stdout = '';
    let stderr = '';
    let error: Error | { stdout?: string; stderr?: string } | null = null;
    try {
      const result = await execAsync(command);
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: any) {
      // If the command fails, capture stdout/stderr for diagnostics
      error = err;
      stdout = 'stdout' in err ? err.stdout || '' : '';
      stderr = 'stderr' in err ? err.stderr || '' : '';
    }


    // Log always the output for debug
    logger.verbose('[Salesforce CLI] STDOUT:', logger.truncate(stdout, 1000));
    if (stderr) {
      logger.warn('[Salesforce CLI] STDERR:', stderr);
    }
    // Try to parse stdout as JSON
    let response: SalesforceCLIResponse;
    try {
      response = JSON.parse(stdout);
    } catch (parseErr) {
      throw new Error(`Failed to parse Salesforce CLI JSON output.\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
    }

    // If the command failed (non-zero exit code), throw with details
    if (error || response.status !== 0) {
      throw new Error(`Salesforce CLI command failed.\nStatus: ${response.status}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`);
    }

    // Accept any org that returns accessToken and instanceUrl
    if (!response.result || !response.result.accessToken || !response.result.instanceUrl) {
      throw new Error(`Salesforce CLI did not return accessToken and instanceUrl.\nResult: ${JSON.stringify(response.result)}`);
    }

    return response;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('sf: command not found') || error.message.includes("'sf' is not recognized")) {
        throw new Error('Salesforce CLI (sf) is not installed or not in PATH. Please install the Salesforce CLI to use this authentication method.');
      }
    }
    throw new Error(`Failed to get Salesforce org info: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Creates a Salesforce connection using either username/password or OAuth 2.0 Client Credentials Flow
 * @param config Optional connection configuration
 * @returns Connected jsforce Connection instance
 */
export async function createSalesforceConnection(config?: ConnectionConfig) {
  // Determine connection type from environment variables or config
  const connectionType = config?.type || 
    (process.env.SALESFORCE_CONNECTION_TYPE as ConnectionType) || 
    ConnectionType.User_Password;
  
  // Set login URL from config or environment variable
  const loginUrl = config?.loginUrl || 
    process.env.SALESFORCE_INSTANCE_URL || 
    'https://login.salesforce.com';
  
  try {
    if (connectionType === ConnectionType.OAuth_2_0_Client_Credentials) {
      // OAuth 2.0 Client Credentials Flow
      const clientId = process.env.SALESFORCE_CLIENT_ID;
      const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
      
      if (!clientId || !clientSecret) {
        throw new Error('SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET are required for OAuth 2.0 Client Credentials Flow');
      }
      
      logger.salesforceCall('OAuth 2.0 Client Credentials authentication', { instanceUrl: loginUrl });
      
      // Get the instance URL from environment variable or config
      const instanceUrl = loginUrl;
      
      // Create the token URL
      const tokenUrl = new URL('/services/oauth2/token', instanceUrl);
      
      // Prepare the request body
      const requestBody = querystring.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      });
      
      // Make the token request
      const tokenResponse = await new Promise<any>((resolve, reject) => {
        const req = https.request({
          method: 'POST',
          hostname: tokenUrl.hostname,
          path: tokenUrl.pathname,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(requestBody)
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const parsedData = JSON.parse(data);
              if (res.statusCode !== 200) {
                reject(new Error(`OAuth token request failed: ${parsedData.error} - ${parsedData.error_description}`));
              } else {
                resolve(parsedData);
              }
            } catch (e: unknown) {
              reject(new Error(`Failed to parse OAuth response: ${e instanceof Error ? e.message : String(e)}`));
            }
          });
        });
        
        req.on('error', (e) => {
          reject(new Error(`OAuth request error: ${e.message}`));
        });
        
        req.write(requestBody);
        req.end();
      });
      
      logger.debug('OAuth token received successfully');
      
      // Create connection with the access token
      const conn = new jsforce.Connection({
        instanceUrl: tokenResponse.instance_url,
        accessToken: tokenResponse.access_token
      });
      
      return conn;
    } else if (connectionType === ConnectionType.Salesforce_CLI) {
      // Salesforce CLI authentication using sf org display
      logger.salesforceCall('Salesforce CLI authentication');
      
      // Execute sf org display --json command
      const orgInfo = await getSalesforceOrgInfo();
      
      // Create connection with the access token from CLI
      const conn = new jsforce.Connection({
        instanceUrl: orgInfo.result.instanceUrl,
        accessToken: orgInfo.result.accessToken
      });
      
      logger.info(`Connected to Salesforce org: ${orgInfo.result.username} (${orgInfo.result.alias || 'No alias'})`);
      
      return conn;
    } else {
      // Default: Username/Password Flow with Security Token
      const username = process.env.SALESFORCE_USERNAME;
      const password = process.env.SALESFORCE_PASSWORD;
      const token = process.env.SALESFORCE_TOKEN;
      
      if (!username || !password) {
        throw new Error('SALESFORCE_USERNAME and SALESFORCE_PASSWORD are required for Username/Password authentication');
      }
      
      logger.salesforceCall('Username/Password authentication', { username, loginUrl });
      
      // Create connection with login URL
      const conn = new jsforce.Connection({ loginUrl });
      
      await conn.login(
        username,
        password + (token || '')
      );
      
      logger.debug('Successfully authenticated with username/password');
      
      return conn;
    }
  } catch (error) {
    logger.error('Error connecting to Salesforce:', error);
    throw error;
  }
}