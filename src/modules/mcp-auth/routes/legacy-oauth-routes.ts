// ============================================================================
// Module A — Legacy OAuth routes (proxy to Salesforce)
// Used when MCP_AUTH_MODE=legacy for backward compatibility.
// Will be removed after full migration.
// ============================================================================

import { Router, type Request, type Response } from 'express';
import { serverUrl, legacy, salesforce } from '../../../shared/config/index.js';
import { logger } from '../../../shared/logger.js';

let authServerMetadataCache: { data: Record<string, unknown>; fetchedAt: number } | null = null;

async function fetchAuthServerMetadata(): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (authServerMetadataCache && (now - authServerMetadataCache.fetchedAt) < legacy.authServerMetadataCacheTTL) {
    return authServerMetadataCache.data;
  }

  const discoveryUrl = `${salesforce.loginUrl}/.well-known/openid-configuration`;
  logger.debug(`Fetching authorization server metadata from ${discoveryUrl}`);
  const response = await fetch(discoveryUrl);
  if (!response.ok) throw new Error(`Upstream metadata fetch failed: ${response.status} ${response.statusText}`);

  const metadata = await response.json() as Record<string, unknown>;
  authServerMetadataCache = { data: metadata, fetchedAt: now };
  return metadata;
}

export function createLegacyOAuthRoutes(): Router {
  const router = Router();

  const corsPreflight = (_req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
  };

  const oauthMetadataHandler = (_req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.json({
      resource: serverUrl,
      authorization_servers: [serverUrl],
      scopes_supported: legacy.oauthScopes.split(' '),
      bearer_methods_supported: ['header'],
    });
  };

  const authServerMetadataHandler = async (_req: Request, res: Response) => {
    try {
      const metadata = await fetchAuthServerMetadata();
      const existing = Array.isArray(metadata['code_challenge_methods_supported'])
        ? metadata['code_challenge_methods_supported'] as string[]
        : [];
      if (!existing.includes('S256')) {
        metadata['code_challenge_methods_supported'] = [...existing, 'S256'];
      }
      metadata['token_endpoint'] = `${serverUrl}/oauth/token`;

      res.set('Access-Control-Allow-Origin', '*');
      res.json(metadata);
    } catch (error) {
      logger.error('Failed to fetch authorization server metadata:', error);
      res.redirect(302, `${salesforce.loginUrl}/.well-known/openid-configuration`);
    }
  };

  const tokenProxyHandler = async (req: Request, res: Response) => {
    try {
      const salesforceTokenUrl = `${salesforce.loginUrl}/services/oauth2/token`;
      logger.debug(`Token proxy: forwarding POST to ${salesforceTokenUrl}`);

      let rawBody = req.rawBody ?? '';
      rawBody = rawBody.replace(/(code_verifier=)([^&]*)/i, (_m: string, prefix: string, value: string) =>
        prefix + value.replace(/%7E/gi, '~'));

      const upstream = await fetch(salesforceTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: rawBody,
      });

      const responseText = await upstream.text();
      logger.info(`Token proxy: upstream responded ${upstream.status}`);

      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(upstream.status).type('application/json').send(responseText);
    } catch (error) {
      logger.error('Token proxy error:', error);
      res.set('Access-Control-Allow-Origin', '*');
      res.status(502).json({ error: 'token_proxy_error', error_description: String(error) });
    }
  };

  // Routes
  router.options('/.well-known/oauth-protected-resource', corsPreflight);
  router.get('/.well-known/oauth-protected-resource', oauthMetadataHandler);

  for (const alias of legacy.oauthAliases) {
    router.options(alias, corsPreflight);
    router.get(alias, oauthMetadataHandler);
  }

  router.options('/.well-known/oauth-authorization-server', corsPreflight);
  router.get('/.well-known/oauth-authorization-server', authServerMetadataHandler);
  router.options('/.well-known/oauth-authorization-server/mcp', corsPreflight);
  router.get('/.well-known/oauth-authorization-server/mcp', authServerMetadataHandler);
  router.options('/.well-known/openid-configuration', corsPreflight);
  router.get('/.well-known/openid-configuration', authServerMetadataHandler);

  router.options('/oauth/token', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).end();
  });
  router.post('/oauth/token', tokenProxyHandler);

  return router;
}
