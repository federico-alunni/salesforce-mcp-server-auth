# External Integrations

**Analysis Date:** 2026-03-24

## APIs & External Services

**Salesforce Platform APIs:**
- Salesforce OAuth 2.0 - Used for token exchange, refresh, revoke, and browser-based account linking in `src/modules/salesforce-connection/services/connection-service.ts`.
  - SDK/Client: native `fetch` plus `jsforce`
  - Auth: `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_LOGIN_URL` in `src/shared/config/index.ts` and `.env.example`
- Salesforce userinfo endpoint - Used to discover the org instance URL dynamically in legacy mode in `src/modules/salesforce-connection/services/salesforce-client.ts`.
  - SDK/Client: native `https` request
  - Auth: incoming `Authorization: Bearer <salesforce_access_token>` header handled in `src/modules/mcp-auth/middleware.ts`
- Salesforce REST / sObject APIs - Used for CRUD-style record operations via `conn.sobject(...)` in `src/modules/tool-execution/tools/dml.ts`, `src/modules/tool-execution/tools/manageField.ts`, and `src/modules/tool-execution/tools/manageFieldPermissions.ts`.
  - SDK/Client: `jsforce`
  - Auth: resolved access token from `src/modules/tool-execution/adapters/salesforce-adapter.ts`
- Salesforce Query APIs - SOQL and SOSL are executed in `src/modules/tool-execution/tools/query.ts`, `src/modules/tool-execution/tools/aggregateQuery.ts`, `src/modules/tool-execution/tools/search.ts`, and `src/modules/tool-execution/tools/searchAll.ts`.
  - SDK/Client: `jsforce`
  - Auth: same resolved Salesforce access context from `src/modules/salesforce-connection/services/connection-service.ts`
- Salesforce Metadata API - Used for custom object and field management in `src/modules/tool-execution/tools/manageObject.ts` and `src/modules/tool-execution/tools/manageField.ts`.
  - SDK/Client: `jsforce` metadata client
  - Auth: Salesforce access token from local connection storage or legacy bearer passthrough
- Salesforce Tooling API - Used for Apex class/trigger reads and writes, anonymous execution, trace flags, debug levels, and log retrieval in `src/modules/tool-execution/tools/writeApex.ts`, `src/modules/tool-execution/tools/writeApexTrigger.ts`, `src/modules/tool-execution/tools/executeAnonymous.ts`, and `src/modules/tool-execution/tools/manageDebugLogs.ts`.
  - SDK/Client: `jsforce` tooling client
  - Auth: Salesforce access token resolved in `src/modules/tool-execution/adapters/salesforce-adapter.ts`

**MCP Clients / Protocol Consumers:**
- MCP JSON-RPC clients - The server exposes the MCP tool surface on `POST /mcp` in `src/modules/tool-execution/routes/mcp-routes.ts` using Streamable HTTP from `@modelcontextprotocol/sdk`.
  - SDK/Client: `@modelcontextprotocol/sdk`
  - Auth: either local MCP bearer tokens or direct Salesforce bearer tokens depending on `MCP_AUTH_MODE` in `src/shared/config/index.ts`

## Data Storage

**Databases:**
- Not applicable - No relational or external database is detected.
  - Connection: Not applicable
  - Client: File-based JSON store in `src/shared/storage/file-store.ts`

**File Storage:**
- Local filesystem only - Users and Salesforce connection records are stored under `MCP_DATA_DIR` in JSON files through `src/shared/storage/file-store.ts`.

**Caching:**
- In-memory maps only - Pending OAuth states and decrypted access tokens are cached in `src/modules/salesforce-connection/services/connection-service.ts`, and instance URL discovery is cached in `src/modules/salesforce-connection/services/salesforce-client.ts`.

## Authentication & Identity

**Auth Provider:**
- Custom MCP OAuth provider in local mode - OAuth metadata, authorization code flow, PKCE handling, and HS256 JWT issuance are implemented in `src/modules/mcp-auth/routes/oauth-routes.ts` and `src/modules/mcp-auth/services/token-service.ts`.
  - Implementation: local OAuth authorization endpoint plus JWT bearer validation in `src/modules/mcp-auth/middleware.ts`
- Salesforce as upstream identity and API authorization provider - In legacy mode the incoming Salesforce bearer token is passed through, validated by calling userinfo, and used directly for all tool calls in `src/modules/tool-execution/routes/mcp-routes.ts` and `src/modules/salesforce-connection/services/salesforce-client.ts`.
  - Implementation: bearer passthrough with instance discovery and optional token proxy metadata in `src/modules/mcp-auth/routes/legacy-oauth-routes.ts`

## Monitoring & Observability

**Error Tracking:**
- None detected - Errors are logged locally through `src/shared/logger.ts` and classified in `src/shared/error-handler.ts`.

**Logs:**
- Structured stderr logging - HTTP request/response logs, audit logs, tool timing, and Salesforce API tracing are implemented in `src/shared/logger.ts` and documented in `LOGGING_GUIDE.md`.

## CI/CD & Deployment

**Hosting:**
- Generic Node hosting - The app is started with `node dist/index.js` per `README.md` and `TRANSPORT_GUIDE.md`; no platform-specific deployment files are detected.

**CI Pipeline:**
- Not detected - No GitHub Actions, pipeline YAML, or other CI configuration is present in the inspected root files.

## Environment Configuration

**Required env vars:**
- `MCP_SERVER_PORT`, `MCP_SERVER_URL` - Server binding and callback base URL in `src/shared/config/index.ts`
- `MCP_AUTH_MODE` - Selects `local` vs `legacy` auth behavior in `src/shared/config/index.ts`
- `MCP_JWT_SECRET` - Required for local MCP token signing in `src/modules/mcp-auth/services/token-service.ts`
- `MCP_ACCESS_TOKEN_TTL`, `MCP_AUTH_CODE_TTL`, `MCP_ALLOWED_CLIENT_IDS`, `MCP_OAUTH_SCOPES` - Local OAuth behavior in `src/shared/config/index.ts`
- `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_LOGIN_URL`, `SALESFORCE_OAUTH_SCOPES` - Salesforce Connected App and identity endpoint settings in `src/shared/config/index.ts`
- `MCP_CONNECTION_CACHE_TTL` - Instance URL cache TTL in `src/modules/salesforce-connection/services/salesforce-client.ts`
- `MCP_DATA_DIR`, `MCP_ENCRYPTION_KEY` - File storage location and AES key for stored tokens in `src/shared/config/index.ts` and `src/shared/security/encryption.ts`
- `MCP_LOG_LEVEL`, `MCP_LOG_TIMESTAMPS` - Logging controls in `src/shared/config/index.ts`
- `MCP_LEGACY_OAUTH_SCOPES`, `MCP_OAUTH_WELL_KNOWN_ALIASES`, `MCP_AUTH_SERVER_METADATA_CACHE_TTL` - Legacy OAuth compatibility in `src/modules/mcp-auth/routes/legacy-oauth-routes.ts`

**Secrets location:**
- Environment variables only - Names are documented in `.env.example`; secret values are expected in a real `.env` or hosting environment and are not stored in the repository.

## Webhooks & Callbacks

**Incoming:**
- `GET /salesforce/callback` - Receives Salesforce OAuth browser redirects in local mode in `src/modules/salesforce-connection/routes/salesforce-routes.ts`
- `POST /mcp` - Receives all MCP JSON-RPC tool/list/call traffic in `src/modules/tool-execution/routes/mcp-routes.ts`
- `GET /health` - Health endpoint for liveness checks in `src/shared/http/express-app.ts`

**Outgoing:**
- `POST {SALESFORCE_LOGIN_URL}/services/oauth2/token` - Authorization code exchange and refresh in `src/modules/salesforce-connection/services/connection-service.ts`
- `POST {SALESFORCE_LOGIN_URL}/services/oauth2/revoke` - Disconnect-time token revocation in `src/modules/salesforce-connection/services/connection-service.ts`
- `GET {SALESFORCE_LOGIN_URL}/services/oauth2/userinfo` - Instance URL discovery in `src/modules/salesforce-connection/services/salesforce-client.ts`
- `GET {SALESFORCE_LOGIN_URL}/.well-known/openid-configuration` - Legacy mode upstream auth server metadata discovery in `src/modules/mcp-auth/routes/legacy-oauth-routes.ts`
- Salesforce org instance REST, Tooling, Metadata, and query endpoints - Reached through `jsforce` from `src/modules/tool-execution/tools/*.ts`

## MCP and Salesforce Touchpoints

- MCP transport is Streamable HTTP only; it is implemented with `StreamableHTTPServerTransport` in `src/modules/tool-execution/routes/mcp-routes.ts` and described in `TRANSPORT_GUIDE.md`.
- Fifteen Salesforce-facing tools are registered in `src/modules/tool-execution/handlers/list-tools.ts`, covering schema search, describe, SOQL, aggregate queries, SOSL, DML, metadata changes, Apex management, anonymous Apex, and debug log management.
- The integration boundary is intentionally stateless in legacy mode: every request carries a Salesforce bearer token, and instance discovery is repeated or cache-backed in `src/modules/salesforce-connection/services/salesforce-client.ts`.
- The local-mode integration adds a first-party identity layer plus persisted Salesforce account linking in `src/modules/mcp-auth/routes/oauth-routes.ts` and `src/modules/salesforce-connection/services/connection-service.ts`.

---

*Integration audit: 2026-03-24*
