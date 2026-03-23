/**
 * Logger utility for MCP Server debugging
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  VERBOSE = 4
}

class Logger {
  private level: LogLevel;
  private enableTimestamps: boolean;

  constructor() {
    // Read log level from environment variable
    const envLevel = process.env.MCP_LOG_LEVEL?.toUpperCase();
    this.level = this.parseLogLevel(envLevel);
    this.enableTimestamps = process.env.MCP_LOG_TIMESTAMPS !== 'false';
  }

  private parseLogLevel(level?: string): LogLevel {
    switch (level) {
      case 'ERROR':
        return LogLevel.ERROR;
      case 'WARN':
        return LogLevel.WARN;
      case 'INFO':
        return LogLevel.INFO;
      case 'DEBUG':
        return LogLevel.DEBUG;
      case 'VERBOSE':
        return LogLevel.VERBOSE;
      default:
        return LogLevel.INFO; // Default to INFO
    }
  }

  private getTimestamp(): string {
    if (!this.enableTimestamps) return '';
    const now = new Date();
    return `[${now.toISOString()}] `;
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = this.getTimestamp();
    let formatted = `${timestamp}[${level}] ${message}`;
    
    if (data !== undefined) {
      if (typeof data === 'object') {
        try {
          formatted += '\n' + JSON.stringify(data, null, 2);
        } catch (e) {
          formatted += '\n' + String(data);
        }
      } else {
        formatted += ' ' + String(data);
      }
    }
    
    return formatted;
  }

  error(message: string, error?: any): void {
    if (this.level >= LogLevel.ERROR) {
      console.error(this.formatMessage('ERROR', message, error));
    }
  }

  warn(message: string, data?: any): void {
    if (this.level >= LogLevel.WARN) {
      console.warn(this.formatMessage('WARN', message, data));
    }
  }

  info(message: string, data?: any): void {
    if (this.level >= LogLevel.INFO) {
      console.info(this.formatMessage('INFO', message, data));
    }
  }

  debug(message: string, data?: any): void {
    if (this.level >= LogLevel.DEBUG) {
      console.debug(this.formatMessage('DEBUG', message, data));
    }
  }

  verbose(message: string, data?: any): void {
    if (this.level >= LogLevel.VERBOSE) {
      console.log(this.formatMessage('VERBOSE', message, data));
    }
  }

  // Helper method to log tool calls
  toolCall(toolName: string, args: any): void {
    this.info(`Tool called: ${toolName}`);
    this.debug('Tool arguments:', this.sanitizeArgs(args));
  }

  // Helper method to log tool results
  toolResult(toolName: string, duration: number, success: boolean, recordCount?: number): void {
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `Tool ${toolName} completed in ${duration}ms [${status}]`;
    if (recordCount !== undefined) {
      message += ` - ${recordCount} records`;
    }
    this.info(message);
  }

  // Helper method to log Salesforce API calls
  salesforceCall(operation: string, details?: any): void {
    this.debug(`Salesforce API: ${operation}`, details);
  }

  // Sanitize sensitive data from arguments
  private sanitizeArgs(args: any): any {
    if (!args || typeof args !== 'object') return args;
    
    const sanitized = { ...args };
    const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'clientSecret'];
    
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
        sanitized[key] = '***REDACTED***';
      }
    }
    
    return sanitized;
  }

  // Method to truncate large data for logging
  truncate(data: any, maxLength: number = 500): string {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + `... (truncated ${str.length - maxLength} chars)`;
  }

  // Mask access token for safe logging
  maskToken(token: string): string {
    if (!token || token.length < 12) return '***MASKED***';
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  }

  // Log Salesforce API request
  salesforceRequest(method: string, url: string, body?: any): void {
    this.debug(`[SF API Request] ${method} ${url}`);
    if (body && this.level >= LogLevel.VERBOSE) {
      this.verbose('Request body:', this.truncate(JSON.stringify(body), 1000));
    }
  }

  // Log Salesforce API response
  salesforceResponse(method: string, url: string, statusCode: number, body?: any, duration?: number): void {
    const durationStr = duration ? ` (${duration}ms)` : '';
    this.debug(`[SF API Response] ${method} ${url} - ${statusCode}${durationStr}`);
    if (body && this.level >= LogLevel.VERBOSE) {
      this.verbose('Response body:', this.truncate(JSON.stringify(body), 1000));
    }
  }

  // Log SOQL query
  soqlQuery(query: string): void {
    this.debug(`[SOQL] ${query}`);
  }

  // Log SOQL query result
  soqlResult(query: string, recordCount: number, duration?: number): void {
    const durationStr = duration ? ` in ${duration}ms` : '';
    this.debug(`[SOQL Result] ${recordCount} records${durationStr}`);
  }

  // Mask the value of the Authorization header so tokens never appear in logs
  private sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
    const sanitized = { ...headers };
    if (sanitized['authorization']) {
      const raw = Array.isArray(sanitized['authorization'])
        ? sanitized['authorization'][0]
        : sanitized['authorization'];
      if (raw && raw.startsWith('Bearer ')) {
        sanitized['authorization'] = `Bearer ${this.maskToken(raw.slice(7))}`;
      } else {
        sanitized['authorization'] = '***REDACTED***';
      }
    }
    return sanitized;
  }

  // Whether VERBOSE logging is active — used by middleware to decide body capture
  isVerbose(): boolean {
    return this.level >= LogLevel.VERBOSE;
  }

  // Log every HTTP request arriving at the Express server
  httpRequest(
    method: string,
    path: string,
    ip: string,
    userAgent?: string,
    sessionId?: string,
    headers?: Record<string, string | string[] | undefined>,
    body?: any
  ): void {
    const sessionPart = sessionId ? ` [Session: ${sessionId}]` : '';
    const agentPart = userAgent ? ` | UA: ${userAgent}` : '';
    // Extract JSON-RPC method for /mcp requests so the INFO line is self-descriptive
    const mcpMethod = (path === '/mcp' && body?.method) ? ` (${String(body.method)})` : '';
    this.info(`[MIDDLEWARE] ${method} ${path}${mcpMethod} from ${ip}${sessionPart}${agentPart}`);
    if (headers && this.level >= LogLevel.VERBOSE) {
      this.verbose(`[MIDDLEWARE] Request headers: ${JSON.stringify(this.sanitizeHeaders(headers))}`);
    }
    if (body !== undefined && this.level >= LogLevel.VERBOSE) {
      this.verbose(`[MIDDLEWARE] Request body: ${this.truncate(typeof body === 'string' ? body : JSON.stringify(body), 1000)}`);
    }
  }

  // Log every HTTP response (called from res.on('finish'))
  httpResponse(
    method: string,
    path: string,
    statusCode: number,
    duration: number,
    responseHeaders?: Record<string, number | string | string[] | undefined>,
    responseBody?: string
  ): void {
    this.debug(`[MIDDLEWARE] ${method} ${path} → ${statusCode} (${duration}ms)`);
    if (responseHeaders && this.level >= LogLevel.VERBOSE) {
      this.verbose(`[MIDDLEWARE] Response headers: ${JSON.stringify(responseHeaders)}`);
    }
    if (responseBody !== undefined && this.level >= LogLevel.VERBOSE) {
      this.verbose(`[MIDDLEWARE] Response body: ${this.truncate(responseBody, 500)}`);
    }
  }
}

// Export singleton instance
export const logger = new Logger();
