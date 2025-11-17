# Salesforce MCP Server - Transport Options

This server supports two HTTP-based transport methods:

## 1. SSE (Server-Sent Events) Transport

Legacy HTTP transport using Server-Sent Events for real-time communication.

### Configuration:

```bash
# Environment variable
MCP_TRANSPORT_TYPE=sse
MCP_SERVER_PORT=3000

# Or command line
node dist/index.js --sse
```

### Usage:

```bash
node dist/index.js --sse
# Output: Salesforce MCP Server running on SSE port 3000
# SSE endpoint: http://localhost:3000/sse
# Messages endpoint: http://localhost:3000/messages
```

### Endpoints:

- **SSE Connection:** `GET http://localhost:3000/sse`
- **Send Messages:** `POST http://localhost:3000/messages?sessionId=<session_id>`

## 2. Streamable HTTP Transport (Recommended)

Modern HTTP transport with full MCP protocol support.

### Configuration:

```bash
# Environment variable
MCP_TRANSPORT_TYPE=streamable-http
MCP_SERVER_PORT=3000

# Or command line
node dist/index.js --http
# or
node dist/index.js --streamable-http
```

### Usage:

```bash
node dist/index.js --http
# Output: Salesforce MCP Server running on Streamable HTTP port 3000
# Connect to: http://localhost:3000/mcp
```

### Endpoints:

- **Main endpoint:** `POST http://localhost:3000/mcp`
- **Notifications:** `GET http://localhost:3000/mcp` (with session management)
- **Session termination:** `DELETE http://localhost:3000/mcp`

## Environment Variables

### Authentication (Required)

```bash
SALESFORCE_CONNECTION_TYPE=OAuth_2.0_Client_Credentials
SALESFORCE_CLIENT_ID=your_client_id
SALESFORCE_CLIENT_SECRET=your_client_secret
SALESFORCE_INSTANCE_URL=https://your-domain.my.salesforce.com
```

### Transport Configuration

```bash
# Primary transport selection
MCP_TRANSPORT_TYPE=sse|streamable-http

# Server port (for HTTP transports)
MCP_SERVER_PORT=3000

# Legacy support
MCP_SERVER_HTTP=true  # Will use streamable-http
```

## Command Line Options

### Transport Selection

- `--sse` - Use SSE transport
- `--http` or `--streamable-http` - Use Streamable HTTP transport

Command line arguments take precedence over environment variables.

### Examples:

```bash
# Streamable HTTP (default)
node dist/index.js
node dist/index.js --http

# SSE Transport
node dist/index.js --sse

# Streamable HTTP Transport
node dist/index.js --http
```

## Testing with MCP Inspector

1. Start the server:

   ```bash
   node dist/index.js --http
   ```

2. In MCP Inspector web UI, connect to:
   - **Streamable HTTP:** `http://localhost:3000/mcp`
   - **SSE:** `http://localhost:3000/sse`

## Choosing the Right Transport

- **SSE**: Legacy HTTP transport, use only if Streamable HTTP isn't supported
- **Streamable HTTP**: Modern HTTP transport, best for web applications and remote access (default)
