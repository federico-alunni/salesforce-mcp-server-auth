// ============================================================================
// Module A — OAuth 2.0 endpoints for local MCP authentication
//
// Implements:
//   GET  /.well-known/oauth-protected-resource   → resource metadata (RFC 9728)
//   GET  /.well-known/oauth-authorization-server  → authorization server metadata
//   POST /register                                → dynamic client registration (RFC 7591)
//   GET  /authorize  (alias: /oauth/authorize)   → authorization endpoint (shows login)
//   POST /authorize  (alias: /oauth/authorize)   → login form submission
//   POST /token      (alias: /oauth/token)       → token exchange
// ============================================================================

import { Router, type Request, type Response } from 'express';
import { serverUrl, mcpAuth } from '../../../shared/config/index.js';
import { logger } from '../../../shared/logger.js';
import { getOrCreateUser } from '../services/user-service.js';
import { generateAuthorizationCode, redeemAuthorizationCode } from '../services/auth-code-service.js';
import { tokenService } from '../services/token-service.js';

export function createLocalOAuthRoutes(): Router {
  const router = Router();

  // -----------------------------------------------------------------------
  // RFC 9728 — Protected Resource Metadata
  // -----------------------------------------------------------------------
  const resourceMetadata = (_req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({
      resource: serverUrl,
      authorization_servers: [serverUrl],
      scopes_supported: mcpAuth.oauthScopes.split(' '),
      bearer_methods_supported: ['header'],
    });
  };

  router.get('/.well-known/oauth-protected-resource', resourceMetadata);
  router.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

  // -----------------------------------------------------------------------
  // Authorization Server Metadata (RFC 8414)
  // -----------------------------------------------------------------------
  const authServerMetadata = (_req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({
      issuer: serverUrl,
      authorization_endpoint: `${serverUrl}/authorize`,
      token_endpoint: `${serverUrl}/token`,
      registration_endpoint: `${serverUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256', 'plain'],
      scopes_supported: mcpAuth.oauthScopes.split(' '),
      token_endpoint_auth_methods_supported: ['none'],
    });
  };

  router.get('/.well-known/oauth-authorization-server', authServerMetadata);
  router.get('/.well-known/oauth-authorization-server/mcp', authServerMetadata);
  router.get('/.well-known/openid-configuration', authServerMetadata);

  // -----------------------------------------------------------------------
  // POST /register — Dynamic Client Registration (RFC 7591)
  // -----------------------------------------------------------------------
  router.post('/register', (req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    const { redirect_uris, client_name, grant_types, response_types, token_endpoint_auth_method } = req.body ?? {};

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
      return;
    }

    const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    logger.info(`Dynamic client registered: ${clientId} (${client_name ?? 'unnamed'})`);

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris,
      grant_types: grant_types ?? ['authorization_code'],
      response_types: response_types ?? ['code'],
      token_endpoint_auth_method: token_endpoint_auth_method ?? 'none',
      client_name: client_name ?? clientId,
    });
  });

  // -----------------------------------------------------------------------
  // GET /authorize — show login page
  // -----------------------------------------------------------------------
  const handleAuthorizeGet = (req: Request, res: Response) => {
    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, scope, state } = req.query as Record<string, string>;

    if (response_type !== 'code') {
      res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only "code" is supported' });
      return;
    }

    if (!code_challenge) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge is required (PKCE)' });
      return;
    }

    if (mcpAuth.allowedClientIds[0] !== '*' && !mcpAuth.allowedClientIds.includes(client_id)) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }

    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Server — Login</title>
<style>
  body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
  .card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:400px;width:100%}
  h2{margin-top:0;color:#333} label{display:block;margin:1rem 0 .3rem;font-weight:600;color:#555}
  input{width:100%;padding:.6rem;border:1px solid #ccc;border-radius:4px;font-size:1rem;box-sizing:border-box}
  button{margin-top:1.2rem;width:100%;padding:.7rem;background:#0066cc;color:#fff;border:none;border-radius:4px;font-size:1rem;cursor:pointer}
  button:hover{background:#0052a3} .info{font-size:.85rem;color:#777;margin-top:1rem}
</style></head><body>
<div class="card">
  <h2>MCP Server Login</h2>
  <p>Authenticate to connect your MCP client.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(client_id || '')}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri || '')}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge || '')}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method || 'S256')}">
    <input type="hidden" name="scope" value="${escapeHtml(scope || mcpAuth.oauthScopes)}">
    <input type="hidden" name="state" value="${escapeHtml(state || '')}">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" required autofocus placeholder="Enter your name or identifier">
    <button type="submit">Authorize</button>
  </form>
  <p class="info">Client: ${escapeHtml(client_id || 'unknown')}</p>
</div></body></html>`);
  };

  // -----------------------------------------------------------------------
  // POST /authorize — process login, issue authorization code
  // -----------------------------------------------------------------------
  const handleAuthorizePost = (req: Request, res: Response) => {
    const { username, client_id, redirect_uri, code_challenge, code_challenge_method, scope, state } = req.body;

    if (!username || !client_id || !redirect_uri || !code_challenge) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
      return;
    }

    const user = getOrCreateUser(username);
    logger.auditLog('mcp_authorize', user.id, { clientId: client_id });

    const scopes = (scope || mcpAuth.oauthScopes).split(' ');
    const code = generateAuthorizationCode({
      userId: user.id,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || 'S256',
      scopes,
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    res.redirect(302, redirectUrl.toString());
  };

  // -----------------------------------------------------------------------
  // POST /token — exchange code for access token
  // -----------------------------------------------------------------------
  const handleToken = async (req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    const { grant_type, code, client_id, redirect_uri, code_verifier } = req.body;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    if (!code || !client_id || !redirect_uri || !code_verifier) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
      return;
    }

    const record = redeemAuthorizationCode(code, client_id, redirect_uri, code_verifier);
    if (!record) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
      return;
    }

    const accessToken = await tokenService.generateAccessToken(record.userId, record.scopes);
    logger.auditLog('mcp_token_issued', record.userId, { clientId: client_id });

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: (await import('../../../shared/config/index.js')).mcpAuth.accessTokenTTL,
      scope: record.scopes.join(' '),
    });
  };

  // Register on both /authorize and /oauth/authorize, /token and /oauth/token
  router.get('/authorize', handleAuthorizeGet);
  router.get('/oauth/authorize', handleAuthorizeGet);
  router.post('/authorize', handleAuthorizePost);
  router.post('/oauth/authorize', handleAuthorizePost);
  router.post('/token', handleToken);
  router.post('/oauth/token', handleToken);

  // CORS preflight
  router.options('/.well-known/oauth-protected-resource', corsPreflight);
  router.options('/.well-known/oauth-protected-resource/mcp', corsPreflight);
  router.options('/.well-known/oauth-authorization-server', corsPreflight);
  router.options('/.well-known/oauth-authorization-server/mcp', corsPreflight);
  router.options('/.well-known/openid-configuration', corsPreflight);
  router.options('/register', corsPreflight);
  router.options('/authorize', corsPreflight);
  router.options('/token', corsPreflight);
  router.options('/oauth/token', corsPreflight);

  return router;
}

function corsPreflight(_req: Request, res: Response) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(204).end();
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
