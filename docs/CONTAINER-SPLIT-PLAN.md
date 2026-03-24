# Container Split Plan — From Monolith to 3 Services

## Current State: Modular Monolith

The codebase is organized into 3 bounded contexts that share a single Express process. Inter-module communication is via direct function calls through well-defined TypeScript interfaces.

```
┌─────────────────────────────────────────────┐
│              Single Process                  │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Module A  │  │ Module B │  │ Module C  │  │
│  │ MCP Auth  │  │ SF Conn  │  │ Tool Exec │  │
│  └──────────┘  └──────────┘  └───────────┘  │
│        ↕              ↕             ↕        │
│  ┌──────────────────────────────────────┐    │
│  │       Shared (config, logger,       │    │
│  │    file-store, encryption, types)    │    │
│  └──────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

## Target State: 3 Containers

```
┌─────────────┐   ┌──────────────┐   ┌──────────────┐
│  Auth Svc   │   │  SF Token    │   │  MCP Tool    │
│  (Module A) │   │  Svc (Mod B) │   │  Svc (Mod C) │
│  Port 3001  │   │  Port 3002   │   │  Port 3003   │
└──────┬──────┘   └──────┬───────┘   └──────┬───────┘
       │                 │                   │
       └─────────┬───────┘                   │
                 │                           │
          ┌──────┴───────┐                   │
          │  Shared DB   │                   │
          │  (Postgres)  │←──────────────────┘
          └──────────────┘
```

---

## Phase 1: Preparation (current monolith)

**Already done:**
- [x] Modules communicate only through interfaces (`ITokenService`, `ISalesforceConnectionService`, `IToolContextResolver`)
- [x] No circular dependencies between modules
- [x] Shared types defined in `types/index.ts`
- [x] File-store abstraction ready to swap for database

**Still needed:**
- [ ] Replace file-store with a database adapter (Postgres/SQLite)
- [ ] Move auth code store from in-memory Map to database
- [ ] Add health check endpoints per module

---

## Phase 2: Extract Module A — Auth Service

**What moves**: `modules/mcp-auth/` + `shared/config` (auth subset) + `shared/logger`

**New service exposes**:
| Endpoint | Purpose |
|---|---|
| `POST /internal/validate-token` | Validates JWT, returns `LocalPrincipal` |
| `GET /oauth/authorize` | Login form |
| `POST /oauth/authorize` | Login + code issuance |
| `POST /oauth/token` | Code → JWT exchange |
| `/.well-known/*` | OAuth metadata |

**Changes in Module C**:
- Replace direct `tokenService.validateAccessToken()` call in middleware with HTTP call to `POST /internal/validate-token`
- Cache validation results briefly (< 30s) to reduce round-trips

**Database tables**:
```sql
CREATE TABLE local_users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE auth_codes (
  code TEXT PRIMARY KEY,
  user_id UUID REFERENCES local_users(id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed BOOLEAN NOT NULL DEFAULT FALSE
);
```

---

## Phase 3: Extract Module B — SF Token Service

**What moves**: `modules/salesforce-connection/` + `shared/security/encryption.ts`

**New service exposes**:
| Endpoint | Purpose |
|---|---|
| `GET /internal/access-context/:userId` | Returns decrypted access token + instance URL |
| `POST /internal/refresh/:userId` | Forces token refresh |
| `GET /salesforce/connect` | Initiates SF OAuth (browser redirect) |
| `GET /salesforce/callback` | Handles SF OAuth callback |
| `GET /salesforce/status` | Connection status |
| `POST /salesforce/disconnect` | Revoke + delete |

**Changes in Module C**:
- Replace direct `salesforceConnectionService.getValidAccessContext()` with HTTP call to `GET /internal/access-context/:userId`
- Replace error class checks with HTTP status codes (404 = not connected, 409 = reconnect required)

**Database tables**:
```sql
CREATE TABLE sf_connections (
  user_id UUID PRIMARY KEY REFERENCES local_users(id),
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  instance_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  connected_at TIMESTAMPTZ NOT NULL,
  last_refreshed_at TIMESTAMPTZ,
  token_expires_at TIMESTAMPTZ
);
```

---

## Phase 4: Module C Becomes the MCP Tool Service

**What remains**: `modules/tool-execution/` + MCP SDK + jsforce

**Changes**:
- `salesforce-adapter.ts` calls Module B's HTTP API instead of direct imports
- Auth middleware calls Module A's HTTP API for token validation
- Express app only mounts `/mcp` and health check routes

---

## Migration Strategy

### Step-by-step:
1. **Add database adapter** — implement `IFileStore`-compatible Postgres adapter. Both modules use it.
2. **Extract Auth Service first** — lowest coupling. Module C calls it via HTTP for token validation.
3. **Extract SF Token Service** — Module C adapter switches from direct import to HTTP client.
4. **Add API gateway** (optional) — reverse proxy routes `/oauth/*` to Auth, `/salesforce/*` to SF Token, `/mcp` to Tool.

### Backward compatibility during migration:
- Feature flag `MCP_DEPLOYMENT_MODE=monolith|distributed` can toggle between direct calls and HTTP calls in the adapter layer
- The adapter pattern (`salesforce-adapter.ts`) already abstracts the connection source, making it a single-file change

---

## Infrastructure Requirements for Distributed Mode

| Component | Purpose |
|---|---|
| PostgreSQL | Shared state (users, tokens, auth codes) |
| API Gateway / Reverse Proxy | Route `/oauth/*`, `/salesforce/*`, `/mcp` to correct service |
| Shared secret management | `MCP_JWT_SECRET` and `MCP_ENCRYPTION_KEY` must be identical across services |
| Internal network | `/internal/*` endpoints must NOT be exposed to the internet |
| Health checks | Each service exposes `/health` for container orchestrator |

### Docker Compose (sketch)

```yaml
services:
  auth:
    build: { context: ., dockerfile: Dockerfile.auth }
    environment:
      - MCP_JWT_SECRET=${MCP_JWT_SECRET}
      - DATABASE_URL=postgres://db:5432/mcp
    ports: ["3001:3001"]

  sf-tokens:
    build: { context: ., dockerfile: Dockerfile.sf-tokens }
    environment:
      - MCP_ENCRYPTION_KEY=${MCP_ENCRYPTION_KEY}
      - SALESFORCE_CLIENT_ID=${SALESFORCE_CLIENT_ID}
      - SALESFORCE_CLIENT_SECRET=${SALESFORCE_CLIENT_SECRET}
      - DATABASE_URL=postgres://db:5432/mcp
    ports: ["3002:3002"]

  mcp-tools:
    build: { context: ., dockerfile: Dockerfile.mcp-tools }
    environment:
      - AUTH_SERVICE_URL=http://auth:3001
      - SF_TOKEN_SERVICE_URL=http://sf-tokens:3002
      - MCP_JWT_SECRET=${MCP_JWT_SECRET}
    ports: ["3003:3003"]

  db:
    image: postgres:16
    volumes: [pgdata:/var/lib/postgresql/data]
    environment:
      - POSTGRES_DB=mcp

  gateway:
    image: nginx:alpine
    ports: ["3000:3000"]
    # Routes: /oauth/* → auth, /salesforce/* → sf-tokens, /mcp → mcp-tools

volumes:
  pgdata:
```

---

## Effort Estimate per Phase

| Phase | Scope | Key Changes |
|---|---|---|
| Phase 1 | DB adapter | Replace `file-store` with Postgres adapter, migrate auth codes from in-memory to DB |
| Phase 2 | Auth service | Add `/internal/validate-token`, update middleware to HTTP call, Dockerfile |
| Phase 3 | SF token service | Add `/internal/access-context`, update adapter to HTTP call, Dockerfile |
| Phase 4 | Tool service | Remove direct module imports, add HTTP clients, Dockerfile, gateway config |

Each phase is independently deployable. The monolith continues working throughout the migration.
