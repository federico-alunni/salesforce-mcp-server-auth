# MCP Server Logging Guide

## Overview

This guide explains the comprehensive logging system added to the Salesforce MCP Server to help you debug and monitor operations.

## Features

### 1. **Multi-Level Logging**

Five logging levels with increasing verbosity:

- `ERROR`: Only critical errors
- `WARN`: Warnings and errors
- `INFO`: General operational information (default)
- `DEBUG`: Detailed debugging information
- `VERBOSE`: Very detailed trace-level logging

### 2. **What Gets Logged**

#### At INFO Level:

- Server startup and transport configuration
- Tool call completions with execution time
- Success/failure status of operations
- Record counts for data operations
- Connection establishments

#### At DEBUG Level:

- Tool name and sanitized arguments for every call
- Salesforce API operation details
- Authentication method and configuration
- Connection establishment details

#### At VERBOSE Level:

- Full request/response data (truncated for safety)
- HTTP request details with session IDs
- CLI command output
- Detailed execution traces

#### At ERROR Level:

- All errors with full stack traces
- Tool failure details with timing
- Connection errors
- API errors

### 3. **Automatic Features**

- **Timestamp Support**: ISO 8601 timestamps on all log entries (configurable)
- **Sensitive Data Redaction**: Automatically hides passwords, tokens, secrets, API keys
- **Data Truncation**: Large payloads are automatically truncated to prevent log overflow
- **JSON Pretty-Printing**: Objects are formatted for easy reading
- **stderr Output**: All logs go to stderr to avoid interfering with MCP protocol

## Configuration

### Environment Variables

```bash
# Set log level (default: INFO)
MCP_LOG_LEVEL=DEBUG

# Enable/disable timestamps (default: true)
MCP_LOG_TIMESTAMPS=true
```

### In .env File (for development)

```bash
# MCP Server Logging Configuration
MCP_LOG_LEVEL=DEBUG
MCP_LOG_TIMESTAMPS=true
```

## Example Log Output

### Server Startup (INFO Level)

```
[2025-10-16T10:30:15.123Z] [INFO] Starting Salesforce MCP Server with streamable-http transport...
[2025-10-16T10:30:15.125Z] [INFO] Salesforce MCP Server running on Streamable HTTP port 3000
[2025-10-16T10:30:15.126Z] [INFO] Connect to: http://localhost:3000/mcp
```

### Tool Call (DEBUG Level)

```
[2025-10-16T10:30:20.456Z] [INFO] Tool called: salesforce_query_records
[2025-10-16T10:30:20.457Z] [DEBUG] Tool arguments:
{
  "objectName": "Account",
  "fields": ["Name", "Industry", "AnnualRevenue"],
  "whereClause": "Industry = 'Technology'",
  "limit": 10
}
[2025-10-16T10:30:20.500Z] [DEBUG] Salesforce connection established
[2025-10-16T10:30:21.789Z] [INFO] Tool salesforce_query_records completed in 1333ms [SUCCESS]
```

### Authentication (DEBUG Level)

```
[2025-10-16T10:30:20.460Z] [DEBUG] Salesforce API: OAuth 2.0 Client Credentials authentication
{
  "instanceUrl": "https://orgfarm-90b903facf-dev-ed.develop.my.salesforce.com"
}
[2025-10-16T10:30:20.495Z] [DEBUG] OAuth token received successfully
```

### Error Handling (ERROR Level)

```
[2025-10-16T10:30:25.123Z] [ERROR] Tool salesforce_query_records failed after 145ms: INVALID_FIELD: No such column 'InvalidField__c' on entity 'Account'
[2025-10-16T10:30:25.124Z] [VERBOSE] Error details: {
  "errorCode": "INVALID_FIELD",
  "message": "No such column 'InvalidField__c' on entity 'Account'"
}
```

## Finding Log Files

### When Running Locally

Logs are output to the terminal's stderr stream. You can redirect them:

```bash
# Save logs to a file
node dist/index.js 2> mcp-server.log

# Save logs and also see them in terminal
node dist/index.js 2>&1 | tee mcp-server.log
```

## Debugging Tips

### 1. **Start with INFO Level**

For normal operations, INFO level gives you a good overview without overwhelming detail.

### 2. **Use DEBUG for Troubleshooting**

When something isn't working, switch to DEBUG to see tool arguments and Salesforce API calls.

### 3. **Use VERBOSE for Deep Dives**

Only use VERBOSE when you need to see the full request/response cycle or trace execution flow.

### 4. **Check Tool Timing**

The completion logs show execution time - useful for identifying performance issues:

```
[INFO] Tool salesforce_query_records completed in 1333ms [SUCCESS]
```

### 5. **Look for Error Context**

Error logs include the tool name, timing, and full error details:

```
[ERROR] Tool salesforce_query_records failed after 145ms: <error message>
```

## Performance Impact

- **INFO**: Minimal impact (~1-2% overhead)
- **DEBUG**: Low impact (~3-5% overhead)
- **VERBOSE**: Moderate impact (~5-10% overhead)

The logger is optimized to avoid logging overhead when a level is disabled.

## Security Considerations

The logger automatically sanitizes sensitive data:

- Passwords
- Security tokens
- Client secrets
- API keys
- Access tokens

Sensitive fields are replaced with `***REDACTED***` in logs.

## Customization

The logger is implemented in `src/utils/logger.ts` and can be extended with additional methods or customized for specific needs.

### Helper Methods Available

```typescript
logger.error(message, error); // Log errors
logger.warn(message, data); // Log warnings
logger.info(message, data); // Log info
logger.debug(message, data); // Log debug info
logger.verbose(message, data); // Log verbose traces

// Specialized helpers
logger.toolCall(toolName, args); // Log tool invocations
logger.toolResult(toolName, duration, success); // Log tool completions
logger.salesforceCall(operation, details); // Log SF API calls
logger.truncate(data, maxLength); // Truncate large data
```

## Troubleshooting

### Logs Not Appearing?

1. Check that `MCP_LOG_LEVEL` is set (default is INFO)
2. Make sure you're looking at stderr output
3. Verify the server is actually running

### Too Much Log Output?

1. Lower the log level: `MCP_LOG_LEVEL=WARN` or `MCP_LOG_LEVEL=ERROR`
2. Disable timestamps: `MCP_LOG_TIMESTAMPS=false`
3. Use log file rotation for long-running servers

### Sensitive Data in Logs?

The logger automatically redacts known sensitive fields, but if you find sensitive data:

1. Report it as a security issue
2. Add the field name to the `sensitiveKeys` array in `logger.ts`

---

**Last Updated**: October 16, 2025
