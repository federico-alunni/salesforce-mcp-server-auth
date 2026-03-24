# Codebase Structure

**Analysis Date:** 2026-03-24

## Directory Layout

```text
[project-root]/
├── src/               # TypeScript source for server runtime, modules, shared code, tests, and domain types
├── dist/              # Generated JavaScript and declaration output from `npm run build`
├── examples/          # Small usage examples for consumers
├── docs/              # Reserved documentation directory; no substantive files detected
├── .data/             # Runtime JSON storage for users and Salesforce connections
├── .planning/         # Planning artifacts, including generated codebase maps
├── package.json       # Package manifest, scripts, binary entry, dependencies
├── tsconfig.json      # TypeScript compiler configuration
├── README.md          # Product overview, feature list, setup, tool catalog
├── TRANSPORT_GUIDE.md # MCP transport and endpoint documentation
├── LOGGING_GUIDE.md   # Logging behavior and log-level documentation
└── SECURITY.md        # Security policy and disclosure guidance
```

## Directory Purposes

**`src/`:**
- Purpose: Hold all authored application code.
- Contains: Entrypoint, feature modules, shared infrastructure, tests, and shared type contracts.
- Key files: `src/index.ts`, `src/shared/http/express-app.ts`, `src/types/index.ts`

**`src/modules/`:**
- Purpose: Group business logic by feature boundary instead of by technical layer alone.
- Contains: `mcp-auth`, `salesforce-connection`, and `tool-execution`.
- Key files: `src/modules/mcp-auth/index.ts`, `src/modules/salesforce-connection/index.ts`, `src/modules/tool-execution/index.ts`

**`src/modules/mcp-auth/`:**
- Purpose: Own MCP-facing authentication and OAuth metadata/token endpoints.
- Contains: Middleware, OAuth routes, legacy compatibility routes, token/auth-code/user services.
- Key files: `src/modules/mcp-auth/middleware.ts`, `src/modules/mcp-auth/routes/oauth-routes.ts`, `src/modules/mcp-auth/services/token-service.ts`

**`src/modules/salesforce-connection/`:**
- Purpose: Own Salesforce account-link lifecycle and jsforce connection creation.
- Contains: Connection service, Salesforce client factory, account-link routes.
- Key files: `src/modules/salesforce-connection/services/connection-service.ts`, `src/modules/salesforce-connection/services/salesforce-client.ts`, `src/modules/salesforce-connection/routes/salesforce-routes.ts`

**`src/modules/tool-execution/`:**
- Purpose: Own MCP transport handling and Salesforce tool dispatch.
- Contains: MCP route adapter, MCP server factory, async context, request handlers, tool implementations.
- Key files: `src/modules/tool-execution/routes/mcp-routes.ts`, `src/modules/tool-execution/handlers/call-tool.ts`, `src/modules/tool-execution/handlers/list-tools.ts`

**`src/modules/tool-execution/tools/`:**
- Purpose: Store one file per Salesforce tool capability.
- Contains: Tool descriptor objects and execution handlers for query, metadata, DML, Apex, search, and debug-log operations.
- Key files: `src/modules/tool-execution/tools/query.ts`, `src/modules/tool-execution/tools/manageObject.ts`, `src/modules/tool-execution/tools/manageDebugLogs.ts`

**`src/shared/`:**
- Purpose: Hold cross-module infrastructure and utilities.
- Contains: Config, logger, error classification, HTTP app factory, encryption, JSON file storage.
- Key files: `src/shared/config/index.ts`, `src/shared/logger.ts`, `src/shared/http/express-app.ts`, `src/shared/storage/file-store.ts`

**`src/test/`:**
- Purpose: Hold node:test-based coverage for auth, encryption, and app integration.
- Contains: Unit-ish tests and integration tests.
- Key files: `src/test/mcp-auth.test.ts`, `src/test/encryption.test.ts`, `src/test/integration.test.ts`

**`src/types/`:**
- Purpose: Define shared domain models and service interfaces used across module boundaries.
- Contains: Local principal, connection records, service contracts, error types, auth mode type.
- Key files: `src/types/index.ts`

**`dist/`:**
- Purpose: Hold generated build artifacts published by the package and executed in production.
- Contains: Compiled `.js` files and `.d.ts` files mirroring source structure.
- Key files: `dist/index.js`, `dist/shared/http/express-app.js`, `dist/modules/tool-execution/routes/mcp-routes.js`

**`examples/`:**
- Purpose: Provide consumer-facing usage snippets.
- Contains: A header-auth example script.
- Key files: `examples/http-header-auth-example.js`

**`docs/`:**
- Purpose: Reserved project documentation directory.
- Contains: No substantive files detected in the inspected repository state.
- Key files: Not applicable

**`.data/`:**
- Purpose: Store runtime-generated JSON collections for local users and Salesforce connection records.
- Contains: Test-created subdirectories and JSON collections created by `src/shared/storage/file-store.ts`.
- Key files: Runtime-generated collection files under `.data/`; no fixed committed file detected

**`.planning/codebase/`:**
- Purpose: Store generated repository mapping documents for orchestration workflows.
- Contains: Codebase analysis markdown documents.
- Key files: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`

## Key File Locations

**Entry Points:**
- `src/index.ts`: Node CLI entrypoint that loads env config and starts the HTTP server.
- `src/shared/http/express-app.ts`: Application composition root and Express app factory.
- `src/modules/tool-execution/routes/mcp-routes.ts`: Runtime MCP protocol entrypoint for `POST /mcp`, `GET /mcp`, and `DELETE /mcp`.

**Configuration:**
- `package.json`: Scripts, published files, runtime dependencies, package binary, test command.
- `tsconfig.json`: Compiler target, module format, output path, declaration generation, strict mode.
- `src/shared/config/index.ts`: Centralized runtime env access for port, auth mode, Salesforce settings, storage, and logging.
- `.env.example`: Example environment configuration file present in the root; treat as documentation, not runtime code.

**Core Logic:**
- `src/modules/mcp-auth/services/token-service.ts`: Local JWT issuance and validation.
- `src/modules/mcp-auth/services/auth-code-service.ts`: In-memory PKCE authorization-code lifecycle.
- `src/modules/salesforce-connection/services/connection-service.ts`: Salesforce token exchange, refresh, persistence, and reconnect state.
- `src/modules/salesforce-connection/services/salesforce-client.ts`: jsforce connection factory and instance URL discovery.
- `src/modules/tool-execution/handlers/call-tool.ts`: Central tool dispatch and error mapping.
- `src/modules/tool-execution/tools/*.ts`: Individual Salesforce capability implementations.

**Testing:**
- `src/test/mcp-auth.test.ts`: Module A unit-style coverage.
- `src/test/encryption.test.ts`: Encryption behavior coverage.
- `src/test/integration.test.ts`: Express app and route integration coverage.

## Naming Conventions

**Files:**
- Lowercase kebab-case directories and mostly lower-case file names with descriptive suffixes: `src/modules/salesforce-connection/services/connection-service.ts`
- Route files end with `-routes.ts`: `src/modules/mcp-auth/routes/oauth-routes.ts`
- Service files end with `-service.ts`: `src/modules/mcp-auth/services/token-service.ts`
- Shared infrastructure files use noun-based names: `src/shared/logger.ts`, `src/shared/error-handler.ts`
- Tool files are concise capability names without extra suffixes: `src/modules/tool-execution/tools/query.ts`, `src/modules/tool-execution/tools/writeApex.ts`

**Directories:**
- Feature modules use kebab-case: `src/modules/mcp-auth`, `src/modules/salesforce-connection`, `src/modules/tool-execution`
- Technical subfolders use plural nouns: `routes`, `services`, `handlers`, `tools`

## Where to Add New Code

**New Feature:**
- Primary code: Add a new module under `src/modules/<feature-name>/` if the feature owns a distinct runtime boundary, or extend an existing module when the responsibility matches one of:
  - auth and OAuth behavior in `src/modules/mcp-auth/`
  - Salesforce account-link/token lifecycle in `src/modules/salesforce-connection/`
  - MCP protocol/tool behavior in `src/modules/tool-execution/`
- Tests: Add test files under `src/test/` following the existing `*.test.ts` pattern.

**New MCP Tool:**
- Implementation: Add a new file under `src/modules/tool-execution/tools/<toolName>.ts` that exports both the tool descriptor constant and the `handle...` function.
- Registration: Update `src/modules/tool-execution/handlers/list-tools.ts` to include the new descriptor in `ALL_TOOLS`.
- Dispatch: Add a case in `src/modules/tool-execution/handlers/call-tool.ts` for argument validation and handler invocation.

**New HTTP Route:**
- Auth-related route: Add it under `src/modules/mcp-auth/routes/`.
- Salesforce account-link route: Add it under `src/modules/salesforce-connection/routes/`.
- MCP transport behavior: Extend `src/modules/tool-execution/routes/mcp-routes.ts`.
- App mounting: Wire new top-level route trees in `src/shared/http/express-app.ts`.

**New Shared Utility:**
- Shared helpers: Put cross-module infrastructure in `src/shared/`.
- Shared contracts: Put reusable interfaces/types in `src/types/index.ts`, or split within `src/types/` if that folder expands.

**New Persistent State:**
- Local JSON-backed collections: Add collection reads/writes through `src/shared/storage/file-store.ts`.
- Sensitive values: Encrypt before persistence using `src/shared/security/encryption.ts`.

## Special Directories

**`dist/`:**
- Purpose: Generated build output consumed by Node at runtime and published by npm.
- Generated: Yes
- Committed: No, ignored by `.gitignore`

**`.data/`:**
- Purpose: Runtime storage directory for local users, Salesforce connections, and test artifacts.
- Generated: Yes
- Committed: No, ignored by `.gitignore`

**`docs/`:**
- Purpose: Reserved documentation directory.
- Generated: No
- Committed: Yes

**`examples/`:**
- Purpose: Consumer-facing integration or usage examples.
- Generated: No
- Committed: Yes

**`.planning/`:**
- Purpose: Planning workspace for generated architecture and implementation docs.
- Generated: Yes
- Committed: Project workflow dependent; current repository state includes the directory

---

*Structure analysis: 2026-03-24*
