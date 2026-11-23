import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { jsx } from "hono/jsx";
import Provider, {
  errors,
  interactionPolicy,
  type AdapterFactory,
  type Configuration,
} from "oidc-provider";

import { ConsentPage } from "./consent-page.js";
import { identityHeaders } from "./policy.js";
import { OAuthUnavailable, oauthClockTolerance } from "./state.js";

const claudeClientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const claudeCallback = "https://claude.ai/api/mcp/auth_callback";
const codexClientId = "https://chatgpt.com/oauth/codex/client.json";
const codexCallbacks = ["http://127.0.0.1/callback", "http://localhost/callback"];

const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const claimNames = ["provider", "provider_user_id", "email", "name"] as const;
type Identity = Record<(typeof claimNames)[number], string>;
// Header-safe and unambiguous: percent-encode controls, non-ASCII and "%" itself.
const headerSafe = (value: string) =>
  // Slice code points, not UTF-16 units: a split surrogate would make encodeURIComponent throw.
  Array.from(value.trim())
    .slice(0, 256)
    .map((char) => (/[\x20-\x24\x26-\x7e]/.test(char) ? char : encodeURIComponent(char)))
    .join("");
function gatewayIdentity(req: IncomingMessage): Identity | undefined {
  // Node reads header bytes as Latin-1; ngrok sends UTF-8.
  const [provider, id, email, name] = identityHeaders.map((header) => {
    const value = req.headers[header];
    return typeof value === "string" ? headerSafe(Buffer.from(value, "latin1").toString()) : "";
  });
  if (!provider || !(id || email)) return undefined;
  return { provider, provider_user_id: id || email, email, name };
}
// Grants keep only an account ID, so it carries the identity for refreshed tokens.
const accountId = (identity: Identity) =>
  Buffer.from(JSON.stringify(claimNames.map((claim) => identity[claim]))).toString("base64url");
function identityOf(id: unknown): Identity | undefined {
  try {
    const values: unknown = JSON.parse(Buffer.from(String(id), "base64url").toString());
    if (
      Array.isArray(values) &&
      values.length === claimNames.length &&
      values.every((value) => typeof value === "string")
    )
      return Object.fromEntries(claimNames.map((claim, i) => [claim, values[i]])) as Identity;
  } catch {}
  return undefined;
}

export interface IssuerOptions {
  issuer: string;
  gatewaySecret: string;
  jwks: NonNullable<Configuration["jwks"]>;
  adapter?: AdapterFactory;
  cookieKey?: string;
  claudeCimd?: boolean;
  mcpServerName?: string;
  mcpServerIcon?: URL;
  resource?: string;
}

export function createIssuer({
  issuer,
  gatewaySecret,
  jwks,
  adapter,
  cookieKey = randomBytes(32).toString("base64url"),
  claudeCimd = false,
  mcpServerName,
  mcpServerIcon,
  resource = `${new URL(issuer).origin}/mcp`,
}: IssuerOptions) {
  const base = new URL(issuer);
  if (
    base.href !== `${base.origin}/` ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
  ) {
    throw new Error("Issuer must be an HTTPS origin (HTTP loopback is allowed for tests).");
  }
  if (typeof gatewaySecret !== "string" || gatewaySecret.length < 32)
    throw new Error("A gateway secret of at least 32 characters is required.");
  const target = new URL(resource);
  if (
    (target.protocol !== "https:" &&
      !(
        target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
      )) ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error("Resource must be an HTTPS URL (HTTP loopback is allowed for tests).");
  }
  resource = target.href;
  const iconSource = mcpServerIcon?.protocol === "https:" ? mcpServerIcon.origin : "data:";
  const securityHeaders = (callbackOrigin = "") => ({
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    // Browser form redirects must reach this already-validated client callback.
    "Content-Security-Policy": `default-src 'none'; style-src 'self';${callbackOrigin ? ` img-src ${iconSource};` : ""} form-action 'self' ${callbackOrigin}; frame-ancestors 'none'`,
  });
  // Consent every time: a remembered grant would let /auth, which has no Google gate, skip the gated consent page.
  const policy = interactionPolicy.base();
  // Sign in every time too, so each grant uses the identity the gateway just verified.
  policy
    .get("login")!
    .checks.add(
      new interactionPolicy.Check("always_login", "login is required", (ctx) =>
        ctx.oidc.result?.login
          ? interactionPolicy.Check.NO_NEED_TO_PROMPT
          : interactionPolicy.Check.REQUEST_PROMPT,
      ),
    );
  policy
    .get("consent")!
    .checks.add(
      new interactionPolicy.Check("always_consent", "consent is required", (ctx) =>
        ctx.oidc.result?.consent
          ? interactionPolicy.Check.NO_NEED_TO_PROMPT
          : interactionPolicy.Check.REQUEST_PROMPT,
      ),
    );
  const provider = new Provider(base.origin, {
    jwks,
    adapter,
    clockTolerance: oauthClockTolerance,
    cookies: {
      keys: [cookieKey],
      short: { secure: base.protocol === "https:", sameSite: "lax" },
      long: { secure: base.protocol === "https:", sameSite: "lax" },
    },
    clients: [],
    clientAuthMethods: ["none"],
    clientDefaults: {
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // form_post would put the code in a page on this origin, readable by an APP_URL script.
      response_modes: ["query"],
      token_endpoint_auth_method: "none",
    },
    extraClientMetadata: {
      properties: ["client_name"],
      validator(ctx, _key, _value, metadata) {
        const publishedClaude =
          claudeCimd && ctx === undefined && metadata.client_id === claudeClientId;
        const publishedCodex =
          claudeCimd && ctx === undefined && metadata.client_id === codexClientId;
        // Public clients use loopback callbacks or documented hosted HTTPS callbacks.
        if (
          (metadata.application_type !== "native" && metadata.application_type !== "web") ||
          metadata.token_endpoint_auth_method !== "none" ||
          !Array.isArray(metadata.grant_types) ||
          // The library filters the extra grant in Claude's document after this validator runs.
          metadata.grant_types.some(
            (type) =>
              !["authorization_code", "refresh_token"].includes(type) &&
              !(publishedClaude && type === "urn:ietf:params:oauth:grant-type:jwt-bearer"),
          ) ||
          !Array.isArray(metadata.response_types) ||
          metadata.response_types.some((type) => type !== "code") ||
          (metadata.response_modes !== undefined &&
            JSON.stringify(metadata.response_modes) !== '["query"]')
        ) {
          throw new errors.InvalidClientMetadata(
            "Only public authorization-code clients are supported.",
          );
        }
        if (
          // Anonymous registrations are persisted, so keep each one small.
          Buffer.byteLength(JSON.stringify(metadata)) > 4096 ||
          !Array.isArray(metadata.redirect_uris) ||
          (publishedClaude &&
            (metadata.redirect_uris.length !== 1 ||
              metadata.redirect_uris[0] !== claudeCallback)) ||
          (publishedCodex &&
            (metadata.application_type !== "native" ||
              metadata.redirect_uris.some((uri) => !codexCallbacks.includes(uri)))) ||
          metadata.redirect_uris.some((value) => {
            const url = URL.parse(value);
            if (!url) return true;
            const loopback =
              url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
            const hosted =
              ((url.origin === "https://chatgpt.com" &&
                (url.pathname === "/connector_platform_oauth_redirect" ||
                  /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname))) ||
                (url.origin === "https://www.cursor.com" &&
                  url.pathname === "/agents/mcp/oauth/callback")) &&
              value === `${url.origin}${url.pathname}`;
            return (
              !(loopback || hosted || value === claudeCallback) ||
              url.username ||
              url.password ||
              url.hash
            );
          })
        )
          throw new errors.InvalidClientMetadata(
            "Use HTTP loopback or documented ChatGPT, Cursor, or Claude OAuth callbacks and metadata smaller than 4 KiB.",
          );
      },
    },
    responseTypes: ["code"],
    scopes: ["mcp:use"],
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      // On by default but unused here: ngrok ignores DPoP binding, and PAR and logout are not routed.
      dPoP: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      registration: { enabled: true, issueRegistrationAccessToken: false },
      clientIdMetadataDocument: {
        enabled: claudeCimd,
        ack: "draft-03",
        allowFetch: (_ctx, clientId) => clientId === claudeClientId || clientId === codexClientId,
      },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo(_ctx, target) {
          if (target !== resource) throw new errors.InvalidTarget();
          return {
            scope: "mcp:use",
            audience: resource,
            accessTokenFormat: "jwt",
            jwt: { sign: { alg: "RS256" } },
          };
        },
      },
    },
    interactions: { policy, url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    renderError(ctx, out) {
      ctx.set(securityHeaders());
      ctx.type = "text/plain; charset=utf-8";
      ctx.body = `${out.error_description ?? out.error}\nRestart authorization from your MCP client.`;
    },
    findAccount: (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    extraTokenClaims: (_ctx, token) =>
      Object.fromEntries(
        Object.entries(identityOf("accountId" in token ? token.accountId : undefined) ?? {}).filter(
          ([, value]) => value,
        ),
      ),
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    rotateRefreshToken: true,
    // Refresh tokens expire with the original grant, even after rotation or browser-session expiry.
    expiresWithSession: () => false,
    ttl: {
      // Access tokens are stateless JWTs, so keep them short; revoking the grant stops refresh.
      AccessToken: (ctx) => Math.min(60 * 60, ctx.oidc.entities.Grant!.remainingTTL),
      AuthorizationCode: 15 * 60,
      // Sign-in takes minutes; a short TTL keeps the in-memory interaction store small.
      Interaction: 60 * 60,
      Session: 7 * 24 * 60 * 60,
      Grant: 90 * 24 * 60 * 60,
      RefreshToken: (ctx) => ctx.oidc.entities.Grant!.remainingTTL,
    },
  });
  provider.proxy = true;
  provider.use(async (ctx, next) => {
    if (ctx.path === "/auth" && ctx.method === "GET" && !ctx.query.scope) {
      const query = new URLSearchParams(ctx.querystring);
      query.set("scope", "mcp:use");
      ctx.querystring = query.toString();
    }
    try {
      await next();
    } catch (error) {
      // oidc-provider saves the session again after its own error page, so outages can surface here.
      if (!(error instanceof OAuthUnavailable) || ctx.headerSent) throw error;
      ctx.status = error.statusCode;
      ctx.set(securityHeaders());
      ctx.type = "text/plain; charset=utf-8";
      ctx.body = error.error_description;
      return;
    }
    // oidc-provider hardcodes this list; every client here is restricted to query responses.
    const body = ctx.body as { response_modes_supported?: string[] } | undefined;
    if (ctx.path === "/.well-known/openid-configuration" && body?.response_modes_supported)
      body.response_modes_supported = ["query"];
  });
  const callback = provider.callback();
  const csrf = (uid: string) => createHmac("sha256", cookieKey).update(uid).digest("base64url");
  function reply(
    res: ServerResponse,
    status: number,
    message: string,
    type = "text/plain",
    callbackOrigin = "",
  ) {
    res.writeHead(status, {
      "Content-Type": `${type}; charset=utf-8`,
      ...securityHeaders(callbackOrigin),
    });
    res.end(message);
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const path = new URL(req.url ?? "/", base).pathname;
      if (!path.startsWith("/interaction/")) {
        if (path === "/.well-known/oauth-authorization-server")
          req.url = "/.well-known/openid-configuration";
        await callback(req, res);
        return;
      }
      const secret = req.headers["x-mcp-oauth-provider-secret"];
      if (typeof secret !== "string" || !equal(secret, gatewaySecret))
        return reply(res, 403, "Open this authorization page through the ngrok sign-in gateway.");
      if (req.method !== "GET" && req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return reply(res, 405, "Use GET or POST.");
      }
      const identity = gatewayIdentity(req);
      if (!identity) return reply(res, 403, "The sign-in gateway did not identify the user.");
      const account = accountId(identity);
      const interaction = await provider.interactionDetails(req, res);
      if (path !== `/interaction/${interaction.uid}`)
        return reply(res, 400, "Restart authorization.");
      // The gateway already authenticated the user; only consent needs a browser form.
      if (req.method === "GET" && interaction.prompt.name === "login") {
        // Switching accounts in one browser would otherwise make oidc-provider demand an unrouted logout.
        const previous = interaction.session?.accountId;
        if (previous && previous !== account && interaction.session?.uid) {
          const session = await provider.Session.findByUid(interaction.session.uid);
          if (session) {
            for (const key of ["accountId", "loginTs", "amr", "acr", "authorizations"] as const)
              delete session[key];
            await session.persist();
          }
          // interactionFinished rejects an interaction whose recorded account differs from the session's.
          delete (interaction.session as { accountId?: string }).accountId;
          await interaction.save(interaction.exp - Math.floor(Date.now() / 1000));
        }
        return await provider.interactionFinished(
          req,
          res,
          { login: { accountId: account, amr: ["ngrok"], remember: true } },
          { mergeWithLastSubmission: false },
        );
      }
      if (interaction.prompt.name !== "consent") return reply(res, 400, "Restart authorization.");
      if (interaction.session?.accountId !== account)
        return reply(res, 400, "The signed-in account changed. Restart authorization.");
      if (req.method === "GET") {
        const client = await provider.Client.find(String(interaction.params.client_id));
        const name = client?.metadata().client_name;
        const { client_id: clientId, redirect_uri: redirectUri } = interaction.params;
        if (typeof clientId !== "string" || typeof redirectUri !== "string")
          return reply(res, 400, "Restart authorization.");
        const clientName = typeof name === "string" && name.trim() ? name : "MCP client";
        return reply(
          res,
          200,
          `<!doctype html>${jsx(ConsentPage, {
            serverName: mcpServerName,
            icon: mcpServerIcon,
            clientName,
            clientId,
            resource,
            redirectUri,
            uid: interaction.uid,
            csrf: csrf(interaction.uid),
          })}`,
          "text/html",
          new URL(redirectUri).origin,
        );
      }
      if (
        req.headers.origin !== base.origin ||
        req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded"
      )
        return reply(res, 403, "Reload this page and submit its authorization form.");
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return reply(res, 413, "Authorization form is too large.");
        chunks.push(Buffer.from(chunk));
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (form.getAll("csrf").length !== 1 || !equal(form.get("csrf") ?? "", csrf(interaction.uid)))
        return reply(res, 403, "Authorization form expired. Restart authorization.");
      if (
        form.getAll("decision").length !== 1 ||
        !["allow", "deny"].includes(form.get("decision") ?? "")
      )
        return reply(res, 400, "Choose Authorize or Cancel.");
      if (form.get("decision") === "deny")
        return await provider.interactionFinished(
          req,
          res,
          { error: "access_denied", error_description: "The user denied access." },
          { mergeWithLastSubmission: false },
        );
      const grant = interaction.grantId
        ? await provider.Grant.find(interaction.grantId)
        : new provider.Grant({
            accountId: account,
            clientId: String(interaction.params.client_id),
          });
      if (!grant) return reply(res, 400, "Authorization expired. Restart authorization.");
      const { missingOIDCScope, missingOIDCClaims } = interaction.prompt.details;
      if (Array.isArray(missingOIDCScope)) grant.addOIDCScope(missingOIDCScope);
      if (Array.isArray(missingOIDCClaims)) grant.addOIDCClaims(missingOIDCClaims);
      grant.addResourceScope(resource, "mcp:use");
      return await provider.interactionFinished(
        req,
        res,
        { consent: { grantId: await grant.save() } },
        { mergeWithLastSubmission: true },
      );
    } catch (error) {
      if (error instanceof OAuthUnavailable && !res.headersSent)
        return reply(res, error.statusCode, error.error_description);
      const status = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
      if (!res.headersSent)
        reply(
          res,
          typeof status === "number" && status < 500 ? status : 400,
          "Authorization request failed. Restart authorization.",
        );
      else if (!res.writableEnded) res.end();
    }
  }
  return { provider, handle };
}
