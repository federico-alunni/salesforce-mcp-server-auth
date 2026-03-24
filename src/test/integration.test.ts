// ============================================================================
// Tests — Integration: Express app, auth middleware, tool access
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

process.env.MCP_JWT_SECRET = 'integration-test-secret-key-32chars-long-enough-x';
process.env.MCP_AUTH_MODE = 'local';
process.env.MCP_SERVER_URL = 'http://localhost:0';
process.env.MCP_LOG_LEVEL = 'ERROR';
process.env.MCP_DATA_DIR = '.data/test-int-' + Date.now();

function request(server: http.Server, method: string, path: string, headers?: Record<string, string>, body?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, method, path,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Integration — Local Auth Mode', async () => {
  const { createApp } = await import('../shared/http/express-app.js');
  const { tokenService } = await import('../modules/mcp-auth/services/token-service.js');
  const { getOrCreateUser } = await import('../modules/mcp-auth/services/user-service.js');

  let server: http.Server;
  let validToken: string;

  before(async () => {
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>(resolve => server.on('listening', resolve));
    const user = getOrCreateUser('integration-test-user');
    validToken = await tokenService.generateAccessToken(user.id, ['mcp:tools']);
  });

  after(() => { server.close(); });

  it('GET / should return server info with authMode=local', async () => {
    const res = await request(server, 'GET', '/');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.authMode, 'local');
  });

  it('GET /health should return healthy', async () => {
    const res = await request(server, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, 'healthy');
  });

  it('POST /mcp without auth should return 401', async () => {
    const res = await request(server, 'POST', '/mcp', {}, {});
    assert.equal(res.status, 401);
  });

  it('POST /mcp with invalid token should return 401', async () => {
    const res = await request(server, 'POST', '/mcp', { Authorization: 'Bearer invalid' }, {});
    assert.equal(res.status, 401);
  });

  it('POST /mcp with valid token + initialize should succeed', async () => {
    const res = await request(server, 'POST', '/mcp', { Authorization: `Bearer ${validToken}`, Accept: 'application/json, text/event-stream' }, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });
    assert.equal(res.status, 200);
  });

  it('GET /.well-known/oauth-protected-resource should return metadata', async () => {
    const res = await request(server, 'GET', '/.well-known/oauth-protected-resource');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.authorization_servers);
  });

  it('GET /.well-known/oauth-authorization-server should return auth metadata', async () => {
    const res = await request(server, 'GET', '/.well-known/oauth-authorization-server');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.authorization_endpoint);
    assert.ok(json.token_endpoint);
    assert.ok(json.code_challenge_methods_supported.includes('S256'));
  });

  it('GET /oauth/authorize should redirect to Salesforce login', async () => {
    const res = await request(server, 'GET', '/oauth/authorize?client_id=test&redirect_uri=http://localhost/cb&response_type=code&code_challenge=abc&code_challenge_method=S256');
    assert.equal(res.status, 302);
    assert.ok(res.headers['location']?.includes('salesforce.com') || res.headers['location']?.includes('oauth2/authorize'));
  });

  it('GET /salesforce/status without auth should return 401', async () => {
    const res = await request(server, 'GET', '/salesforce/status');
    assert.equal(res.status, 401);
  });

  it('GET /salesforce/status with auth should show not connected', async () => {
    const res = await request(server, 'GET', '/salesforce/status', { Authorization: `Bearer ${validToken}` });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).connected, false);
  });

  it('tool call without SF connection returns clear error', async () => {
    // Initialize session
    const initRes = await request(server, 'POST', '/mcp', { Authorization: `Bearer ${validToken}`, Accept: 'application/json, text/event-stream' }, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });
    const sessionId = initRes.headers['mcp-session-id'] as string;
    assert.ok(sessionId);

    // Send initialized notification
    await request(server, 'POST', '/mcp', {
      Authorization: `Bearer ${validToken}`, 'Mcp-Session-Id': sessionId, Accept: 'application/json, text/event-stream',
    }, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // Tool call
    const toolRes = await request(server, 'POST', '/mcp', {
      Authorization: `Bearer ${validToken}`, 'Mcp-Session-Id': sessionId, Accept: 'application/json, text/event-stream',
    }, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'salesforce_search_objects', arguments: { searchPattern: 'Account' } },
    });

    assert.equal(toolRes.status, 200);
    assert.ok(
      toolRes.body.includes('not connected') || toolRes.body.includes('Salesforce account not connected'),
      `Should indicate SF not connected: ${toolRes.body.slice(0, 300)}`
    );
  });
});

describe('Integration — 404', async () => {
  const { createApp } = await import('../shared/http/express-app.js');
  let server: http.Server;

  before(async () => {
    server = createApp().listen(0);
    await new Promise<void>(resolve => server.on('listening', resolve));
  });
  after(() => { server.close(); });

  it('unknown route returns 404', async () => {
    const res = await request(server, 'GET', '/nonexistent');
    assert.equal(res.status, 404);
  });
});
