# Coding Conventions

**Analysis Date:** 2026-03-24

## Naming Patterns

**Files:**
- Use lowercase kebab-case for file names in `src/modules/**`, `src/shared/**`, and `src/test/**`, for example `src/modules/mcp-auth/services/token-service.ts`, `src/modules/tool-execution/handlers/call-tool.ts`, and `src/shared/error-handler.ts`.
- Use role-based suffixes in file names to make responsibilities obvious: `*-routes.ts` for Express routers, `*-service.ts` for stateful or external-service logic, `*-middleware.ts` for request interception, and `*.test.ts` for test entry points.
- Use folder names as bounded contexts. New code should be placed under an existing module directory such as `src/modules/mcp-auth/`, `src/modules/salesforce-connection/`, or `src/modules/tool-execution/` rather than directly under `src/`.

**Functions:**
- Use camelCase for functions and variables, for example `createApp`, `startServer`, `classifySalesforceError`, `generateAuthorizationCode`, and `handleSearchObjects` in `src/shared/http/express-app.ts`, `src/shared/error-handler.ts`, `src/modules/mcp-auth/services/auth-code-service.ts`, and `src/modules/tool-execution/tools/search.ts`.
- Use `create*` prefixes for factories that return Express routers, app instances, or protocol/server objects, such as `createApp`, `createMCPRoutes`, `createMCPServer`, `createSalesforceConnection`, and `createLocalOAuthRoutes` in `src/shared/http/express-app.ts`, `src/modules/tool-execution/routes/mcp-routes.ts`, `src/modules/tool-execution/mcp-server.ts`, `src/modules/salesforce-connection/services/salesforce-client.ts`, and `src/modules/mcp-auth/routes/oauth-routes.ts`.
- Use `handle*` prefixes for route or tool behavior handlers, such as `handleOAuthCallback`, `handleQueryRecords`, and `handleManageFieldPermissions` in `src/modules/salesforce-connection/services/connection-service.ts` and `src/modules/tool-execution/tools/*.ts`.

**Variables:**
- Use camelCase for locals and object properties, including request-derived values like `sessionId`, `startTime`, `redirectUrl`, `searchTerms`, and `matchingObjects` in `src/shared/http/express-app.ts`, `src/modules/tool-execution/routes/mcp-routes.ts`, `src/modules/mcp-auth/routes/oauth-routes.ts`, and `src/modules/tool-execution/tools/search.ts`.
- Use SCREAMING_SNAKE_CASE for true constants, especially collection names and crypto settings, for example `COLLECTION`, `ALGORITHM`, `IV_LENGTH`, and `AUTH_TAG_LENGTH` in `src/modules/salesforce-connection/services/connection-service.ts` and `src/shared/security/encryption.ts`.
- Use descriptive map/cache names for process-level state, such as `pendingStates`, `accessTokenCache`, `instanceUrlCache`, and `transports` in `src/modules/salesforce-connection/services/connection-service.ts`, `src/modules/salesforce-connection/services/salesforce-client.ts`, and `src/modules/tool-execution/routes/mcp-routes.ts`.

**Types:**
- Use PascalCase for interfaces, type aliases, enums, and error classes, for example `LocalPrincipal`, `SalesforceAccessContext`, `SalesforceErrorType`, and `ClassifiedError` in `src/types/index.ts`.
- Prefix service interfaces with `I` when they define module contracts, such as `ITokenService`, `ISalesforceConnectionService`, and `IToolContextResolver` in `src/types/index.ts`.
- Use string-literal unions for constrained states like `AuthMode` and `SalesforceConnectionStatus` in `src/types/index.ts`.

## Code Style

**Formatting:**
- No dedicated formatter config is detected. There is no `.prettierrc`, `prettier.config.*`, or Biome config at the repository root.
- TypeScript uses strict compilation from `tsconfig.json` with `"strict": true`, `"module": "ES2022"`, `"moduleResolution": "bundler"`, and ESM output to `dist/`.
- Keep import specifiers ESM-compatible by including `.js` extensions in TypeScript source imports, as shown throughout `src/index.ts`, `src/shared/http/express-app.ts`, and `src/modules/**`.
- Preserve the existing visual structure: many files use banner comments and section dividers (`// ============================================================================` and `// ---------------------------------------------------------------------------`) to separate responsibilities, as seen in `src/shared/logger.ts`, `src/shared/config/index.ts`, and `src/modules/tool-execution/handlers/call-tool.ts`.
- Keep semicolons enabled and prefer multi-line object literals when arguments become non-trivial, matching `src/shared/config/index.ts` and `src/modules/mcp-auth/routes/oauth-routes.ts`.
- Quote style is mostly single quotes in service and route files such as `src/shared/http/express-app.ts` and `src/modules/mcp-auth/services/token-service.ts`, but several tool definition files use double quotes in exported schema objects such as `src/modules/tool-execution/tools/search.ts`. Follow the surrounding file’s existing style when editing.

**Linting:**
- No ESLint config is detected. There is no `.eslintrc*` or `eslint.config.*` at the repository root.
- In practice, the enforced quality gate is TypeScript compilation via `npm run build` and `npm test` from `package.json`.
- Avoid implicit `any` where the surrounding file uses domain types, but expect some boundary code to use `any` for SDK and Express interop, such as `req: any` in `src/shared/http/express-app.ts`, `request: any` in `src/modules/tool-execution/handlers/call-tool.ts`, and `conn: any` in `src/modules/tool-execution/tools/search.ts`.

## Import Organization

**Order:**
1. Third-party/runtime imports first, for example `express`, `crypto`, `https`, or SDK types in `src/shared/http/express-app.ts`, `src/modules/mcp-auth/services/token-service.ts`, and `src/modules/tool-execution/mcp-server.ts`.
2. Internal module imports second, usually grouped by layer or module, for example config/logger imports before feature imports in `src/shared/http/express-app.ts`.
3. Type-only imports are used inline with regular imports where needed, for example `import type { Request, Response } from 'express'` in `src/modules/tool-execution/routes/mcp-routes.ts` and `import type { ITokenService, LocalPrincipal } from '../../../types/index.js'` in `src/modules/mcp-auth/services/token-service.ts`.

**Path Aliases:**
- No TypeScript path aliases are configured in `tsconfig.json`.
- Use relative imports with explicit `.js` extensions, for example `../../../shared/logger.js` and `../services/token-service.js`.

## Error Handling

**Patterns:**
- Classify external-service failures centrally with `classifySalesforceError()` and convert them into user-facing messages with `formatClassifiedError()` in `src/shared/error-handler.ts`.
- Fail fast on missing required arguments and invalid request state with direct `throw new Error(...)` guards, as shown in `src/modules/tool-execution/handlers/call-tool.ts`, `src/modules/mcp-auth/services/token-service.ts`, and `src/shared/security/encryption.ts`.
- Return HTTP error responses inline inside route handlers instead of delegating to a global Express error middleware. Examples appear in `src/modules/mcp-auth/routes/oauth-routes.ts`, `src/modules/tool-execution/routes/mcp-routes.ts`, and `src/modules/mcp-auth/middleware.ts`.
- Return MCP tool failures as `{ content, isError: true }` payloads from tool handlers, rather than throwing raw errors all the way out, in `src/modules/tool-execution/handlers/call-tool.ts`.
- Use domain-specific error classes when behavior depends on failure type, such as `SalesforceNotConnectedError` and `SalesforceReconnectRequiredError` in `src/modules/salesforce-connection/services/connection-service.ts` and `src/modules/tool-execution/handlers/call-tool.ts`.

## Logging

**Framework:** custom logger singleton backed by `console.*` in `src/shared/logger.ts`

**Patterns:**
- Import and reuse the shared `logger` singleton instead of calling `console.*` directly in feature code. Entry points and modules consistently use `logger` in `src/index.ts`, `src/shared/http/express-app.ts`, `src/modules/mcp-auth/routes/oauth-routes.ts`, and `src/modules/salesforce-connection/services/salesforce-client.ts`.
- Keep log configuration centralized in `src/shared/config/index.ts` via `logging.level` and `logging.timestamps`.
- Log request/response lifecycle in HTTP code through `logger.httpRequest()` and `logger.httpResponse()` in `src/shared/http/express-app.ts`.
- Log business/audit events with `logger.auditLog()` for auth and connection changes in `src/modules/mcp-auth/routes/oauth-routes.ts` and `src/modules/salesforce-connection/services/connection-service.ts`.
- Sanitize secrets before logging. `src/shared/logger.ts` masks Authorization headers and redacts keys containing `password`, `token`, `secret`, `apikey`, `clientsecret`, `refreshtoken`, `accesstoken`, or `code`.
- Keep MCP protocol output separate from logs. `LOGGING_GUIDE.md` states logs go to stderr, and the code relies on `console.*` in `src/shared/logger.ts` to preserve that separation.

## Comments

**When to Comment:**
- Use file-level banner comments to document module purpose and boundaries, as seen in nearly every file under `src/shared/**` and `src/modules/**`.
- Use section-divider comments inside larger files to separate phases such as config sections, request lifecycle steps, or helper groups. Examples appear in `src/shared/config/index.ts`, `src/shared/http/express-app.ts`, and `src/modules/salesforce-connection/services/connection-service.ts`.
- Use short intent comments for protocol or security subtleties, for example raw body preservation in `src/shared/http/express-app.ts`, legacy JWT expiry checks in `src/modules/mcp-auth/middleware.ts`, and single-use auth-code expectations in `src/test/mcp-auth.test.ts`.

**JSDoc/TSDoc:**
- JSDoc is used selectively for public contracts and nuanced helpers, not for every function. Examples include documented interfaces in `src/types/index.ts`, `encrypt()`/`decrypt()` in `src/shared/security/encryption.ts`, and middleware behavior notes in `src/modules/mcp-auth/middleware.ts`.

## Function Design

**Size:** Keep functions small to medium and focused on one responsibility. Helper-heavy files such as `src/modules/mcp-auth/services/token-service.ts` and `src/shared/security/encryption.ts` split crypto steps into private helpers before exporting a small public API.

**Parameters:**
- Prefer explicit scalar parameters for simple factories and handlers, for example `discoverInstanceUrl(accessToken: string)` in `src/modules/salesforce-connection/services/salesforce-client.ts`.
- Use structured argument objects when a tool or workflow has many fields, for example `args` objects passed into `handleQueryRecords`, `handleManageField`, and related handlers from `src/modules/tool-execution/handlers/call-tool.ts`.
- Pass `Request`, `Response`, and `NextFunction` explicitly in Express middleware and routes rather than hiding them behind wrapper abstractions, matching `src/modules/mcp-auth/middleware.ts` and `src/modules/tool-execution/routes/mcp-routes.ts`.

**Return Values:**
- Return plain objects and typed records rather than custom classes for most domain state, such as `SalesforceAccessContext`, `SalesforceConnectionRecord`, and tool result objects in `src/types/index.ts` and `src/modules/tool-execution/handlers/call-tool.ts`.
- Use `null` or `undefined` to indicate lookup/validation failure instead of exceptions in low-level helpers, such as `verify()` in `src/modules/mcp-auth/services/token-service.ts`, `redeemAuthorizationCode()` usage in `src/modules/mcp-auth/routes/oauth-routes.ts`, and `findOne()` in `src/shared/storage/file-store.ts`.
- Use async functions broadly, even for logic that is currently local, to keep service contracts future-proof. This pattern appears in `src/modules/mcp-auth/services/token-service.ts`, `src/modules/salesforce-connection/services/connection-service.ts`, and `src/modules/tool-execution/handlers/list-tools.ts`.

## Module Design

**Exports:**
- Prefer named exports over default exports across the codebase. Examples include `createApp`, `logger`, `tokenService`, `salesforceConnectionService`, `callToolHandler`, and `ALL_TOOLS`.
- Expose a compact public API from module-level barrel files like `src/modules/mcp-auth/index.ts`, `src/modules/salesforce-connection/index.ts`, and `src/modules/tool-execution/index.ts`.
- Use singleton exported objects for shared services that maintain state or caches, such as `tokenService` in `src/modules/mcp-auth/services/token-service.ts`, `salesforceConnectionService` in `src/modules/salesforce-connection/services/connection-service.ts`, and `logger` in `src/shared/logger.ts`.

**Barrel Files:** Barrel files are used at module boundaries in `src/modules/*/index.ts` to present stable public entry points. Internal subfolders still import concrete files directly, so add new exports to the relevant module `index.ts` only when the module should expose them broadly.

## Configuration Practices

- Load environment variables once at process startup in `src/index.ts` with `import 'dotenv/config';`.
- Read environment variables through helper functions in `src/shared/config/index.ts` instead of scattering `process.env` access through feature code. `src/modules/salesforce-connection/services/salesforce-client.ts` is a notable exception for `process.env.SALESFORCE_LOGIN_URL`; new configuration should generally flow through `src/shared/config/index.ts`.
- Group configuration by concern into exported objects (`mcpAuth`, `salesforce`, `storage`, `legacy`, `logging`) in `src/shared/config/index.ts`.
- Supply safe defaults for local development where possible, such as `MCP_SERVER_PORT`, `MCP_SERVER_URL`, and `SALESFORCE_LOGIN_URL` in `src/shared/config/index.ts`.
- Treat missing secrets as runtime errors or degraded modes depending on feature criticality: `src/modules/mcp-auth/services/token-service.ts` throws when `MCP_JWT_SECRET` is absent, while `src/shared/security/encryption.ts` falls back to `plain:` storage and logs a warning when `MCP_ENCRYPTION_KEY` is missing.

## Architectural Conventions

- Keep code organized by module boundary first, then by role. The main architectural split is `src/modules/mcp-auth/`, `src/modules/salesforce-connection/`, `src/modules/tool-execution/`, plus cross-cutting `src/shared/` and `src/types/`.
- Use dependency contracts from `src/types/index.ts` to describe cross-module APIs, then implement those contracts in concrete services such as `src/modules/mcp-auth/services/token-service.ts` and `src/modules/salesforce-connection/services/connection-service.ts`.
- Route all MCP request context through `AsyncLocalStorage` in `src/modules/tool-execution/context.ts` and `src/modules/tool-execution/routes/mcp-routes.ts` instead of threading auth headers and response handles through every function call.
- Keep tool definitions close to tool implementations. Each tool file in `src/modules/tool-execution/tools/*.ts` typically exports both a schema object like `SEARCH_OBJECTS` and the corresponding handler like `handleSearchObjects`.

---

*Convention analysis: 2026-03-24*
