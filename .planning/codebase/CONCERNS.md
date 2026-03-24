# Codebase Concerns

**Analysis Date:** 2026-03-24

## Tech Debt

**Documentation and runtime behavior drift:**
- Issue: The public docs describe a stateless bearer-token proxy, while the default runtime path is local auth with persisted local users, persisted Salesforce refresh tokens, and in-memory MCP sessions.
- Files: `README.md`, `TRANSPORT_GUIDE.md`, `src/shared/config/index.ts`, `src/modules/mcp-auth/routes/oauth-routes.ts`, `src/modules/salesforce-connection/services/connection-service.ts`, `src/shared/storage/file-store.ts`, `src/modules/tool-execution/routes/mcp-routes.ts`
- Impact: Operators can deploy the server with the wrong trust model, the wrong persistence expectations, and the wrong transport assumptions. Client integrations can target `/mcp` as if it were stateless even though `src/modules/tool-execution/routes/mcp-routes.ts` stores session transports in memory.
- Fix approach: Align `README.md` and `TRANSPORT_GUIDE.md` with the default `MCP_AUTH_MODE=local` path, or change the default mode to match the published docs. Document the persistence model in `.data/` and the requirement for session-aware MCP clients.

**Large tool handlers with duplicated query and formatting logic:**
- Issue: Tool modules mix validation, SOQL/SOSL construction, Salesforce API calls, and text formatting in single files, with broad `any` usage instead of shared typed helpers.
- Files: `src/modules/tool-execution/tools/manageDebugLogs.ts`, `src/modules/tool-execution/tools/manageField.ts`, `src/modules/tool-execution/tools/manageFieldPermissions.ts`, `src/modules/tool-execution/tools/aggregateQuery.ts`, `src/modules/tool-execution/tools/query.ts`, `src/modules/tool-execution/tools/searchAll.ts`
- Impact: Small changes can break multiple behaviors at once, code review stays expensive, and edge cases are easy to miss because the same interpolation and formatting patterns are copied across modules.
- Fix approach: Split each tool into schema validation, query builder, Salesforce adapter, and response formatter modules. Replace `any` with typed request/result contracts and centralize query escaping and error translation.

**Unused validation dependency and manual request validation:**
- Issue: `zod` is installed but not used, and most runtime validation is manual presence checking in `call-tool.ts` and ad hoc string checks inside each tool file.
- Files: `package.json`, `src/modules/tool-execution/handlers/call-tool.ts`, `src/modules/tool-execution/tools/query.ts`, `src/modules/tool-execution/tools/aggregateQuery.ts`, `src/modules/tool-execution/tools/manageDebugLogs.ts`
- Impact: The codebase carries dependency cost without getting consistent schema validation, coercion, or reusable error messages. Invalid payloads can reach deep tool logic before failing.
- Fix approach: Define one `zod` schema per tool, validate at the request boundary in `src/modules/tool-execution/handlers/call-tool.ts`, and pass typed inputs to handlers.

## Known Bugs

**Anonymous Apex log retrieval can return the wrong log body:**
- Symptoms: `salesforce_execute_anonymous` fetches the newest `ApexLog` in the org instead of filtering to the execution user or the specific anonymous execution request.
- Files: `src/modules/tool-execution/tools/executeAnonymous.ts`
- Trigger: Run `salesforce_execute_anonymous` while another user or automation is generating Apex logs in the same org.
- Workaround: Use `salesforce_manage_debug_logs` and retrieve logs manually for the exact user and time window instead of trusting the automatic log body in `salesforce_execute_anonymous`.

**Debug-log retrieval by ID bypasses the requested username filter:**
- Symptoms: `salesforce_manage_debug_logs` validates `username` first, but when `logId` is supplied it queries `ApexLog` by `Id` only and can return a log that does not belong to the matched user.
- Files: `src/modules/tool-execution/tools/manageDebugLogs.ts`
- Trigger: Call `salesforce_manage_debug_logs` with `"operation": "retrieve"`, a valid `username`, and a `logId` belonging to another user.
- Workaround: Avoid `logId` retrieval in shared orgs until the query also constrains `LogUserId`.

**Published version metadata is inconsistent:**
- Symptoms: The package publishes version `0.0.3`, while the root info route and MCP server identity return `1.0.0`.
- Files: `package.json`, `src/shared/http/express-app.ts`, `src/modules/tool-execution/mcp-server.ts`
- Trigger: Any health check, MCP initialization, or operational check that reads version fields.
- Workaround: Treat `package.json` as the authoritative release version until the runtime metadata is wired to a single source of truth.

## Security Considerations

**Local auth mode allows identity spoofing with username-only login:**
- Risk: `GET /oauth/authorize` renders a form that asks only for `username`, and `POST /oauth/authorize` calls `getOrCreateUser(username)` without password, external identity, or session verification. Reusing the same display name returns the same local user record.
- Files: `src/modules/mcp-auth/routes/oauth-routes.ts`, `src/modules/mcp-auth/services/user-service.ts`, `src/shared/config/index.ts`
- Current mitigation: `src/shared/config/index.ts` allows client allowlisting through `MCP_ALLOWED_CLIENT_IDS`, but the default is `*`, and the token endpoint declares `token_endpoint_auth_methods_supported: ['none']`.
- Recommendations: Treat local mode as unsafe on any shared or internet-exposed deployment until it is backed by a real identity provider, unique subject identifiers, and per-user authentication.

**Salesforce tokens can be stored in plaintext at rest:**
- Risk: If `MCP_ENCRYPTION_KEY` is missing or malformed, `encrypt()` returns `plain:<token>` and `file-store.ts` writes it directly to `.data/*.json`.
- Files: `src/shared/security/encryption.ts`, `src/shared/config/index.ts`, `src/shared/storage/file-store.ts`, `src/modules/salesforce-connection/services/connection-service.ts`
- Current mitigation: `src/shared/security/encryption.ts` logs a warning.
- Recommendations: Fail fast at startup when local auth mode is enabled without a valid `MCP_ENCRYPTION_KEY`, and refuse to persist connections until encryption is configured.

**SOQL and SOSL construction uses raw string interpolation:**
- Risk: Multiple tools interpolate user-supplied values directly into SOQL or SOSL strings, while `SECURITY.md` claims that inputs are sanitized.
- Files: `SECURITY.md`, `src/modules/tool-execution/tools/query.ts`, `src/modules/tool-execution/tools/searchAll.ts`, `src/modules/tool-execution/tools/manageDebugLogs.ts`, `src/modules/tool-execution/tools/manageField.ts`, `src/modules/tool-execution/tools/manageFieldPermissions.ts`, `src/modules/tool-execution/tools/readApex.ts`, `src/modules/tool-execution/tools/writeApex.ts`, `src/modules/tool-execution/tools/writeApexTrigger.ts`
- Current mitigation: Some handlers do format checks such as relationship syntax validation in `src/modules/tool-execution/tools/query.ts`, but there is no escaping layer or schema-level sanitization.
- Recommendations: Introduce a centralized query builder and escaping rules before allowing arbitrary names, `whereClause`, `orderBy`, `searchTerm`, profile names, Apex class names, and usernames into Salesforce query strings.

**Verbose logging can expose business data and code artifacts:**
- Risk: `src/shared/http/express-app.ts` buffers response bodies when verbose logging is enabled, and `src/shared/logger.ts` writes serialized request and response data to stderr. Tool responses can include record data, Apex source, and debug-log bodies.
- Files: `src/shared/http/express-app.ts`, `src/shared/logger.ts`, `LOGGING_GUIDE.md`, `src/modules/tool-execution/tools/readApex.ts`, `src/modules/tool-execution/tools/executeAnonymous.ts`
- Current mitigation: Authorization headers are masked in `src/shared/logger.ts`.
- Recommendations: Keep `MCP_LOG_LEVEL` at `INFO` or lower in production, disable response-body logging for data-bearing endpoints, and add explicit redaction for Apex source and log body content.

## Performance Bottlenecks

**Synchronous JSON persistence blocks the event loop:**
- Problem: Every read and write uses `readFileSync()` and `writeFileSync()` and rewrites whole collections.
- Files: `src/shared/storage/file-store.ts`, `src/modules/mcp-auth/services/user-service.ts`, `src/modules/salesforce-connection/services/connection-service.ts`
- Cause: The persistence layer is a simple file-backed CRUD store with no batching, locking, or async I/O.
- Improvement path: Replace `src/shared/storage/file-store.ts` with an async store backed by SQLite, Postgres, or Redis, and add record-level concurrency control.

**Legacy tool calls can incur an extra network round trip before execution:**
- Problem: In legacy mode, `POST /mcp` performs preflight instance discovery through Salesforce userinfo before the actual tool request runs.
- Files: `src/modules/tool-execution/routes/mcp-routes.ts`, `src/modules/salesforce-connection/services/salesforce-client.ts`
- Cause: `src/modules/tool-execution/routes/mcp-routes.ts` calls `discoverInstanceUrl()` for `tools/call`, and `discoverInstanceUrl()` may probe `https://login.salesforce.com` and `https://test.salesforce.com`.
- Improvement path: Cache discovery more aggressively, expose discovery latency in logs or metrics, and skip duplicate discovery inside a request once a valid connection has already been built.

**Verbose response capture increases memory and serialization overhead:**
- Problem: The response logger monkey-patches `res.write` and `res.end` and buffers body chunks when verbose logging is enabled.
- Files: `src/shared/http/express-app.ts`, `src/shared/logger.ts`
- Cause: Full body capture is implemented in-process for every HTTP response instead of only for targeted debug traces.
- Improvement path: Restrict verbose body logging to a whitelist of safe endpoints, or sample logs instead of buffering every response.

## Fragile Areas

**jsforce integration depends on monkey-patching and internal fields:**
- Files: `src/modules/salesforce-connection/services/salesforce-client.ts`
- Why fragile: The logger wraps `conn.request`, wraps `conn.query`, and checks the private `_baseUrl` property. Any `jsforce` upgrade can change these internals and break request handling or observability.
- Safe modification: Keep all `jsforce` upgrades isolated to a dedicated test branch and verify the behavior of `createSalesforceConnection()` and `createConnectionFromToken()` end to end before releasing.
- Test coverage: No tests exercise `src/modules/salesforce-connection/services/salesforce-client.ts` against a real or mocked `jsforce.Connection`.

**MCP transport state lives only in memory:**
- Files: `src/modules/tool-execution/routes/mcp-routes.ts`, `src/modules/tool-execution/context.ts`
- Why fragile: Session transport objects are stored in a process-local `transports` map. Restarting the process or routing a follow-up request to another instance drops the session.
- Safe modification: Keep `/mcp` on a single sticky instance until sessions move to a shared store or a fully stateless transport design.
- Test coverage: `src/test/integration.test.ts` covers a happy-path initialize flow only; it does not cover restart behavior, concurrent sessions, or cross-instance routing.

**Auth and connection flows rely on in-memory ephemeral maps:**
- Files: `src/modules/mcp-auth/services/auth-code-service.ts`, `src/modules/salesforce-connection/services/connection-service.ts`
- Why fragile: Authorization codes and pending OAuth states live in `Map` instances plus cleanup intervals. Process restarts orphan browser redirects and invalidate in-flight authorization handshakes.
- Safe modification: Back these maps with Redis or another shared TTL store before changing OAuth flows or scaling the app horizontally.
- Test coverage: `src/test/mcp-auth.test.ts` validates PKCE logic but does not cover restart, expiry timing, or multi-instance behavior.

## Scaling Limits

**Single-process state and local disk persistence:**
- Current capacity: One Node.js process owns the `transports` session map in `src/modules/tool-execution/routes/mcp-routes.ts`, the auth-code map in `src/modules/mcp-auth/services/auth-code-service.ts`, the pending OAuth-state map and access-token cache in `src/modules/salesforce-connection/services/connection-service.ts`, and the JSON collections in `.data/*.json` via `src/shared/storage/file-store.ts`.
- Limit: Horizontal scaling breaks MCP sessions, OAuth handshakes, and cached connection state because no shared store exists. Concurrent writes can also race because `src/shared/storage/file-store.ts` does read-modify-write cycles without locking.
- Scaling path: Move ephemeral state to Redis, move persisted user/connection data to a transactional database, and make the `/mcp` session model either shared-store-backed or fully stateless.

**Operational readiness checks are shallow:**
- Current capacity: `/health` returns a static JSON payload with `status: 'healthy'`, `transport: 'streamable-http'`, and a hardcoded `toolsAvailable: 15`.
- Limit: The server can report healthy even when `MCP_JWT_SECRET` is unset, `MCP_ENCRYPTION_KEY` is invalid, Salesforce client credentials are empty, or `.data/` is not usable.
- Scaling path: Add startup validation in `src/index.ts` or `src/shared/http/express-app.ts`, and make `/health` verify config readiness, storage readiness, and dependency reachability.

## Dependencies at Risk

**`jsforce` upgrade surface is high-risk for this codebase:**
- Risk: The app depends on `jsforce` for REST, Tooling API, Metadata API, and query behavior, and `src/modules/salesforce-connection/services/salesforce-client.ts` patches connection methods directly.
- Impact: A minor `jsforce` behavior change can break logging, query interception, or tool execution across nearly every file in `src/modules/tool-execution/tools/`.
- Migration plan: Introduce a thin adapter layer with tests around query, metadata, tooling, and search operations before changing the `jsforce` version declared in `package.json`.

## Missing Critical Features

**Real identity and authorization controls for local mode:**
- Problem: Local mode has no authenticated user identity beyond a supplied display name, and there is no per-user authorization layer around linked Salesforce connections.
- Blocks: Safe public deployment of the local-auth flow in `src/modules/mcp-auth/routes/oauth-routes.ts` and `src/modules/salesforce-connection/routes/salesforce-routes.ts`.

**Fail-fast configuration validation:**
- Problem: Missing `MCP_JWT_SECRET`, missing Salesforce OAuth credentials, and invalid `MCP_ENCRYPTION_KEY` are detected late or only via warnings.
- Blocks: Reliable startup validation and operator confidence in `src/index.ts`, `src/modules/mcp-auth/services/token-service.ts`, `src/modules/salesforce-connection/services/connection-service.ts`, and `src/shared/security/encryption.ts`.

**Operational observability beyond console logs:**
- Problem: The codebase exposes no metrics, no readiness probe, no trace correlation, and no alert-friendly health semantics beyond console logging and a static `/health` response.
- Blocks: Production monitoring and incident response for `src/shared/http/express-app.ts` and `src/shared/logger.ts`.

**Automated CI and lint enforcement:**
- Problem: `package.json` exposes `build`, `prepare`, `watch`, and `test`, but no `lint` script is present, no lint config exists at the repo root, and no root CI pipeline was detected.
- Blocks: Consistent style enforcement, automated regression checks, and safe dependency updates.

## Test Coverage Gaps

**Salesforce tool handlers are effectively untested:**
- What's not tested: The query, search, DML, Apex, metadata, and debug-log tool implementations under `src/modules/tool-execution/tools/`
- Files: `src/modules/tool-execution/tools/query.ts`, `src/modules/tool-execution/tools/searchAll.ts`, `src/modules/tool-execution/tools/manageDebugLogs.ts`, `src/modules/tool-execution/tools/manageField.ts`, `src/modules/tool-execution/tools/manageFieldPermissions.ts`, `src/modules/tool-execution/tools/writeApex.ts`, `src/modules/tool-execution/tools/writeApexTrigger.ts`, `src/modules/tool-execution/tools/executeAnonymous.ts`
- Risk: Query injection, malformed Salesforce requests, and destructive mutation bugs can ship without any automated signal.
- Priority: High

**Legacy auth mode is not covered by automated tests:**
- What's not tested: Metadata proxying, token proxy behavior, userinfo preflight handling, and 401 flows for `MCP_AUTH_MODE=legacy`
- Files: `src/modules/mcp-auth/routes/legacy-oauth-routes.ts`, `src/modules/tool-execution/routes/mcp-routes.ts`, `src/modules/salesforce-connection/services/salesforce-client.ts`
- Risk: The documented bearer-token flow can drift or fail silently while local-mode tests remain green.
- Priority: High

**Persistence and refresh flows lack failure-mode coverage:**
- What's not tested: JSON store corruption handling, concurrent writes, OAuth callback state expiry, token refresh success/failure transitions, reconnect-required state, and disconnect error handling
- Files: `src/shared/storage/file-store.ts`, `src/modules/salesforce-connection/services/connection-service.ts`, `src/modules/mcp-auth/services/auth-code-service.ts`
- Risk: Restarts, file corruption, or Salesforce token churn can break user connections in ways the test suite never exercises.
- Priority: High

---

*Concerns audit: 2026-03-24*
