# Architecture — Salesforce MCP Server (Auth Edition)

## Overview

This server implements the Model Context Protocol (MCP) with a modular monolith architecture organized into **3 bounded contexts** (modules). MCP clients authenticate to **this server** (not directly to Salesforce), and Salesforce is treated as a backend data source connected via one-time account linking.

A feature flag (`MCP_AUTH_MODE=local|legacy`) enables gradual migration from the original direct-token-proxy design.

---

## Module Map

```
src/
  index.ts                          # Entry point
  types/index.ts                    # Central contracts (interfaces, types)
  shared/                           # Cross-cutting concerns
    config/index.ts                 #   Env-based configuration
    logger.ts                       #   Structured logger + audit logging
    security/encryption.ts          #   AES-256-GCM encryption at rest
    storage/file-store.ts           #   JSON file-based persistence
    error-handler.ts                #   Salesforce error classification
    http/express-app.ts             #   Express wiring (composes all modules)
  modules/
    mcp-auth/                       # MODULE A — MCP Authentication Layer
      middleware.ts                 #   Bearer token validation middleware
      services/token-service.ts     #   JWT (HS256) generation & validation
      services/user-service.ts      #   Local user creation & lookup
      services/auth-code-service.ts #   OAuth authorization codes + PKCE
      routes/oauth-routes.ts        #   Local OAuth endpoints
      routes/legacy-oauth-routes.ts #   Legacy Salesforce-proxy endpoints
      index.ts                      #   Module barrel export
    salesforce-connection/          # MODULE B — Salesforce Connection Layer
      services/connection-service.ts#   Token storage, refresh, connect/disconnect
      services/salesforce-client.ts #   jsforce Connection factory
      routes/salesforce-routes.ts   #   /salesforce/* HTTP endpoints
      index.ts                      #   Module barrel export
    tool-execution/                 # MODULE C — Tool Execution Layer
      mcp-server.ts                 #   MCP SDK server setup (tools, resources)
      handlers/call-tool.ts         #   Tool dispatch + error handling
      handlers/list-tools.ts        #   Tool listing
      adapters/salesforce-adapter.ts#   Resolves SF connection for request context
      context.ts                    #   AsyncLocalStorage for request context
      routes/mcp-routes.ts          #   POST/GET/DELETE /mcp endpoints
      tools/*.ts                    #   15 Salesforce tool implementations
      index.ts                      #   Module barrel export
  test/
    mcp-auth.test.ts                # Module A unit tests (11 tests)
    encryption.test.ts              # Encryption unit tests (4 tests)
    integration.test.ts             # End-to-end HTTP tests (12 tests)
```

---

## Module Responsibilities

### Module A — MCP Auth Layer (`mcp-auth/`)

**Purpose**: MCP clients authenticate to *this server*. Issuing local JWTs, managing users, exposing standard OAuth 2.0 endpoints with PKCE.

| Component | Responsibility |
|---|---|
| `token-service` | HS256 JWT generation (`generateAccessToken`) and validation (`validateAccessToken`). No external dependencies. |
| `user-service` | Creates/looks up local users. File-based persistence via `file-store`. |
| `auth-code-service` | Short-lived authorization codes (5 min TTL, single-use). PKCE S256 verification built-in. In-memory store. |
| `middleware` | Extracts `Authorization: Bearer <token>`, validates JWT, sets `req.principal`. Dispatches based on `authMode`. |
| `oauth-routes` | `/.well-known/*` metadata, `GET/POST /oauth/authorize` (login form), `POST /oauth/token` (code-for-JWT exchange). |
| `legacy-oauth-routes` | Same endpoints but proxy to Salesforce. Backward-compatible with legacy mode. |

**Key interface**: `ITokenService` (from `types/index.ts`)

### Module B — Salesforce Connection Layer (`salesforce-connection/`)

**Purpose**: One-time Salesforce account linking per user. Stores tokens encrypted at rest, handles refresh, provides SF connections to Module C.

| Component | Responsibility |
|---|---|
| `connection-service` | `initiateConnect()` → SF OAuth URL. `handleOAuthCallback()` → exchanges code, encrypts & stores tokens. `getValidAccessContext()` → returns decrypted access token + instance URL. `refreshAccessToken()` → uses refresh_token. `disconnectAccount()` → revokes + deletes. |
| `salesforce-client` | jsforce `Connection` factory. `createSalesforceConnection(token, url)` and `createConnectionFromToken(token)` (legacy, with instance URL auto-discovery). |
| `salesforce-routes` | `GET /salesforce/connect`, `GET /salesforce/callback`, `GET /salesforce/status`, `POST /salesforce/disconnect`. |

**Key interface**: `ISalesforceConnectionService` (from `types/index.ts`)

**Custom errors**: `SalesforceNotConnectedError`, `SalesforceReconnectRequiredError`

### Module C — Tool Execution Layer (`tool-execution/`)

**Purpose**: Executes MCP tools using the user's stored Salesforce tokens. Never touches OAuth details directly.

| Component | Responsibility |
|---|---|
| `salesforce-adapter` | `getSalesforceConnectionForRequest(principal, rawBearer)` — bridges Module A (principal) + Module B (tokens) into a jsforce Connection. |
| `call-tool` | Reads principal from `AsyncLocalStorage`, gets connection via adapter, dispatches to 15 tool handlers. Handles `SalesforceNotConnectedError` and `SalesforceReconnectRequiredError` with clear user-facing messages. |
| `mcp-routes` | `POST /mcp` (JSON-RPC + SSE), `GET /mcp` (SSE reconnect), `DELETE /mcp` (session teardown). Session management via transport map. |
| `tools/*` | 15 Salesforce tools: search, describe, query, aggregateQuery, dml, manageObject, manageField, manageFieldPermissions, searchAll, readApex, writeApex, readApexTrigger, writeApexTrigger, executeAnonymous, manageDebugLogs. |

**Key interface**: `IToolContextResolver` (from `types/index.ts`)

---

## Dependency Flow

```
Module A (Auth)  ←  middleware validates JWT
       ↓
Module C (Tools) ←  gets principal from AsyncLocalStorage
       ↓
    Adapter      →  calls Module B to resolve SF connection
       ↓
Module B (SF)    →  returns access token + instance URL
       ↓
    jsforce      →  executes Salesforce API calls
```

**Rules**:
- Module A never imports from Module B or C
- Module B never imports from Module A or C
- Module C depends on A (principal type) and B (connection service) via the adapter
- All inter-module contracts are defined in `types/index.ts`

---

## Authentication Flows

### Local Mode (`MCP_AUTH_MODE=local`)

```
MCP Client                    This Server                    Salesforce
    │                              │                              │
    │─── GET /.well-known/* ──────>│                              │
    │<── auth server metadata ─────│                              │
    │                              │                              │
    │─── GET /oauth/authorize ────>│                              │
    │<── HTML login form ──────────│                              │
    │                              │                              │
    │─── POST /oauth/authorize ───>│                              │
    │<── redirect with auth code ──│                              │
    │                              │                              │
    │─── POST /oauth/token ───────>│  (PKCE verified)            │
    │<── local JWT ────────────────│                              │
    │                              │                              │
    │─── POST /mcp (Bearer JWT) ──>│                              │
    │    (tool call)               │── SF API call ──────────────>│
    │<── tool result ──────────────│<─ response ──────────────────│
```

### Salesforce Account Linking (one-time, browser)

```
User (Browser)                This Server                    Salesforce
    │                              │                              │
    │─── GET /salesforce/connect ─>│                              │
    │    (must be authenticated)   │                              │
    │<── redirect to SF OAuth ─────│                              │
    │                              │                              │
    │───────────────── SF login + consent ───────────────────────>│
    │<──────────────── redirect to /salesforce/callback ──────────│
    │                              │                              │
    │─── GET /salesforce/callback─>│── exchange code ────────────>│
    │    (with ?code=...&state=..) │<─ access + refresh tokens ───│
    │                              │   (encrypted, stored)        │
    │<── HTML "Success!" page ─────│                              │
```

### Legacy Mode (`MCP_AUTH_MODE=legacy`)

MCP clients send Salesforce access tokens directly in `Authorization: Bearer`. The server proxies to Salesforce without its own auth layer. OAuth endpoints proxy to Salesforce's OAuth server.

---

## Security

### Token Encryption at Rest
- Salesforce refresh tokens and access tokens are encrypted with **AES-256-GCM** before storage
- Random IV per encryption operation (different ciphertext for same plaintext)
- Key from `MCP_ENCRYPTION_KEY` (64-character hex = 32 bytes)
- Falls back to `plain:` prefix if no key configured (development only)

### JWT Security
- HS256 with `MCP_JWT_SECRET` (minimum 32 characters)
- 1-hour expiry, unique `jti` per token
- `iss` and `aud` bound to `MCP_SERVER_URL`

### PKCE
- S256 code challenge method required for both MCP OAuth and SF OAuth
- Authorization codes are single-use, 5-minute TTL

### Audit Logging
- `logger.auditLog()` for security-relevant events (login, token exchange, SF connect/disconnect)
- Token masking in logs (shows only last 8 characters)
- Header sanitization (Authorization headers redacted)

---

## Configuration

All configuration via environment variables. See `.env.example` for full reference.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_AUTH_MODE` | No | `local` | `local` or `legacy` |
| `MCP_JWT_SECRET` | Yes (local) | — | HS256 signing key (32+ chars) |
| `MCP_SERVER_URL` | Yes | — | Public URL of this server |
| `SALESFORCE_CLIENT_ID` | Yes (local) | — | SF Connected App client ID |
| `SALESFORCE_CLIENT_SECRET` | Yes (local) | — | SF Connected App client secret |
| `MCP_ENCRYPTION_KEY` | Recommended | — | 64-char hex for AES-256-GCM |
| `MCP_DATA_DIR` | No | `.data/` | File-based storage directory |
| `MCP_LOG_LEVEL` | No | `INFO` | ERROR/WARN/INFO/DEBUG/VERBOSE |
| `PORT` | No | `3000` | HTTP listen port |

---

## Testing

**27 tests total**, all passing:

| Suite | Tests | Coverage |
|---|---|---|
| `mcp-auth.test.ts` | 11 | JWT gen/validation/rejection/expiry, user CRUD, auth code PKCE/single-use/client validation |
| `encryption.test.ts` | 4 | Encrypt/decrypt, random IV, empty string, long strings |
| `integration.test.ts` | 12 | Server info, health, 401 paths, MCP initialize, OAuth metadata, login page, SF status, tool call without connection, 404 |

Run all tests:
```bash
npm test
```

---

## File-Based Storage

Data persisted in `MCP_DATA_DIR` (default: `.data/`):

| Collection | Contents | Module |
|---|---|---|
| `local_users` | User records (id, displayName, createdAt) | A |
| `sf_connections` | Encrypted SF tokens, instance URL, status, timestamps | B |

The `file-store.ts` provides generic CRUD: `findAll`, `findOne`, `upsert`, `remove`. Designed to be swappable for a database adapter later.

---

## Shared Infrastructure

| Component | Purpose |
|---|---|
| `config/index.ts` | Single source of truth for all env-based configuration |
| `logger.ts` | Structured logging with levels, audit logging, token masking |
| `security/encryption.ts` | AES-256-GCM encrypt/decrypt for token storage |
| `storage/file-store.ts` | JSON file persistence (collection-based) |
| `error-handler.ts` | Salesforce error classification and user-friendly messages |
| `http/express-app.ts` | Express app factory — composes modules based on `authMode` |
