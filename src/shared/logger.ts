// ============================================================================
// Logger — singleton, shared across all modules
// ============================================================================

import { logging } from './config/index.js';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  VERBOSE = 4,
}

function parseLogLevel(level: string): LogLevel {
  switch (level) {
    case 'ERROR': return LogLevel.ERROR;
    case 'WARN': return LogLevel.WARN;
    case 'INFO': return LogLevel.INFO;
    case 'DEBUG': return LogLevel.DEBUG;
    case 'VERBOSE': return LogLevel.VERBOSE;
    default: return LogLevel.INFO;
  }
}

class Logger {
  private level: LogLevel;
  private enableTimestamps: boolean;

  constructor() {
    this.level = parseLogLevel(logging.level);
    this.enableTimestamps = logging.timestamps;
  }

  private ts(): string {
    return this.enableTimestamps ? `[${new Date().toISOString()}] ` : '';
  }

  private fmt(level: string, message: string, data?: unknown): string {
    let out = `${this.ts()}[${level}] ${message}`;
    if (data !== undefined) {
      if (typeof data === 'object') {
        try { out += '\n' + JSON.stringify(data, null, 2); } catch { out += '\n' + String(data); }
      } else {
        out += ' ' + String(data);
      }
    }
    return out;
  }

  error(message: string, data?: unknown) { if (this.level >= LogLevel.ERROR) console.error(this.fmt('ERROR', message, data)); }
  warn(message: string, data?: unknown) { if (this.level >= LogLevel.WARN) console.warn(this.fmt('WARN', message, data)); }
  info(message: string, data?: unknown) { if (this.level >= LogLevel.INFO) console.info(this.fmt('INFO', message, data)); }
  debug(message: string, data?: unknown) { if (this.level >= LogLevel.DEBUG) console.debug(this.fmt('DEBUG', message, data)); }
  verbose(message: string, data?: unknown) { if (this.level >= LogLevel.VERBOSE) console.log(this.fmt('VERBOSE', message, data)); }

  isVerbose(): boolean { return this.level >= LogLevel.VERBOSE; }

  toolCall(toolName: string, args: unknown) {
    this.info(`Tool called: ${toolName}`);
    this.debug('Tool arguments:', this.sanitizeArgs(args));
  }

  toolResult(toolName: string, duration: number, success: boolean, recordCount?: number) {
    const status = success ? 'SUCCESS' : 'FAILED';
    let message = `Tool ${toolName} completed in ${duration}ms [${status}]`;
    if (recordCount !== undefined) message += ` - ${recordCount} records`;
    this.info(message);
  }

  salesforceCall(operation: string, details?: unknown) { this.debug(`Salesforce API: ${operation}`, details); }

  maskToken(token: string): string {
    if (!token || token.length < 12) return '***MASKED***';
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  }

  sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...headers };
    if (sanitized['authorization']) {
      const raw = Array.isArray(sanitized['authorization']) ? sanitized['authorization'][0] : sanitized['authorization'];
      sanitized['authorization'] = typeof raw === 'string' && raw.startsWith('Bearer ')
        ? `Bearer ${this.maskToken(raw.slice(7))}` : '***REDACTED***';
    }
    return sanitized;
  }

  salesforceRequest(method: string, url: string, body?: unknown) {
    this.debug(`[SF API Request] ${method} ${url}`);
    if (body && this.level >= LogLevel.VERBOSE) this.verbose('Request body:', this.truncate(JSON.stringify(body), 1000));
  }

  salesforceResponse(method: string, url: string, statusCode: number, body?: unknown, duration?: number) {
    const dur = duration ? ` (${duration}ms)` : '';
    this.debug(`[SF API Response] ${method} ${url} - ${statusCode}${dur}`);
    if (body && this.level >= LogLevel.VERBOSE) this.verbose('Response body:', this.truncate(JSON.stringify(body), 1000));
  }

  soqlQuery(query: string) { this.debug(`[SOQL] ${query}`); }
  soqlResult(_query: string, recordCount: number, duration?: number) {
    const dur = duration ? ` in ${duration}ms` : '';
    this.debug(`[SOQL Result] ${recordCount} records${dur}`);
  }

  httpRequest(method: string, path: string, ip: string, userAgent?: string, sessionId?: string | string[], headers?: unknown, body?: unknown) {
    const sessionPart = sessionId ? ` [Session: ${sessionId}]` : '';
    const agentPart = userAgent ? ` | UA: ${userAgent}` : '';
    const mcpMethod = (path === '/mcp' && body && typeof body === 'object' && 'method' in body) ? ` (${String((body as any).method)})` : '';
    this.info(`[HTTP] ${method} ${path}${mcpMethod} from ${ip}${sessionPart}${agentPart}`);
    if (headers && this.level >= LogLevel.VERBOSE) this.verbose(`[HTTP] Request headers: ${JSON.stringify(this.sanitizeHeaders(headers as any))}`);
    if (body !== undefined && this.level >= LogLevel.VERBOSE) this.verbose(`[HTTP] Request body: ${this.truncate(typeof body === 'string' ? body : JSON.stringify(body), 1000)}`);
  }

  httpResponse(method: string, path: string, statusCode: number, duration: number, responseHeaders?: unknown, responseBody?: string) {
    this.debug(`[HTTP] ${method} ${path} → ${statusCode} (${duration}ms)`);
    if (responseHeaders && this.level >= LogLevel.VERBOSE) this.verbose(`[HTTP] Response headers: ${JSON.stringify(responseHeaders)}`);
    if (responseBody !== undefined && this.level >= LogLevel.VERBOSE) this.verbose(`[HTTP] Response body: ${this.truncate(responseBody, 500)}`);
  }

  auditLog(event: string, userId?: string, details?: Record<string, unknown>) {
    const userPart = userId ? ` user=${userId}` : '';
    this.info(`[AUDIT] ${event}${userPart}`, details ? this.sanitizeArgs(details) : undefined);
  }

  private sanitizeArgs(args: unknown): unknown {
    if (!args || typeof args !== 'object') return args;
    const sanitized = { ...(args as Record<string, unknown>) };
    const sensitiveKeys = ['password', 'token', 'secret', 'apikey', 'clientsecret', 'refreshtoken', 'accesstoken', 'code'];
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) sanitized[key] = '***REDACTED***';
    }
    return sanitized;
  }

  truncate(data: string, maxLength = 500): string {
    if (data.length <= maxLength) return data;
    return data.substring(0, maxLength) + `... (truncated ${data.length - maxLength} chars)`;
  }
}

export const logger = new Logger();
