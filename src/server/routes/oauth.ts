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
    authorization_servers: [salesforceLoginUrl],
    scopes_supported: oauthScopes.split(' '),
    bearer_methods_supported: ['header'],
  });
};

const authServerMetadataHandler = async (_req: express.Request, res: express.Response) => {
  try {
    const metadata = await fetchAuthServerMetadata();
    res.set('Access-Control-Allow-Origin', '*');
    res.json(metadata);
  } catch (error) {
    logger.error('Failed to fetch authorization server metadata:', error);
    res.redirect(302, `${salesforceLoginUrl}/.well-known/openid-configuration`);
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
}
