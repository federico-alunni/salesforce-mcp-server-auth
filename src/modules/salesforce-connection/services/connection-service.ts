// ============================================================================
// Module B — Salesforce Connection Service
// Manages the lifecycle of Salesforce connections per local user:
//   connect → store tokens → refresh → disconnect
// ============================================================================

import { randomUUID } from 'crypto';
import type {
  ISalesforceConnectionService,
  SalesforceAccessContext,
  SalesforceConnectionRecord,
  SalesforceConnectionStatus,
} from '../../../types/index.js';
import { salesforce, serverUrl } from '../../../shared/config/index.js';
import { logger } from '../../../shared/logger.js';
import { encrypt, decrypt } from '../../../shared/security/encryption.js';
import { findOne, upsert, remove } from '../../../shared/storage/file-store.js';

const COLLECTION = 'salesforce_connections';

// In-memory pending OAuth state → userId mapping (short-lived)
const pendingStates = new Map<string, { userId: string; redirectUri: string; expiresAt: number }>();

// Access token cache (avoid decrypting on every tool call)
const accessTokenCache = new Map<string, { accessToken: string; instanceUrl: string; expiresAt: number }>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getConnection(userId: string): SalesforceConnectionRecord | undefined {
  return findOne<SalesforceConnectionRecord>(COLLECTION, r => r.localUserId === userId);
}

function saveConnection(record: SalesforceConnectionRecord): void {
  upsert(COLLECTION, record);
}

async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<{
  access_token: string;
  refresh_token: string;
  instance_url: string;
  id: string;
  issued_at: string;
  scope: string;
}> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: salesforce.clientId,
    client_secret: salesforce.clientSecret,
    redirect_uri: redirectUri,
  });

  const response = await fetch(`${salesforce.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Salesforce token exchange failed (${response.status}): ${errorBody}`);
  }

  return response.json();
}

async function refreshTokenFromSalesforce(refreshToken: string): Promise<{
  access_token: string;
  instance_url: string;
  issued_at: string;
}> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: salesforce.clientId,
    client_secret: salesforce.clientSecret,
  });

  const response = await fetch(`${salesforce.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Salesforce token refresh failed (${response.status}): ${errorBody}`);
  }

  return response.json();
}

function parseSalesforceIdentityUrl(idUrl: string): { orgId?: string; userId?: string } {
  // idUrl format: https://login.salesforce.com/id/00Dxxxxxxxx/005yyyyyyyy
  try {
    const parts = new URL(idUrl).pathname.split('/').filter(Boolean);
    const idIdx = parts.indexOf('id');
    if (idIdx >= 0 && parts.length > idIdx + 2) {
      return { orgId: parts[idIdx + 1], userId: parts[idIdx + 2] };
    }
  } catch { /* ignore */ }
  return {};
}

// ---------------------------------------------------------------------------
// Public API — implements ISalesforceConnectionService
// ---------------------------------------------------------------------------

export const salesforceConnectionService: ISalesforceConnectionService = {

  async getValidAccessContext(userId: string): Promise<SalesforceAccessContext> {
    const record = getConnection(userId);
    if (!record) {
      throw new SalesforceNotConnectedError(userId);
    }

    if (record.status === 'revoked' || record.status === 'reconnect_required') {
      throw new SalesforceReconnectRequiredError(userId, record.status);
    }

    // Check cache
    const cached = accessTokenCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return { accessToken: cached.accessToken, instanceUrl: cached.instanceUrl, orgId: record.salesforceOrgId };
    }

    // Check if access token might still be valid (Salesforce tokens last ~2h)
    if (record.expiresAt && record.expiresAt > Date.now()) {
      const accessToken = decrypt(record.accessToken);
      const ctx = { accessToken, instanceUrl: record.instanceUrl, orgId: record.salesforceOrgId };
      accessTokenCache.set(userId, { ...ctx, expiresAt: record.expiresAt });
      return ctx;
    }

    // Token expired or no expiresAt — try refresh
    return this.refreshAccessToken(userId);
  },

  async isUserConnected(userId: string): Promise<boolean> {
    const record = getConnection(userId);
    return !!record && record.status === 'connected';
  },

  async connectAccount(_userId: string, _authorizationCode: string, _redirectUri: string): Promise<SalesforceConnectionRecord> {
    // Not used directly — see initiateConnect + handleOAuthCallback
    throw new Error('Use initiateConnect() and handleOAuthCallback() instead');
  },

  async handleOAuthCallback(stateParam: string, code: string): Promise<SalesforceConnectionRecord> {
    const pending = pendingStates.get(stateParam);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingStates.delete(stateParam);
      throw new Error('Invalid or expired OAuth state parameter');
    }
    pendingStates.delete(stateParam);

    const { userId, redirectUri } = pending;
    logger.auditLog('salesforce_connect_callback', userId);

    const tokens = await exchangeCodeForTokens(code, redirectUri);
    const identity = parseSalesforceIdentityUrl(tokens.id);

    const now = Date.now();
    const record: SalesforceConnectionRecord = {
      id: randomUUID(),
      localUserId: userId,
      salesforceUserId: identity.userId,
      salesforceOrgId: identity.orgId,
      instanceUrl: tokens.instance_url,
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(tokens.refresh_token),
      scopes: tokens.scope ? tokens.scope.split(' ') : [],
      issuedAt: parseInt(tokens.issued_at) || now,
      expiresAt: now + 7200_000, // SF access tokens ~2h
      status: 'connected',
      createdAt: now,
      updatedAt: now,
    };

    // Remove any existing connection for this user
    remove<SalesforceConnectionRecord>(COLLECTION, r => r.localUserId === userId);
    saveConnection(record);

    // Cache the access token
    accessTokenCache.set(userId, {
      accessToken: tokens.access_token,
      instanceUrl: tokens.instance_url,
      expiresAt: record.expiresAt!,
    });

    logger.auditLog('salesforce_connected', userId, {
      orgId: identity.orgId,
      instanceUrl: tokens.instance_url,
    });

    return record;
  },

  async disconnectAccount(userId: string): Promise<void> {
    const record = getConnection(userId);
    if (!record) return;

    // Try to revoke token at Salesforce
    try {
      const refreshToken = decrypt(record.refreshToken);
      await fetch(`${salesforce.loginUrl}/services/oauth2/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
    } catch (e) {
      logger.warn('Failed to revoke Salesforce token (continuing with local cleanup)', e);
    }

    remove<SalesforceConnectionRecord>(COLLECTION, r => r.localUserId === userId);
    accessTokenCache.delete(userId);
    logger.auditLog('salesforce_disconnected', userId);
  },

  async refreshAccessToken(userId: string): Promise<SalesforceAccessContext> {
    const record = getConnection(userId);
    if (!record) throw new SalesforceNotConnectedError(userId);

    logger.auditLog('salesforce_token_refresh', userId);

    try {
      const refreshToken = decrypt(record.refreshToken);
      const result = await refreshTokenFromSalesforce(refreshToken);

      const now = Date.now();
      record.accessToken = encrypt(result.access_token);
      record.instanceUrl = result.instance_url;
      record.issuedAt = parseInt(result.issued_at) || now;
      record.expiresAt = now + 7200_000;
      record.status = 'connected';
      record.updatedAt = now;
      saveConnection(record);

      accessTokenCache.set(userId, {
        accessToken: result.access_token,
        instanceUrl: result.instance_url,
        expiresAt: record.expiresAt,
      });

      logger.auditLog('salesforce_token_refreshed', userId);
      return {
        accessToken: result.access_token,
        instanceUrl: result.instance_url,
        orgId: record.salesforceOrgId,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // invalid_grant = refresh token revoked or expired
      if (msg.includes('invalid_grant') || msg.includes('expired') || msg.includes('revoked')) {
        record.status = 'reconnect_required';
        record.updatedAt = Date.now();
        saveConnection(record);
        accessTokenCache.delete(userId);
        logger.auditLog('salesforce_reconnect_required', userId, { reason: msg });
        throw new SalesforceReconnectRequiredError(userId, 'reconnect_required');
      }

      record.status = 'refresh_failed';
      record.updatedAt = Date.now();
      saveConnection(record);
      logger.auditLog('salesforce_refresh_failed', userId, { reason: msg });
      throw error;
    }
  },
};

// ---------------------------------------------------------------------------
// Connect initiation (generates SF OAuth URL)
// ---------------------------------------------------------------------------

export function initiateConnect(userId: string): string {
  const state = randomUUID();
  pendingStates.set(state, {
    userId,
    redirectUri: salesforce.callbackUrl,
    expiresAt: Date.now() + 600_000, // 10 min
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: salesforce.clientId,
    redirect_uri: salesforce.callbackUrl,
    scope: salesforce.scopes,
    state,
    prompt: 'login consent',
  });

  return `${salesforce.loginUrl}/services/oauth2/authorize?${params.toString()}`;
}

// Cleanup expired states
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingStates.entries()) {
    if (val.expiresAt < now) pendingStates.delete(key);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Custom errors for clean handling in Module C
// ---------------------------------------------------------------------------

export class SalesforceNotConnectedError extends Error {
  constructor(public userId: string) {
    super(`Salesforce account not connected. Please connect your Salesforce account first.`);
    this.name = 'SalesforceNotConnectedError';
  }
}

export class SalesforceReconnectRequiredError extends Error {
  constructor(public userId: string, public status: SalesforceConnectionStatus) {
    super(`Salesforce connection requires re-authorization. Please reconnect your Salesforce account.`);
    this.name = 'SalesforceReconnectRequiredError';
  }
}
