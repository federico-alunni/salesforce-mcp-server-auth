import express from "express";
import { serverUrl, oauthScopes, salesforceLoginUrl, oauthAliases, authServerMetadataCacheTTL } from "../../config.js";
import { logger } from "../../utils/logger.js";

// Cache for authorization server metadata fetched from Salesforce
let authServerMetadataCache: { data: unknown; fetchedAt: number } | null = null;

async function fetchAuthServerMetadata(): Promise<unknown> {
  const now = Date.now();
  if (authServerMetadataCache && (now - authServerMetadataCache.fetchedAt) < authServerMetadataCacheTTL) {
    return authServerMetadataCache.data;
  }
  const discoveryUrl = `${salesforceLoginUrl}/.well-known/openid-configuration`;
  logger.debug(`Fetching authorization server metadata from ${discoveryUrl}`);
  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(`Upstream metadata fetch failed: ${response.status} ${response.statusText}`);
  }
  const metadata = await response.json();
  authServerMetadataCache = { data: metadata, fetchedAt: now };
  return metadata;
}

const corsPreflight = (_req: express.Request, res: express.Response) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
};

const oauthMetadataHandler = (_req: express.Request, res: express.Response) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({
    resource: serverUrl,
    authorization_servers: [serverUrl],
    scopes_supported: oauthScopes.split(' '),
    bearer_methods_supported: ['header'],
  });
};

const authServerMetadataHandler = async (_req: express.Request, res: express.Response) => {
  try {
    const metadata = await fetchAuthServerMetadata() as Record<string, unknown>;
    // Salesforce supports PKCE S256 but may not advertise it in discovery metadata.
    // Patch the field so MCP clients (e.g. MCP Inspector) can verify compatibility.
    const existing = Array.isArray(metadata['code_challenge_methods_supported'])
      ? metadata['code_challenge_methods_supported'] as string[]
      : [];
    if (!existing.includes('S256')) {
      metadata['code_challenge_methods_supported'] = [...existing, 'S256'];
    }
    // Override token_endpoint to point to this server's proxy so browser-based
    // MCP clients are not blocked by Salesforce's missing CORS headers on the
    // real token endpoint.
    metadata['token_endpoint'] = `${serverUrl}/oauth/token`;
    res.set('Access-Control-Allow-Origin', '*');
    res.json(metadata);
  } catch (error) {
    logger.error('Failed to fetch authorization server metadata:', error);
    res.redirect(302, `${salesforceLoginUrl}/.well-known/openid-configuration`);
  }
};

const tokenProxyHandler = async (req: express.Request, res: express.Response) => {
  try {
    const salesforceTokenUrl = `${salesforceLoginUrl}/services/oauth2/token`;
    logger.debug(`Token proxy: forwarding POST to ${salesforceTokenUrl}`);

    // Forward all body params as-is (grant_type, code, redirect_uri, client_id, code_verifier, etc.)
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(req.body as Record<string, string>)) {
      if (typeof value === 'string') body.set(key, value);
    }

    const upstream = await fetch(salesforceTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const responseText = await upstream.text();
    logger.debug(`Token proxy: upstream responded ${upstream.status}`);

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(upstream.status).type('application/json').send(responseText);
  } catch (error) {
    logger.error('Token proxy error:', error);
    res.set('Access-Control-Allow-Origin', '*');
    res.status(502).json({ error: 'token_proxy_error', error_description: String(error) });
  }
};

export function registerOAuthRoutes(app: express.Application): void {
  // OAuth 2.0 Protected Resource Metadata (RFC 9728)
  app.options('/.well-known/oauth-protected-resource', corsPreflight);
  app.get('/.well-known/oauth-protected-resource', oauthMetadataHandler);

  // Configurable aliases (MCP_OAUTH_WELL_KNOWN_ALIASES)
  for (const alias of oauthAliases) {
    app.options(alias, corsPreflight);
    app.get(alias, oauthMetadataHandler);
    logger.debug(`OAuth metadata also served at: ${alias}`);
  }

  // Authorization Server Metadata (RFC 8414 / OpenID Connect discovery)
  app.options('/.well-known/oauth-authorization-server', corsPreflight);
  app.get('/.well-known/oauth-authorization-server', authServerMetadataHandler);
  app.options('/.well-known/oauth-authorization-server/mcp', corsPreflight);
  app.get('/.well-known/oauth-authorization-server/mcp', authServerMetadataHandler);
  app.options('/.well-known/openid-configuration', corsPreflight);
  app.get('/.well-known/openid-configuration', authServerMetadataHandler);

  // Token endpoint proxy — forwards browser token requests to Salesforce server-side
  // (Salesforce does not serve CORS headers on its token endpoint)
  app.options('/oauth/token', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).end();
  });
  app.post('/oauth/token', tokenProxyHandler);
}
