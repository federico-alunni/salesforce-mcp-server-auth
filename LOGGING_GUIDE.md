# MCP Server Logging Guide

## Overview

The server writes all log output to **stderr** so it never interferes with the
MCP protocol stream on stdout.

## Log levels

| Level | What is logged |
|-------|----------------|
| ERROR | Critical errors only |
| WARN | Warnings and errors |
| INFO | Server startup, tool completions, record counts (default) |
| DEBUG | Tool arguments (sanitized), Salesforce API calls, SOQL queries, instance URL discovery |
| VERBOSE | Full request/response bodies (truncated at 1,000 chars), HTTP session traces |

## Configuration

```bash
# In .env or as environment variables
MCP_LOG_LEVEL=DEBUG        # ERROR | WARN | INFO | DEBUG | VERBOSE  (default: INFO)
MCP_LOG_TIMESTAMPS=true    # true | false  (default: true)
```

## Example output

### Server startup (INFO)

```
[2026-03-12T10:30:15.123Z] [INFO]  Starting Salesforce MCP Server (Streamable HTTP)...
[2026-03-12T10:30:15.125Z] [INFO]  Salesforce MCP Server running on Streamable HTTP port 3000
[2026-03-12T10:30:15.126Z] [INFO]  Connect to: http://localhost:3000/mcp
```

### Instance URL discovery (DEBUG)

```
[2026-03-12T10:30:20.455Z] [DEBUG] Salesforce API: Discover instance URL via userinfo { loginUrl: 'https://login.salesforce.com' }
[2026-03-12T10:30:20.612Z] [DEBUG] Discovered and cached instance URL: https://na50.salesforce.com
[2026-03-12T10:30:20.613Z] [DEBUG] Building jsforce connection for instance: https://na50.salesforce.com
```

### Tool call (DEBUG)

```
[2026-03-12T10:30:20.614Z] [INFO]  Incoming request payload..
[2026-03-12T10:30:20.615Z] [DEBUG] Bearer token received, length=200
[2026-03-12T10:30:20.616Z] [DEBUG] Tool: salesforce_query_records { objectName: 'Account', fields: ['Name','Industry'], limit: 10 }
[2026-03-12T10:30:21.789Z] [INFO]  Tool salesforce_query_records completed in 1173ms [SUCCESS] (10 records)
```

### Cache hit (DEBUG)

```
[2026-03-12T10:30:25.001Z] [DEBUG] Using cached instance URL for token
```

### Error (ERROR)

```
[2026-03-12T10:30:30.123Z] [ERROR] Tool salesforce_query_records failed after 145ms [INVALID_FIELD]: No such column 'BadField__c' on entity 'Account'
```

## Redirecting logs to a file

```bash
# File only
node dist/index.js 2> mcp-server.log

# File and terminal simultaneously
node dist/index.js 2>&1 | tee mcp-server.log
```

## Security — sensitive data redaction

The logger automatically replaces values for keys that match:
password, 	oken, secret, piKey, clientSecret

These are replaced with ***REDACTED*** in all log output. Raw access tokens
are never logged; only their length is recorded at DEBUG level.

## Performance impact

- INFO: ~1-2% overhead
- DEBUG: ~3-5% overhead
- VERBOSE: ~5-10% overhead

The logger skips all string formatting when a level is disabled.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No logs appearing | Check MCP_LOG_LEVEL is set; logs go to stderr, not stdout |
| Too much output | Use MCP_LOG_LEVEL=WARN or ERROR |
| Instance URL discovery fails | Enable DEBUG to see the full userinfo error; check SALESFORCE_LOGIN_URL for sandbox |
| Sensitive data in logs | Report via GitHub issues; add the field name to sensitiveKeys in src/utils/logger.ts |

---
