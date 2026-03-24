# Technology Stack

**Analysis Date:** 2026-03-24

## Languages

**Primary:**
- TypeScript 5.x - All application code lives under `src/`; compiler configured in `tsconfig.json`.

**Secondary:**
- JavaScript (generated) - Build output is emitted to `dist/` and published as the package entrypoint from `package.json`.
- HTML - Inline OAuth success/login pages are rendered from `src/modules/mcp-auth/routes/oauth-routes.ts` and `src/modules/salesforce-connection/routes/salesforce-routes.ts`.

## Runtime

**Environment:**
- Node.js - Version is not pinned in `package.json`, but the code in `src/index.ts`, `src/shared/http/express-app.ts`, and the `node --test` script in `package.json` requires a modern Node runtime with ESM and built-in `fetch`.

**Package Manager:**
- npm - Scripts and dependency metadata are defined in `package.json`.
- Lockfile: present in `package-lock.json`

## Frameworks

**Core:**
- Express 5.1.0 - HTTP server, routing, CORS, JSON parsing, and health/info endpoints in `src/shared/http/express-app.ts`.
- `@modelcontextprotocol/sdk` 1.27.1 - MCP server implementation and Streamable HTTP transport in `src/modules/tool-execution/mcp-server.ts` and `src/modules/tool-execution/routes/mcp-routes.ts`.

**Testing:**
- Node test runner - Tests are compiled and run via `node --test --test-force-exit dist/test/*.test.js` from `package.json`.

**Build/Dev:**
- TypeScript 5.7.2 - Compilation from `src/` to `dist/` via `tsc` in `package.json`.
- shx 0.4.0 - Cross-platform `chmod` step in the `build` script in `package.json`.
- dotenv 17.2.1 - Environment variable bootstrap via `import 'dotenv/config'` in `src/index.ts`.

## Key Dependencies

**Critical:**
- `jsforce` 3.10.3 - Primary Salesforce client for SOQL, SOSL, Metadata API, Tooling API, and sObject operations in `src/modules/salesforce-connection/services/salesforce-client.ts` and `src/modules/tool-execution/tools/*.ts`.
- `@modelcontextprotocol/sdk` 1.27.1 - Exposes MCP tool listing and invocation over Streamable HTTP in `src/modules/tool-execution/mcp-server.ts`.
- `express` 5.1.0 - Hosts `/mcp`, `/health`, OAuth metadata endpoints, and Salesforce linking routes in `src/shared/http/express-app.ts`.

**Infrastructure:**
- `dotenv` 17.2.1 - Loads `.env` configuration at process startup in `src/index.ts`.
- `zod` 3.24.4 - Declared dependency; not detected in the currently referenced runtime paths.
- Native Node modules (`crypto`, `https`, `fs`, `path`) - JWT signing, AES-256-GCM token encryption, HTTPS calls to Salesforce userinfo, and file-backed storage in `src/modules/mcp-auth/services/token-service.ts`, `src/shared/security/encryption.ts`, `src/modules/salesforce-connection/services/salesforce-client.ts`, and `src/shared/storage/file-store.ts`.

## Build and Dev Scripts

- `npm run build` - `tsc && shx chmod +x dist/*.js` from `package.json`; compiles TypeScript and makes generated CLI files executable.
- `npm run prepare` - Runs the build automatically before publish/install from source per `package.json`.
- `npm run watch` - Runs `tsc --watch` for development rebuilds from `package.json`.
- `npm test` - Recompiles then runs compiled tests from `dist/test/*.test.js` using Node's native test runner per `package.json`.

## Configuration

**Environment:**
- Environment variables are centralized in `src/shared/config/index.ts`.
- An example configuration surface is documented in `.env.example`; the real `.env` file is expected but not read.
- Runtime mode is controlled by `MCP_AUTH_MODE`, switching between local OAuth and legacy Salesforce-token passthrough in `src/shared/config/index.ts` and `src/shared/http/express-app.ts`.

**Build:**
- `tsconfig.json` targets `ES2020`, emits ES2022 modules, uses `moduleResolution: "bundler"`, enables `strict`, and writes to `dist/`.
- Package entrypoints are `dist/index.js` and `dist/index.d.ts` as declared in `package.json`.

## Notable Infrastructure

- Streamable HTTP MCP transport only - No SSE transport; documented in `TRANSPORT_GUIDE.md` and implemented in `src/modules/tool-execution/routes/mcp-routes.ts`.
- Stateless request handling for MCP calls - A transport/session is created per initialization flow and tool execution resolves auth context per request in `src/modules/tool-execution/routes/mcp-routes.ts` and `src/modules/tool-execution/handlers/call-tool.ts`.
- File-backed persistence - Local users and linked Salesforce connections are stored under `MCP_DATA_DIR` using JSON files via `src/shared/storage/file-store.ts`.
- Token protection at rest - Stored Salesforce tokens are encrypted with AES-256-GCM when `MCP_ENCRYPTION_KEY` is configured in `src/shared/security/encryption.ts`.
- Structured stderr logging - Log levels, request logging, audit logging, and Salesforce call tracing live in `src/shared/logger.ts` and are documented in `LOGGING_GUIDE.md`.

## Platform Requirements

**Development:**
- Node.js and npm are required to run the scripts in `package.json`.
- Salesforce configuration differs by auth mode: local mode requires JWT settings plus Salesforce Connected App credentials in `.env.example`; legacy mode needs a valid Salesforce access token per request.

**Production:**
- Deployment target is a long-running Node HTTP service exposing `/mcp` and `/health`, started with `node dist/index.js` as shown in `README.md` and `TRANSPORT_GUIDE.md`.

---

*Stack analysis: 2026-03-24*
