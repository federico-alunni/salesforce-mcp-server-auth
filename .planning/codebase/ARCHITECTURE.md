# Architecture

**Analysis Date:** 2026-03-24

## Pattern Overview

**Overall:** Feature-modular Express service with a layered MCP request pipeline

**Key Characteristics:**
- `src/shared/http/express-app.ts` is the composition root that assembles all runtime modules and route trees.
- `src/modules/mcp-auth`, `src/modules/salesforce-connection`, and `src/modules/tool-execution` are separated by service contracts defined in `src/types/index.ts`.
- Runtime behavior branches on `MCP_AUTH_MODE` from `src/shared/config/index.ts`, so the same server supports both local MCP-issued auth and legacy Salesforce bearer-token passthrough.

## Layers

**CLI / Process Bootstrap:**
- Purpose: Start the Node.js process, load environment variables, and fail fast on unhandled startup errors.
- Location: `src/index.ts`
- Contains: Shebang entrypoint, `dotenv/config` import, `startServer()` call, fatal error logging.
- Depends on: `src/shared/http/express-app.ts`, `src/shared/logger.ts`
- Used by: The npm package binary configured in `package.json` as `salesforce-connector`.

**Composition / HTTP Host Layer:**
- Purpose: Build the Express application, install cross-cutting middleware, and mount module routes.
- Location: `src/shared/http/express-app.ts`
- Contains: JSON/urlencoded parsing, permissive CORS middleware, request/response logging, info routes, health route, 404 handler, auth-mode route selection.
- Depends on: `src/shared/config/index.ts`, `src/shared/logger.ts`, `src/modules/mcp-auth/*`, `src/modules/salesforce-connection/*`, `src/modules/tool-execution/*`
- Used by: `src/index.ts`, integration tests in `src/test/integration.test.ts`

**Shared Infrastructure Layer:**
- Purpose: Centralize configuration, logging, storage, encryption, and shared error classification.
- Location: `src/shared/config/index.ts`, `src/shared/logger.ts`, `src/shared/storage/file-store.ts`, `src/shared/security/encryption.ts`, `src/shared/error-handler.ts`
- Contains: Env parsing, logger singleton, JSON file persistence, AES-256-GCM token protection, Salesforce error classification and formatting.
- Depends on: Node standard library and shared domain types from `src/types/index.ts`
- Used by: All three feature modules and tests.

**Module A — MCP Auth Layer:**
- Purpose: Authenticate MCP clients and expose OAuth metadata/token endpoints for local mode, or proxy legacy OAuth behavior in legacy mode.
- Location: `src/modules/mcp-auth/`
- Contains: `middleware.ts`, `routes/oauth-routes.ts`, `routes/legacy-oauth-routes.ts`, `services/token-service.ts`, `services/auth-code-service.ts`, `services/user-service.ts`
- Depends on: `src/shared/config/index.ts`, `src/shared/logger.ts`, `src/shared/storage/file-store.ts`, `src/types/index.ts`
- Used by: `src/shared/http/express-app.ts`, `src/modules/salesforce-connection/routes/salesforce-routes.ts`, `src/modules/tool-execution/routes/mcp-routes.ts`

**Module B — Salesforce Connection Layer:**
- Purpose: Manage Salesforce account linking, token persistence, refresh, disconnect, and jsforce connection creation.
- Location: `src/modules/salesforce-connection/`
- Contains: `services/connection-service.ts`, `services/salesforce-client.ts`, `routes/salesforce-routes.ts`
- Depends on: `src/shared/config/index.ts`, `src/shared/logger.ts`, `src/shared/storage/file-store.ts`, `src/shared/security/encryption.ts`, `src/types/index.ts`, `jsforce`
- Used by: `src/shared/http/express-app.ts`, `src/modules/tool-execution/adapters/salesforce-adapter.ts`

**Module C — Tool Execution Layer:**
- Purpose: Host MCP protocol handling, resolve the correct Salesforce connection, and dispatch tool calls.
- Location: `src/modules/tool-execution/`
- Contains: `routes/mcp-routes.ts`, `mcp-server.ts`, `context.ts`, `adapters/salesforce-adapter.ts`, `handlers/call-tool.ts`, `handlers/list-tools.ts`, `tools/*.ts`
- Depends on: `@modelcontextprotocol/sdk`, `src/modules/salesforce-connection/*`, `src/modules/mcp-auth/middleware.ts`, `src/shared/error-handler.ts`, `src/shared/logger.ts`
- Used by: `src/shared/http/express-app.ts`

## Data Flow

**Startup and HTTP Composition:**

1. `src/index.ts` loads env values via `dotenv/config` and calls `startServer()` from `src/shared/http/express-app.ts`.
2. `startServer()` reads config from `src/shared/config/index.ts`, logs effective runtime mode, builds the app with `createApp()`, and binds `app.listen(port)`.
3. `createApp()` installs body parsers, CORS, request logging, info/health endpoints, then conditionally mounts:
   - local or legacy OAuth endpoints from `src/modules/mcp-auth/routes/*.ts`
   - Salesforce linking routes from `src/modules/salesforce-connection/routes/salesforce-routes.ts` in local mode
   - authenticated MCP routes from `src/modules/tool-execution/routes/mcp-routes.ts`

**Local MCP Authentication Flow:**

1. `GET /oauth/authorize` in `src/modules/mcp-auth/routes/oauth-routes.ts` renders a simple HTML login form after validating PKCE and client metadata.
2. `POST /oauth/authorize` calls `getOrCreateUser()` from `src/modules/mcp-auth/services/user-service.ts`, then generates a short-lived authorization code with `generateAuthorizationCode()` in `src/modules/mcp-auth/services/auth-code-service.ts`.
3. `POST /oauth/token` redeems that code and issues a signed local JWT through `tokenService.generateAccessToken()` in `src/modules/mcp-auth/services/token-service.ts`.
4. `authMiddleware` in `src/modules/mcp-auth/middleware.ts` validates the JWT on `/mcp` and `/salesforce/*`, attaching `req.principal` for downstream modules.

**Salesforce Account Linking Flow (local mode only):**

1. `GET /salesforce/connect` in `src/modules/salesforce-connection/routes/salesforce-routes.ts` calls `initiateConnect()` in `src/modules/salesforce-connection/services/connection-service.ts`.
2. `initiateConnect()` creates an in-memory OAuth state entry and returns a Salesforce authorization URL using config from `src/shared/config/index.ts`.
3. `GET /salesforce/callback` calls `salesforceConnectionService.handleOAuthCallback()`, which exchanges the code for Salesforce tokens, parses the identity URL for org/user IDs, encrypts tokens with `src/shared/security/encryption.ts`, and persists the connection through `src/shared/storage/file-store.ts`.
4. Later tool requests call `salesforceConnectionService.getValidAccessContext()` to read, decrypt, cache, or refresh Salesforce access tokens before creating a jsforce connection.

**Legacy Auth + Tool Execution Flow:**

1. `authMiddleware` in `src/modules/mcp-auth/middleware.ts` only checks for a Bearer token and rejects obviously expired JWT-shaped tokens.
2. `POST /mcp` in `src/modules/tool-execution/routes/mcp-routes.ts` preflights the token by calling `discoverInstanceUrl()` from `src/modules/salesforce-connection/services/salesforce-client.ts`.
3. `getSalesforceConnectionForRequest()` in `src/modules/tool-execution/adapters/salesforce-adapter.ts` builds a jsforce connection directly from the raw bearer token.
4. Tool handlers in `src/modules/tool-execution/tools/*.ts` execute against the discovered Salesforce instance without using persisted local-user state.

**MCP Request Processing Flow:**

1. `POST /mcp` in `src/modules/tool-execution/routes/mcp-routes.ts` creates or reuses a `StreamableHTTPServerTransport`, keyed by `Mcp-Session-Id`.
2. The route stores request-scoped data in `AsyncLocalStorage` from `src/modules/tool-execution/context.ts`, including headers, `req.principal`, the Express response object, and the `WWW-Authenticate` value.
3. `createMCPServer()` in `src/modules/tool-execution/mcp-server.ts` registers `tools/list` and `tools/call` handlers.
4. `callToolHandler()` in `src/modules/tool-execution/handlers/call-tool.ts` resolves a jsforce connection through the adapter, validates the request arguments for the selected tool, and dispatches to a specific implementation in `src/modules/tool-execution/tools/*.ts`.
5. Tool results are normalized into MCP response payloads; classified session failures can be converted into HTTP 401 responses for legacy clients.

**State Management:**
- Process-wide configuration is read once from `src/shared/config/index.ts`.
- Request-scoped state is carried with `AsyncLocalStorage` in `src/modules/tool-execution/context.ts`.
- Persistent user and connection records are stored as JSON collections in `.data/` via `src/shared/storage/file-store.ts`.
- Sensitive Salesforce tokens are encrypted before persistence by `src/shared/security/encryption.ts`.
- Short-lived in-memory state exists in:
  - `src/modules/mcp-auth/services/auth-code-service.ts` for authorization codes
  - `src/modules/salesforce-connection/services/connection-service.ts` for pending Salesforce OAuth state and access-token cache
  - `src/modules/salesforce-connection/services/salesforce-client.ts` for instance URL cache
  - `src/modules/tool-execution/routes/mcp-routes.ts` for MCP transport sessions

## Key Abstractions

**Shared Service Contracts:**
- Purpose: Define the boundaries between auth, connection management, and tool execution.
- Examples: `ISalesforceConnectionService`, `ITokenService`, `IToolContextResolver` in `src/types/index.ts`
- Pattern: Dependency inversion through TypeScript interfaces and small service objects.

**Local Principal:**
- Purpose: Represent the authenticated MCP user without exposing token internals.
- Examples: `LocalPrincipal` in `src/types/index.ts`, `req.principal` in `src/modules/mcp-auth/middleware.ts`
- Pattern: Middleware-attached request identity passed to downstream modules.

**Salesforce Access Context:**
- Purpose: Pass only the data required to create a jsforce connection.
- Examples: `SalesforceAccessContext` in `src/types/index.ts`, returned by `salesforceConnectionService.getValidAccessContext()` in `src/modules/salesforce-connection/services/connection-service.ts`
- Pattern: Narrow DTO separating OAuth/token persistence from tool execution.

**Salesforce Adapter:**
- Purpose: Hide auth-mode differences from tool handlers.
- Examples: `getSalesforceConnectionForRequest()` in `src/modules/tool-execution/adapters/salesforce-adapter.ts`
- Pattern: Adapter/facade over local persisted auth and legacy bearer-token auth.

**Tool Module Contract:**
- Purpose: Keep each Salesforce capability self-contained and registerable with MCP.
- Examples: `src/modules/tool-execution/tools/query.ts`, `src/modules/tool-execution/tools/manageField.ts`, `src/modules/tool-execution/tools/executeAnonymous.ts`
- Pattern: Each file exports a tool descriptor constant and a `handle...` function that accepts a jsforce connection plus typed-ish args.

## Entry Points

**Process Entry Point:**
- Location: `src/index.ts`
- Triggers: Package binary execution (`salesforce-connector`) or direct `node dist/index.js`
- Responsibilities: Load env config, start the Express server, terminate on fatal startup failure.

**HTTP App Factory:**
- Location: `src/shared/http/express-app.ts`
- Triggers: `startServer()` and tests in `src/test/integration.test.ts`
- Responsibilities: Compose middleware, choose auth mode, mount routes, expose health/info endpoints.

**Local OAuth Surface:**
- Location: `src/modules/mcp-auth/routes/oauth-routes.ts`
- Triggers: Browser and MCP client calls to `/.well-known/*`, `/oauth/authorize`, and `/oauth/token`
- Responsibilities: Publish OAuth metadata, collect a local username, issue authorization codes, mint local JWTs.

**Salesforce Linking Surface:**
- Location: `src/modules/salesforce-connection/routes/salesforce-routes.ts`
- Triggers: Authenticated browser/API calls to `/salesforce/connect`, `/salesforce/status`, `/salesforce/disconnect`, and the Salesforce callback redirect
- Responsibilities: Start account linking, report local connection state, disconnect persisted Salesforce credentials, complete the Salesforce OAuth callback.

**MCP Transport Surface:**
- Location: `src/modules/tool-execution/routes/mcp-routes.ts`
- Triggers: MCP JSON-RPC traffic on `/mcp`
- Responsibilities: Create session transports, validate session IDs, run MCP handlers inside request context, expose GET/DELETE session operations.

## Error Handling

**Strategy:** Convert lower-level Salesforce and connection errors into stable user-facing messages while preserving HTTP semantics required by MCP and legacy clients.

**Patterns:**
- `src/shared/error-handler.ts` classifies Salesforce errors into a fixed enum and provides a formatted text response for tool failures.
- `src/modules/tool-execution/handlers/call-tool.ts` catches all tool execution errors, logs them once, and converts connection-state errors from `src/modules/salesforce-connection/services/connection-service.ts` into explicit reconnect/not-connected messages.
- `src/modules/tool-execution/routes/mcp-routes.ts` intercepts invalid legacy sessions before dispatch and returns HTTP 401 via `send401()` from `src/modules/mcp-auth/middleware.ts`.
- `src/shared/http/express-app.ts` installs a terminal 404 JSON handler; route-level handlers own their own 400/401/500 behavior instead of using a centralized Express error middleware.

## Cross-Cutting Concerns

**Logging:** `src/shared/logger.ts` is a singleton used across every layer. `src/shared/http/express-app.ts` logs each request/response. `src/modules/salesforce-connection/services/salesforce-client.ts` instruments jsforce requests and SOQL queries. Audit-style events are emitted from `src/modules/mcp-auth/services/user-service.ts` and `src/modules/salesforce-connection/services/connection-service.ts`.

**Validation:** Route-level parameter validation is implemented inline in `src/modules/mcp-auth/routes/oauth-routes.ts`, `src/modules/salesforce-connection/routes/salesforce-routes.ts`, and `src/modules/tool-execution/handlers/call-tool.ts`. Individual tools such as `src/modules/tool-execution/tools/query.ts` add Salesforce-specific validation. `zod` is present in `package.json` but not used in the inspected architecture paths.

**Authentication:** Auth enforcement starts in `src/modules/mcp-auth/middleware.ts`. Local mode uses locally signed JWTs from `src/modules/mcp-auth/services/token-service.ts`; legacy mode passes through Salesforce bearer tokens and relies on instance discovery plus Salesforce responses for real validity.

---

*Architecture analysis: 2026-03-24*
