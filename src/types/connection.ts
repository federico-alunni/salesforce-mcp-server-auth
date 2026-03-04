/**
 * Enum representing the available Salesforce connection types
 */
export enum ConnectionType {
  /**
   * Standard username/password authentication with security token
   * Requires SALESFORCE_USERNAME, SALESFORCE_PASSWORD, and optionally SALESFORCE_TOKEN
   */
  User_Password = 'User_Password',
  
  /**
   * OAuth 2.0 Client Credentials Flow using client ID and secret
   * Requires SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET
   */
  OAuth_2_0_Client_Credentials = 'OAuth_2.0_Client_Credentials',
  
  /**
   * Salesforce CLI authentication using sf org display command
   * Requires Salesforce CLI to be installed and an authenticated org
   */
  Salesforce_CLI = 'Salesforce_CLI'
}

/**
 * Configuration options for Salesforce connection
 */
export interface ConnectionConfig {
  /**
   * The type of connection to use
   * @default ConnectionType.User_Password
   */
  type?: ConnectionType;
  
  /**
   * The login URL for Salesforce instance
   * @default 'https://login.salesforce.com'
   */
  loginUrl?: string;
}

/**
 * Interface for Salesforce CLI org display response
 */
export interface SalesforceCLIResponse {
  status: number;
  result: {
    id: string;
    apiVersion: string;
    accessToken: string;
    instanceUrl: string;
    username: string;
    clientId: string;
    connectedStatus: string;
    alias?: string;
  };
  warnings?: string[];
}

/**
 * OAuth authentication context provided in request metadata
 * This allows per-request authentication with user-specific tokens
 */
export interface SalesforceOAuthContext {
  /**
   * OAuth access token for the user
   */
  accessToken: string;
  
  /**
   * Salesforce instance URL (e.g., https://na50.salesforce.com)
   */
  instanceUrl: string;
  
  /**
   * Salesforce user ID (optional, for logging purposes)
   */
  userId?: string;
  
  /**
   * Salesforce username (optional, for logging purposes)
   */
  username?: string;
}

/**
 * OAuth 2.0 Client Credentials context supplied via request headers.
 * Used when x-mcp-auth-mode: oauth is sent on a per-request basis.
 */
export interface OAuthClientCredentialsContext {
  /**
   * Connected App client ID (x-salesforce-client-id header)
   */
  clientId: string;

  /**
   * Connected App client secret (x-salesforce-client-secret header)
   */
  clientSecret: string;

  /**
   * Salesforce instance URL (x-salesforce-instance-url header)
   */
  instanceUrl: string;
}

/**
 * Request context containing optional OAuth credentials
 */
export interface RequestContext {
  /**
   * Auth mode requested for this specific call (x-mcp-auth-mode header).
   * Defaults to 'strict' when not provided.
   */
  requestAuthMode?: 'strict' | 'oauth';

  /**
   * strict mode: per-request access token supplied via HTTP headers.
   */
  salesforceAuth?: SalesforceOAuthContext;

  /**
   * oauth mode: client credentials supplied via HTTP headers.
   */
  oauthCredentials?: OAuthClientCredentialsContext;
}
