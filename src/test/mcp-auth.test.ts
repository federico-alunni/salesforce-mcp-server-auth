// ============================================================================
// Tests — Module A: MCP Auth Layer
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'crypto';

// Env must be set before dynamic imports load the config
process.env.MCP_JWT_SECRET = 'test-secret-key-that-is-at-least-32-characters-long';
process.env.MCP_AUTH_MODE = 'local';
process.env.MCP_SERVER_URL = 'http://localhost:3000';
process.env.MCP_JWT_ISSUER = 'http://localhost:3000';
process.env.MCP_LOG_LEVEL = 'ERROR';
process.env.MCP_DATA_DIR = '.data/test-' + Date.now();

describe('Module A — MCP Auth', async () => {

  // Dynamic imports so env is set first
  const { tokenService } = await import('../modules/mcp-auth/services/token-service.js');
  const { getOrCreateUser, getUserById } = await import('../modules/mcp-auth/services/user-service.js');
  const { generateAuthorizationCode, redeemAuthorizationCode } = await import('../modules/mcp-auth/services/auth-code-service.js');

  describe('Token Service', () => {
    it('should generate and validate a local JWT', async () => {
      const token = await tokenService.generateAccessToken('user-123', ['mcp:tools']);
      assert.ok(token);
      assert.equal(token.split('.').length, 3);

      const principal = await tokenService.validateAccessToken(token);
      assert.ok(principal);
      assert.equal(principal!.userId, 'user-123');
      assert.deepEqual(principal!.scopes, ['mcp:tools']);
      assert.ok(principal!.sessionId);
    });

    it('should reject an invalid token', async () => {
      const principal = await tokenService.validateAccessToken('invalid.token.here');
      assert.equal(principal, null);
    });

    it('should reject a tampered token', async () => {
      const token = await tokenService.generateAccessToken('user-123', ['mcp:tools']);
      const tampered = token.slice(0, -5) + 'XXXXX';
      const principal = await tokenService.validateAccessToken(tampered);
      assert.equal(principal, null);
    });

    it('should reject an expired token', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: 'user-123', iss: 'http://localhost:3000', aud: 'http://localhost:3000',
        exp: 1000, jti: 'x', scope: 'mcp:tools'
      })).toString('base64url');
      const data = `${header}.${payload}`;
      const sig = createHmac('sha256', process.env.MCP_JWT_SECRET!).update(data).digest('base64url');
      const expiredToken = `${data}.${sig}`;

      const principal = await tokenService.validateAccessToken(expiredToken);
      assert.equal(principal, null);
    });
  });

  describe('User Service', () => {
    it('should create a new user', () => {
      const user = getOrCreateUser('test-user-' + Date.now());
      assert.ok(user.id);
      assert.ok(user.createdAt);
    });

    it('should return the same user on second call', () => {
      const name = 'idempotent-user-' + Date.now();
      const user1 = getOrCreateUser(name);
      const user2 = getOrCreateUser(name);
      assert.equal(user1.id, user2.id);
    });

    it('should find user by ID', () => {
      const user = getOrCreateUser('findable-user-' + Date.now());
      const found = getUserById(user.id);
      assert.ok(found);
      assert.equal(found!.id, user.id);
    });
  });

  describe('Authorization Code Service', () => {
    it('should generate and redeem an auth code with PKCE S256', () => {
      const codeVerifier = 'test-code-verifier-string-long-enough';
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

      const code = generateAuthorizationCode({
        userId: 'user-123', clientId: 'test-client', redirectUri: 'http://localhost:3000/callback',
        codeChallenge, codeChallengeMethod: 'S256', scopes: ['mcp:tools'],
      });
      assert.ok(code);

      const record = redeemAuthorizationCode(code, 'test-client', 'http://localhost:3000/callback', codeVerifier);
      assert.ok(record);
      assert.equal(record!.userId, 'user-123');
    });

    it('should reject code with wrong verifier', () => {
      const codeVerifier = 'correct-verifier';
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

      const code = generateAuthorizationCode({
        userId: 'user-123', clientId: 'test-client', redirectUri: 'http://localhost:3000/callback',
        codeChallenge, codeChallengeMethod: 'S256', scopes: ['mcp:tools'],
      });

      const record = redeemAuthorizationCode(code, 'test-client', 'http://localhost:3000/callback', 'wrong-verifier');
      assert.equal(record, null);
    });

    it('should reject code reuse (single use)', () => {
      const codeVerifier = 'verifier-for-single-use-test';
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

      const code = generateAuthorizationCode({
        userId: 'user-123', clientId: 'test-client', redirectUri: 'http://localhost:3000/callback',
        codeChallenge, codeChallengeMethod: 'S256', scopes: ['mcp:tools'],
      });

      assert.ok(redeemAuthorizationCode(code, 'test-client', 'http://localhost:3000/callback', codeVerifier));
      assert.equal(redeemAuthorizationCode(code, 'test-client', 'http://localhost:3000/callback', codeVerifier), null);
    });

    it('should reject code with wrong client_id', () => {
      const codeVerifier = 'verifier-client-test';
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

      const code = generateAuthorizationCode({
        userId: 'user-123', clientId: 'correct-client', redirectUri: 'http://localhost:3000/callback',
        codeChallenge, codeChallengeMethod: 'S256', scopes: ['mcp:tools'],
      });

      assert.equal(redeemAuthorizationCode(code, 'wrong-client', 'http://localhost:3000/callback', codeVerifier), null);
    });
  });
});
