import crypto from "crypto";
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
    resource: `${serverUrl}/mcp`,
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
    // Override authorization_endpoint so all authorize requests are routed
    // through this server's logging proxy before being forwarded to Salesforce.
    // This lets us capture code_challenge / code_challenge_method and
    // cross-check them against the code_verifier that arrives at /oauth/token.
    metadata['authorization_endpoint'] = `${serverUrl}/oauth/authorize`;
    res.set('Access-Control-Allow-Origin', '*');
    res.json(metadata);
  } catch (error) {
    logger.error('Failed to fetch authorization server metadata:', error);
    res.redirect(302, `${salesforceLoginUrl}/.well-known/openid-configuration`);
  }
};

/**
 * Proxy the authorize request to Salesforce after logging all PKCE parameters.
 * By overriding authorization_endpoint in the metadata we route through here so we can
 * capture code_challenge / code_challenge_method and cross-check against the verifier
 * that arrives later at the token endpoint.
 */
const authorizeProxyHandler = (req: express.Request, res: express.Response) => {
  const q = req.query as Record<string, string | undefined>;
  logger.info(
    `[OAUTH] Authorize request: client_id=${q['client_id']} ` +
    `response_type=${q['response_type']} ` +
    `code_challenge_method=${q['code_challenge_method']} ` +
    `code_challenge=${q['code_challenge']} ` +
    `state=${q['state']} ` +
    `redirect_uri=${q['redirect_uri']} ` +
    `resource=${q['resource'] ?? '(none)'}`
  );
  const sfAuthorizeUrl = `${salesforceLoginUrl}/services/oauth2/authorize`;
  const params = new URLSearchParams(req.query as Record<string, string>);
  res.redirect(302, `${sfAuthorizeUrl}?${params.toString()}`);
};

const tokenProxyHandler = async (req: express.Request, res: express.Response) => {
  try {
    const salesforceTokenUrl = `${salesforceLoginUrl}/services/oauth2/token`;
    logger.debug(`Token proxy: forwarding POST to ${salesforceTokenUrl}`);

    // The browser's URLSearchParams encodes '~' as '%7E' per WHATWG spec, but
    // Salesforce doesn't decode it back before PKCE verification, causing
    // "invalid code verifier". Fix: decode %7E→~ in code_verifier before forwarding.
    let rawBody: string = (req as any).rawBody ?? '';
    const rawBefore = rawBody.match(/(code_verifier=)([^&]*)/i)?.[2] ?? '(not found)';
    rawBody = rawBody.replace(
      /(code_verifier=)([^&]*)/i,
      (_match, prefix, value) => prefix + value.replace(/%7E/gi, '~')
    );
    const rawAfter = rawBody.match(/(code_verifier=)([^&]*)/i)?.[2] ?? '(not found)';
    // Compute the S256 challenge from the decoded verifier so we can cross-check
    // against the code_challenge logged in the authorize step.
    const decodedVerifier = decodeURIComponent(rawAfter);
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(decodedVerifier, 'ascii')
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    // Also compute challenge as-if the verifier had ~ URL-encoded as %7E,
    // to detect if the client computed the challenge from the encoded form.
    const urlEncodedVerifier = decodedVerifier.replace(/~/g, '%7E');
    const challengeFromEncoded = crypto
      .createHash('sha256')
      .update(urlEncodedVerifier, 'ascii')
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    logger.info(
      `Token proxy: code_verifier raw before=${rawBefore} after=${rawAfter} ` +
      `challenge_from_literal=${expectedChallenge} challenge_from_%7E_encoded=${challengeFromEncoded}`
    );

    // Log params for debugging using the parsed body (redact sensitive values)
    const debugParams: Record<string, string> = Object.fromEntries(
      Object.entries(req.body as Record<string, string>)
        .filter(([, v]) => typeof v === 'string')
        .map(([key, value]) => [key, (key === 'client_secret' || key === 'code') ? '***' : value])
    );
    logger.info(`Token proxy: forwarding params: ${JSON.stringify(debugParams)}`);

    const upstream = await fetch(salesforceTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: rawBody,
    });

    const responseText = await upstream.text();
    logger.info(`Token proxy: upstream responded ${upstream.status}: ${responseText.slice(0, 500)}`);

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

  // Authorize proxy — logs PKCE params then redirects to Salesforce
  app.get('/oauth/authorize', authorizeProxyHandler);

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
