// ============================================================================
// Module A — OAuth 2.0 endpoints for local MCP authentication
//
// Implements:
//   GET  /.well-known/oauth-protected-resource   → resource metadata (RFC 9728)
//   GET  /.well-known/oauth-authorization-server  → authorization server metadata
//   POST /register                                → dynamic client registration (RFC 7591)
//   GET  /authorize  (alias: /oauth/authorize)   → redirect to Salesforce login
//   POST /token      (alias: /oauth/token)       → token exchange
// ============================================================================

import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'crypto';
import { serverUrl, mcpAuth } from '../../../shared/config/index.js';
import { logger } from '../../../shared/logger.js';
import { redeemAuthorizationCode } from '../services/auth-code-service.js';
import { tokenService } from '../services/token-service.js';
import { initiateSalesforceLoginForMcp } from '../../salesforce-connection/services/connection-service.js';

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
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      scopes_supported: mcpAuth.oauthScopes.split(' '),
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
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

    const resolvedAuthMethod = token_endpoint_auth_method ?? 'client_secret_post';
    const clientSecret = resolvedAuthMethod !== 'none' ? randomBytes(32).toString('hex') : undefined;

    const registrationResponse: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris,
      grant_types: grant_types ?? ['authorization_code'],
      response_types: response_types ?? ['code'],
      token_endpoint_auth_method: resolvedAuthMethod,
      client_name: client_name ?? clientId,
    };
    if (clientSecret) {
      registrationResponse.client_secret = clientSecret;
      registrationResponse.client_secret_expires_at = 0; // never expires
    }

    res.status(201).json(registrationResponse);
  });

  // -----------------------------------------------------------------------
  // GET /authorize — redirect to Salesforce login (combined MCP + SF auth)
  // The user authenticates once via Salesforce; the callback issues both
  // the SF connection tokens AND the MCP authorization code.
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

    if (!redirect_uri) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' });
      return;
    }

    if (mcpAuth.allowedClientIds[0] !== '*' && !mcpAuth.allowedClientIds.includes(client_id)) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }

    logger.info(`MCP authorize → redirecting to Salesforce login for client=${client_id}`);

    const sfAuthUrl = initiateSalesforceLoginForMcp({
      clientId: client_id,
      mcpRedirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || 'S256',
      scope: scope || mcpAuth.oauthScopes,
      originalMcpState: state || '',
    });

    res.redirect(302, sfAuthUrl);
  };

  // -----------------------------------------------------------------------
  // POST /token — exchange code for access token
  // -----------------------------------------------------------------------
  const handleToken = async (req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    const { grant_type, code, client_id, redirect_uri, code_verifier, refresh_token } = req.body;

    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
        return;
      }
      const session = await tokenService.validateRefreshToken(refresh_token);
      if (!session) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' });
        return;
      }
      const { mcpAuth: cfg } = await import('../../../shared/config/index.js');
      const accessToken = await tokenService.generateAccessToken(session.userId, session.scopes);
      const newRefreshToken = await tokenService.generateRefreshToken(session.userId, session.scopes);
      logger.auditLog('mcp_token_refreshed', session.userId, {});
      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: cfg.accessTokenTTL,
        refresh_token: newRefreshToken,
        scope: session.scopes.join(' '),
      });
      return;
    }

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

    const { mcpAuth: cfg } = await import('../../../shared/config/index.js');
    const accessToken = await tokenService.generateAccessToken(record.userId, record.scopes);
    const newRefreshToken = await tokenService.generateRefreshToken(record.userId, record.scopes);
    logger.auditLog('mcp_token_issued', record.userId, { clientId: client_id });

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: cfg.accessTokenTTL,
      refresh_token: newRefreshToken,
      scope: record.scopes.join(' '),
    });
  };

  // Register on both /authorize and /oauth/authorize, /token and /oauth/token
  router.get('/authorize', handleAuthorizeGet);
  router.get('/oauth/authorize', handleAuthorizeGet);
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
