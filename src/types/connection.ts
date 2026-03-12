/**
 * Request context passed to the connection utility.
 * The Bearer access token is extracted from the HTTP Authorization header
 * by the transport layer; the connection utility uses it to discover the
 * Salesforce instance URL via the userinfo endpoint and build a jsforce
 * Connection — no secrets or instance URLs need to be configured in advance.
 */
export interface RequestContext {
  /** OAuth access token extracted from `Authorization: Bearer <token>` */
  accessToken: string;
}
