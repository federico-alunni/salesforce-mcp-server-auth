# Testing Patterns

**Analysis Date:** 2026-03-24

## Test Framework

**Runner:**
- Node.js built-in test runner via `node --test` from the `test` script in `package.json`
- Config: no dedicated Jest/Vitest config detected; test execution is defined directly in `package.json`

**Assertion Library:**
- `node:assert/strict`, imported in `src/test/encryption.test.ts`, `src/test/integration.test.ts`, and `src/test/mcp-auth.test.ts`

**Run Commands:**
```bash
npm test               # Compile TypeScript, then run dist/test/*.test.js with node --test
npm run build          # Compile TypeScript to dist/ before manual test execution
node --test --test-force-exit dist/test/*.test.js   # Direct compiled-test command from package.json
```

## Test File Organization

**Location:**
- Tests live in a dedicated top-level source test folder: `src/test/`.
- Tests are not co-located with implementation files. Compilation emits them into `dist/test/`, and the test command runs the compiled JavaScript.

**Naming:**
- Use `*.test.ts` naming, with one file per concern: `src/test/encryption.test.ts`, `src/test/integration.test.ts`, and `src/test/mcp-auth.test.ts`.

**Structure:**
```text
src/
├── test/
│   ├── encryption.test.ts
│   ├── integration.test.ts
│   └── mcp-auth.test.ts
└── modules/
    ├── mcp-auth/
    ├── salesforce-connection/
    └── tool-execution/
```

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Integration — Local Auth Mode', async () => {
  const { createApp } = await import('../shared/http/express-app.js');

  let server: http.Server;

  before(async () => {
    server = createApp().listen(0);
    await new Promise<void>(resolve => server.on('listening', resolve));
  });

  after(() => { server.close(); });

  it('GET /health should return healthy', async () => {
    const res = await request(server, 'GET', '/health');
    assert.equal(res.status, 200);
  });
});
```
- The actual pattern above comes from `src/test/integration.test.ts`.

**Patterns:**
- Set required environment variables at the top of the test file before dynamic imports load config, as shown in `src/test/mcp-auth.test.ts`, `src/test/integration.test.ts`, and `src/test/encryption.test.ts`.
- Use top-level `describe(..., async () => { ... })` blocks with dynamic `await import(...)` so configuration is loaded after environment setup. This is the dominant pattern in all current test files under `src/test/`.
- Use nested `describe()` blocks to group behavior by service or subsystem, as in the `Token Service`, `User Service`, and `Authorization Code Service` suites in `src/test/mcp-auth.test.ts`.
- Use `before()` and `after()` hooks only when external resources are required, such as starting and closing an HTTP server in `src/test/integration.test.ts`.
- Prefer straightforward assertions on status codes, JSON bodies, and string fragments rather than custom matchers or helpers.

## Mocking

**Framework:** Not used

**Patterns:**
```typescript
process.env.MCP_JWT_SECRET = 'integration-test-secret-key-32chars-long-enough-x';
process.env.MCP_AUTH_MODE = 'local';
process.env.MCP_SERVER_URL = 'http://localhost:0';
process.env.MCP_LOG_LEVEL = 'ERROR';
process.env.MCP_DATA_DIR = '.data/test-int-' + Date.now();

const { createApp } = await import('../shared/http/express-app.js');
```
- Current tests prefer real module wiring with controlled environment variables over mocks, stubs, or monkey-patching.
- `src/test/integration.test.ts` exercises a real Express app and real auth middleware on an ephemeral port.
- `src/test/mcp-auth.test.ts` uses real crypto primitives from `node:crypto` to produce valid and tampered JWT/PKCE inputs instead of mocking the token layer.

**What to Mock:**
- No established in-repo mocking pattern exists. If new tests need mocking, introduce it sparingly around external Salesforce network calls in `src/modules/salesforce-connection/services/connection-service.ts` and `src/modules/salesforce-connection/services/salesforce-client.ts`, because current tests do not hit live Salesforce.

**What NOT to Mock:**
- Do not mock core local auth, encryption, or Express route wiring when the purpose is to verify end-to-end behavior within this process. Existing tests deliberately exercise the real code paths in `src/shared/security/encryption.ts`, `src/modules/mcp-auth/services/*.ts`, and `src/shared/http/express-app.ts`.

## Fixtures and Factories

**Test Data:**
```typescript
const codeVerifier = 'test-code-verifier-string-long-enough';
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

const code = generateAuthorizationCode({
  userId: 'user-123',
  clientId: 'test-client',
  redirectUri: 'http://localhost:3000/callback',
  codeChallenge,
  codeChallengeMethod: 'S256',
  scopes: ['mcp:tools'],
});
```
- This pattern from `src/test/mcp-auth.test.ts` shows the current style: inline fixture creation close to the assertion, with no shared factory utilities.
- Unique identifiers are commonly derived from `Date.now()` to avoid state collisions in file-backed storage, for example `test-user-` and per-suite `MCP_DATA_DIR` values in `src/test/mcp-auth.test.ts` and `src/test/integration.test.ts`.
- Crypto-based random values are generated inline when needed, such as `randomBytes(32).toString('hex')` in `src/test/encryption.test.ts`.

**Location:**
- No shared fixture or factory directory exists.
- All fixtures are local variables inside the individual test files under `src/test/`.

## Coverage

**Requirements:** None enforced

**View Coverage:**
```bash
Not configured
```
- No coverage command, coverage threshold, or reporter configuration is defined in `package.json`.
- The current `npm test` command does not enable Node coverage output.
- A manual `npm test` run completed successfully on 2026-03-24 with 27 passing tests and 0 failures.

## Test Types

**Unit Tests:**
- `src/test/encryption.test.ts` validates pure crypto helpers in `src/shared/security/encryption.ts`.
- `src/test/mcp-auth.test.ts` validates local auth services in `src/modules/mcp-auth/services/token-service.ts`, `src/modules/mcp-auth/services/user-service.ts`, and `src/modules/mcp-auth/services/auth-code-service.ts`.
- Unit tests favor real implementations plus deterministic inputs rather than mocks.

**Integration Tests:**
- `src/test/integration.test.ts` boots the full Express app from `src/shared/http/express-app.ts`, exercises HTTP endpoints, validates auth middleware behavior, and verifies one MCP tool call failure path without a Salesforce connection.
- Integration tests use a helper `request()` function in `src/test/integration.test.ts` built on `node:http` rather than introducing Supertest or another HTTP test dependency.

**E2E Tests:**
- Not used
- No browser automation, deployed-environment tests, or live Salesforce end-to-end suite is present in the repository.

## Common Patterns

**Async Testing:**
```typescript
it('POST /mcp with valid token + initialize should succeed', async () => {
  const res = await request(server, 'POST', '/mcp', {
    Authorization: `Bearer ${validToken}`,
    Accept: 'application/json, text/event-stream',
  }, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  assert.equal(res.status, 200);
});
```
- Async tests return promises via `async` functions and await real I/O, matching `src/test/integration.test.ts`.

**Error Testing:**
```typescript
it('should reject an invalid token', async () => {
  const principal = await tokenService.validateAccessToken('invalid.token.here');
  assert.equal(principal, null);
});

it('POST /mcp without auth should return 401', async () => {
  const res = await request(server, 'POST', '/mcp', {}, {});
  assert.equal(res.status, 401);
});
```
- Error tests assert explicit nulls, HTTP status codes, and human-readable messages instead of relying on thrown exception snapshots.

## Verification Commands

- Use `npm run build` from `package.json` to verify the codebase still compiles under strict TypeScript settings in `tsconfig.json`.
- Use `npm test` from `package.json` to compile and run all tests.
- Use `node dist/index.js` after a successful build when you need a manual smoke test of the server startup path documented in `README.md`.

## Quality Gaps

- Test coverage is concentrated in `src/shared/security/encryption.ts`, `src/modules/mcp-auth/services/*.ts`, and one app-level integration flow in `src/test/integration.test.ts`. There are no direct tests for most files under `src/modules/tool-execution/tools/*.ts`.
- No tests directly cover `src/modules/salesforce-connection/services/connection-service.ts`, which contains token exchange, refresh, disconnect, and persistence behavior.
- No tests directly cover `src/modules/salesforce-connection/services/salesforce-client.ts`, including instance URL discovery, cache invalidation, and jsforce logging wrappers.
- No tests cover `src/shared/storage/file-store.ts`, despite it being a persistence dependency for users and Salesforce connection records.
- No tests cover `src/modules/mcp-auth/routes/legacy-oauth-routes.ts`, so legacy mode behavior is largely unverified.
- No coverage tooling is present, so regressions in untested paths can land without a visibility signal.
- `npm test` compiles TypeScript before running tests, which is a useful gate, but there is no separate watch-mode test workflow or lint step defined in `package.json`.

---

*Testing analysis: 2026-03-24*
