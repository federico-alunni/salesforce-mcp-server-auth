# Salesforce MCP Server - Transport Guide

The server exclusively uses **Streamable HTTP** transport, exposed on a single
POST /mcp endpoint. SSE transport has been removed.

## Starting the server

```bash
# Install dependencies and build
npm install
npm run build

# Start (defaults to port 3000)
node dist/index.js

# Custom port
MCP_SERVER_PORT=8080 node dist/index.js
```

## Endpoint

| Method | Path | Purpose |
|--------|------|---------|
| POST | /mcp | All MCP JSON-RPC requests (tools/list, tools/call, etc.) |
| GET  | /health | Server health check |

The transport operates in **stateless mode**: a new server instance is created
for each POST request. No session IDs or persistent connections are required.

## Authentication

Every POST /mcp request must include a valid Salesforce access token in the
standard HTTP Authorization header:

```
Authorization: Bearer <salesforce_access_token>
```

The server automatically discovers the org instance URL by calling the
Salesforce userinfo endpoint with that token - no instance URL needs to be
configured or sent by the client.

## Health check

```bash
curl http://localhost:3000/health
```

Response:

```json
{
  "status": "healthy",
  "transport": "streamable-http",
  "auth": "Authorization: Bearer <salesforce_access_token>",
  "instanceDiscovery": "https://login.salesforce.com/services/oauth2/userinfo",
  "instanceUrlCacheTTL": 300000,
  "toolsAvailable": 15
}
```

## Example tool call

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 00D..." \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "salesforce_query_records",
      "arguments": {
        "objectName": "Account",
        "fields": ["Name", "Industry"],
        "limit": 5
      }
    }
  }'
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| MCP_SERVER_PORT | 3000 | HTTP port |
| SALESFORCE_LOGIN_URL | https://login.salesforce.com | Used to call the userinfo endpoint. Set to https://test.salesforce.com for sandbox orgs. |
| MCP_CONNECTION_CACHE_TTL | 300000 | How long (ms) to cache the discovered instance URL per token |
| MCP_LOG_LEVEL | INFO | ERROR \| WARN \| INFO \| DEBUG \| VERBOSE |

## Testing with MCP Inspector

1. Start the server: 
ode dist/index.js
2. In MCP Inspector, connect to: http://localhost:3000/mcp
3. Set the Authorization header to Bearer <your_access_token> in the
   inspector's custom headers section before calling any tool.
