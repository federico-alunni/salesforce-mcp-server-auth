# Salesforce MCP Server

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/federico-alunni/mcp-server-salesforce/badge)](https://securityscorecards.dev/viewer/?uri=github.com/federico-alunni/mcp-server-salesforce)

An MCP (Model Context Protocol) server that connects AI agents to Salesforce,
enabling natural-language interactions with your Salesforce data and metadata.

<a href="https://glama.ai/mcp/servers/kqeniawbr6">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/kqeniawbr6/badge" alt="Salesforce MCP server" />
</a>

---

## How it works

1. The client (e.g. LibreChat) handles the full OAuth flow and obtains a
   Salesforce access token.
2. On every tool call the client sends a standard MCP JSON-RPC request to
   POST /mcp with the token in the **standard HTTP Authorization header**:
   ```
   Authorization: Bearer <salesforce_access_token>
   ```
3. The server calls the Salesforce **userinfo endpoint** with that token to
   discover the org's instance URL automatically — no instance URL, client
   secret, or any other credential needs to be configured.
4. The requested Salesforce tool is executed against the discovered instance.

The server is **stateless and multi-tenant**: each request is fully
self-contained, and multiple users connected to different orgs can use the same
server instance simultaneously.

---

## Features

- **Object & field management** — create and update custom objects and fields
- **Smart object search** — find objects by partial name or label
- **Detailed schema information** — field types, picklists, relationships
- **Flexible data queries** — SOQL with relationship support and complex filters
- **Aggregate queries** — GROUP BY, HAVING, date functions
- **Data manipulation** — insert, update, delete, upsert
- **Cross-object search** — SOSL across multiple objects
- **Apex management** — read, create, update Apex classes and triggers
- **Anonymous Apex execution** — run ad-hoc Apex with debug log access
- **Debug log management** — enable, disable, and retrieve trace logs per user
- **Stateless & multi-tenant** — no stored credentials; one server, many orgs
- **Automatic instance URL discovery** — no Salesforce instance URL needed at startup

---

## Installation

```bash
npm install -g @federico-alunni/mcp-server-salesforce
```

---

## Quick start

```bash
# 1. Copy and configure environment
cp .env.example .env
# Edit .env: set SALESFORCE_LOGIN_URL to test.salesforce.com for sandboxes

# 2. Build
npm run build

# 3. Start
node dist/index.js
# Server starts on http://localhost:3000
```

---

## Authentication

The server accepts a single header on every MCP request:

| Header | Value | Required |
|--------|-------|----------|
| Authorization | Bearer <salesforce_access_token> | Yes |

No instance URL, client ID, client secret, or username headers are needed.
The token is used as-is to call the Salesforce userinfo endpoint; the
instance URL is derived from the response automatically.

### Sandbox / custom domain support

Set SALESFORCE_LOGIN_URL in .env to point at the correct identity server:

```bash
SALESFORCE_LOGIN_URL=https://test.salesforce.com   # sandbox
SALESFORCE_LOGIN_URL=https://login.salesforce.com  # production (default)
```

---

## Tools

### salesforce_search_objects
Find standard and custom objects by partial name or label match.

### salesforce_describe_object
Get full schema for an object: fields, types, picklist values, relationships.

### salesforce_query_records
SOQL query with parent/child relationship support, WHERE, ORDER BY, LIMIT.
> For GROUP BY and aggregate functions use salesforce_aggregate_query.

### salesforce_aggregate_query
Aggregate SOQL with GROUP BY (single or multiple fields), HAVING, and date/time
grouping functions (COUNT, SUM, AVG, MIN, MAX, COUNT_DISTINCT).

### salesforce_dml_records
Insert, update, delete, or upsert records (upsert supports external IDs).

### salesforce_manage_object
Create or update custom objects via the Metadata API. Configure sharing model,
activities, description, and deployment status.

### salesforce_manage_field
Create or update custom fields via the Metadata API. Automatically grants Field
Level Security to System Administrator; use grantAccessTo for other profiles.

### salesforce_manage_field_permissions
Grant, revoke, or view read/edit FLS on a field for named profiles.

### salesforce_search_all
SOSL search across multiple objects with per-object WHERE / ORDER BY / LIMIT,
WITH clauses, and updateable/viewable filters.

### salesforce_read_apex
Retrieve Apex class source by exact name or wildcard pattern (*, ?).

### salesforce_write_apex
Create or update Apex classes via the Tooling API.

### salesforce_read_apex_trigger
Retrieve Apex trigger source by exact name or wildcard pattern.

### salesforce_write_apex_trigger
Create or update Apex triggers via the Tooling API.

### salesforce_execute_anonymous
Execute anonymous Apex and return compile/run status plus debug logs.

### salesforce_manage_debug_logs
Enable, disable, or retrieve TraceFlag/DebugLevel entries per Salesforce user.

---

## Logging

```bash
MCP_LOG_LEVEL=DEBUG        # ERROR | WARN | INFO (default) | DEBUG | VERBOSE
MCP_LOG_TIMESTAMPS=true    # ISO-8601 timestamps (default: true)
```

Logs go to **stderr**. Access tokens are never logged; only their length is
recorded at DEBUG level. See [LOGGING_GUIDE.md](LOGGING_GUIDE.md) for details.

---

## Error handling

Tool errors are returned as valid MCP responses (not thrown), with a
human-readable message classified by type:

INVALID_SESSION · INSUFFICIENT_ACCESS · INVALID_FIELD ·
INVALID_OPERATION · QUERY_TIMEOUT · API_LIMIT_EXCEEDED · UNKNOWN

---

## Usage examples

```
"Find all objects related to Accounts"
"What fields are on the Opportunity object?"
"Get all Accounts created this month"
"Count open Opportunities by Stage"
"Create a Customer Feedback custom object"
"Add a Rating picklist field to Account"
"Grant read access to Rating__c for Marketing User"
"Search for 'cloud' across Accounts and Opportunities"
"Show me the AccountController Apex class"
"Enable debug logs for user@example.com"
"Execute Apex: System.debug(UserInfo.getUserId());"
```

---

## Development

```bash
git clone https://github.com/federico-alunni/mcp-server-salesforce.git
cd mcp-server-salesforce
npm install
npm run build
```

See [TRANSPORT_GUIDE.md](TRANSPORT_GUIDE.md) for endpoint and request format details.

---

## Contributing

Contributions are welcome. Please submit a Pull Request.

## License

MIT — see [LICENSE](LICENSE).

## Issues and support

File an issue on the [GitHub repository](https://github.com/federico-alunni/mcp-server-salesforce/issues).
