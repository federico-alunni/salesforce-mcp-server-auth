// ============================================================================
// Shared domain types — contracts between modules
// ============================================================================

/** Principal resolved from a locally-issued MCP token. */
export interface LocalPrincipal {
  userId: string;
  sessionId?: string;
  scopes: string[];
}

/** Salesforce connection state persisted per user. */
export type SalesforceConnectionStatus =
  | 'connected'
  | 'refresh_failed'
  | 'reconnect_required'
  | 'revoked';

export interface SalesforceConnectionRecord {
  id: string;
  localUserId: string;
  salesforceUserId?: string;
  salesforceOrgId?: string;
  instanceUrl: string;
  accessToken: string;          // encrypted at rest
  refreshToken: string;         // encrypted at rest
  scopes: string[];
  issuedAt: number;             // epoch ms
  expiresAt?: number;           // epoch ms (access token)
  status: SalesforceConnectionStatus;
  createdAt: number;
  updatedAt: number;
}

/** Minimal context passed to tool handlers — no OAuth details leak here. */
export interface SalesforceAccessContext {
  accessToken: string;
  instanceUrl: string;
  orgId?: string;
}

/** Local user record. */
export interface LocalUser {
  id: string;
  displayName: string;
  createdAt: number;
}

/** OAuth authorization code record (short-lived). */
export interface AuthorizationCodeRecord {
  code: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scopes: string[];
  expiresAt: number;
}

/** Stored MCP session token metadata. */
export interface McpTokenRecord {
  jti: string;
  userId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Service interfaces — contracts between modules (dependency inversion)
// ---------------------------------------------------------------------------

/** Module B exposes this to Module C. */
export interface ISalesforceConnectionService {
  getValidAccessContext(userId: string): Promise<SalesforceAccessContext>;
  isUserConnected(userId: string): Promise<boolean>;
  connectAccount(userId: string, authorizationCode: string, redirectUri: string): Promise<SalesforceConnectionRecord>;
  handleOAuthCallback(state: string, code: string): Promise<SalesforceConnectionRecord>;
  disconnectAccount(userId: string): Promise<void>;
  refreshAccessToken(userId: string): Promise<SalesforceAccessContext>;
}

/** Module A exposes this to request handlers. */
export interface ITokenService {
  generateAccessToken(userId: string, scopes: string[]): Promise<string>;
  validateAccessToken(token: string): Promise<LocalPrincipal | null>;
}

/** Module C uses this to resolve the principal from any MCP request. */
export interface IToolContextResolver {
  resolvePrincipal(headers: Record<string, string | string[] | undefined>): Promise<LocalPrincipal>;
}

// ---------------------------------------------------------------------------
// Salesforce error types (re-exported from shared)
// ---------------------------------------------------------------------------

export enum SalesforceErrorType {
  INVALID_SESSION = 'INVALID_SESSION',
  INSUFFICIENT_ACCESS = 'INSUFFICIENT_ACCESS',
  INVALID_FIELD = 'INVALID_FIELD',
  INVALID_OPERATION = 'INVALID_OPERATION',
  QUERY_TIMEOUT = 'QUERY_TIMEOUT',
  API_LIMIT_EXCEEDED = 'API_LIMIT_EXCEEDED',
  UNKNOWN = 'UNKNOWN',
}

export interface ClassifiedError {
  type: SalesforceErrorType;
  message: string;
  originalError: unknown;
  statusCode: string;
  isRetryable: boolean;
  userMessage: string;
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export type AuthMode = 'local' | 'legacy';
