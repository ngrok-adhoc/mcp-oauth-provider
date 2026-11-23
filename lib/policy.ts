import type { AccessEntry } from "./config.js";

// Identity headers: set by the gateway for the issuer, then forwarded to the MCP upstream.
export const identityHeaders = [
  "x-mcp-user-provider",
  "x-mcp-user-id",
  "x-mcp-user-email",
  "x-mcp-user-name",
] as const;
// The validator replies with this line, then one line per identity header, in order.
const validBody = `^\\{"valid":true\\}(\\n[^\\n]*){${identityHeaders.length}}$`;
const provider = "google";

const json = (body: object, status_code = 200, headers: Record<string, string> = {}) => ({
  type: "custom-response",
  config: {
    status_code,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  },
});

export function createPolicy({
  issuer,
  mcpInternalUrl,
  validationUrl,
  gatewaySecret,
  users,
  stripMcpQuery,
  appInternalUrl,
  mcpUpstreamPath,
}: {
  issuer: string;
  mcpInternalUrl: string;
  validationUrl: string;
  gatewaySecret: string;
  users: AccessEntry[];
  stripMcpQuery?: boolean;
  appInternalUrl?: string;
  mcpUpstreamPath?: string;
}) {
  if (!Array.isArray(users) || !users.length) throw new Error("Set at least one entry in USERS.");
  const challenge = `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="mcp:use"`;
  const interaction = "req.url.path.startsWith('/interaction/')";
  const email = "actions.ngrok.oauth.identity.email";
  const matches = (entries: AccessEntry[]) =>
    entries
      .map((entry) =>
        typeof entry === "string"
          ? `${email}.lowerAscii() == ${JSON.stringify(entry)}`
          : `${email}.lowerAscii().matches(${JSON.stringify(entry.regex)})`,
      )
      .join(" || ");
  const hasEmail = `has(${email}) && ${email} != ''`;
  const allowedUser = `${hasEmail} && (${matches(users)})`;
  const body = "actions.ngrok.http_request.res.body";
  const validated = `req.url.path == '/mcp' && has(actions.ngrok.http_request.res) && actions.ngrok.http_request.res.status_code == 200 && ${body}.matches(${JSON.stringify(validBody)})`;
  const reserved = [
    "/mcp",
    "/mcp-debug",
    "/auth",
    "/token",
    "/reg",
    "/jwks",
    "/interaction",
    "/ngrok",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    mcpUpstreamPath,
  ]
    .filter((path): path is string => Boolean(path))
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // Leave ambiguous paths on the helper, where unknown routes return 404.
  const appPathBlocklist = `//|[\\\\%?#;\\x00-\\x1f\\x7f]|(?:^|/)\\.{1,2}(?:/|$)|^(?:${reserved})(?:/|$)`;
  return {
    on_http_request: [
      {
        actions: [
          {
            type: "remove-headers",
            config: { headers: ["x-mcp-oauth-provider-secret", ...identityHeaders] },
          },
        ],
      },
      {
        // Registration and authorization run before Google sign-in and write OAuth state.
        expressions: [
          "req.url.path == '/reg' || req.url.path == '/auth' || req.url.path.startsWith('/auth/')",
        ],
        actions: [
          {
            type: "rate-limit",
            config: {
              name: "OAuth registration and authorization",
              algorithm: "sliding_window",
              capacity: 30,
              rate: "60s",
              bucket_key: ["conn.client_ip"],
            },
          },
        ],
      },
      {
        expressions: [`${interaction} || req.url.path.startsWith('/ngrok/')`],
        actions: [{ type: "oauth", config: { provider } }],
      },
      {
        expressions: [`${interaction} && !(${allowedUser})`],
        actions: [
          json(
            {
              error: "user_required",
              message: "Sign in with a Google account permitted by USERS.",
            },
            403,
          ),
        ],
      },
      {
        expressions: [`${interaction} && (${allowedUser})`],
        actions: [
          { type: "remove-headers", config: { headers: ["authorization"] } },
          {
            type: "add-headers",
            config: {
              headers: {
                "x-mcp-user-provider": provider,
                "x-mcp-user-id": "${actions.ngrok.oauth.identity.provider_user_id}",
                "x-mcp-user-email": `\${${email}}`,
                "x-mcp-user-name": "${actions.ngrok.oauth.identity.name}",
                "x-mcp-oauth-provider-secret": gatewaySecret,
              },
            },
          },
        ],
      },
      {
        expressions: [
          "req.url.path in ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']",
        ],
        actions: [
          json({
            resource: `${issuer}/mcp`,
            authorization_servers: [issuer],
            scopes_supported: ["mcp:use"],
            bearer_methods_supported: ["header"],
          }),
        ],
      },
      {
        expressions: ["req.url.path.startsWith('/mcp/')"],
        actions: [
          json(
            {
              error: "mcp_path",
              message: "Connect your MCP client to /mcp without a trailing slash or extra path.",
            },
            404,
          ),
        ],
      },
      {
        expressions: ["req.url.path == '/mcp' && !hasReqHeader('authorization')"],
        actions: [json({ error: "OAuth required" }, 401, { "www-authenticate": challenge })],
      },
      {
        expressions: ["req.url.path == '/mcp'"],
        actions: [
          {
            type: "http-request",
            config: {
              url: validationUrl,
              method: "POST",
              headers: {
                authorization: "${getReqHeader('authorization')[0]}",
                "content-type": "application/json",
              },
              body: "{}",
              timeout: "30s",
              max_redirects: 0,
              on_error: "continue",
            },
          },
        ],
      },
      {
        expressions: [
          "req.url.path == '/mcp' && (!has(actions.ngrok.http_request.res) || actions.ngrok.http_request.res.status_code == 404 || actions.ngrok.http_request.res.status_code >= 500)",
        ],
        actions: [
          json(
            {
              error: "validation_unavailable",
              message:
                "The token validator is unavailable. Check the CLI terminal and restart MCP OAuth Provider.",
            },
            503,
          ),
        ],
      },
      {
        expressions: [
          `req.url.path == '/mcp' && actions.ngrok.http_request.res.status_code == 403 && actions.ngrok.http_request.res.body == '{"error":"insufficient_scope"}'`,
        ],
        actions: [json({ error: "insufficient_scope" }, 403, { "www-authenticate": challenge })],
      },
      {
        expressions: [
          "req.url.path == '/mcp' && actions.ngrok.http_request.res.status_code != 200",
        ],
        actions: [json({ error: "invalid_token" }, 401, { "www-authenticate": challenge })],
      },
      // Omit identity headers the provider did not supply, such as a missing name.
      ...identityHeaders.map((header, index) => ({
        expressions: [`${validated} && ${body}.split('\\n')[${index + 1}] != ''`],
        actions: [
          {
            type: "add-headers",
            config: { headers: { [header]: `\${${body}.split('\\n')[${index + 1}]}` } },
          },
        ],
      })),
      {
        expressions: [validated],
        actions: [
          { type: "remove-headers", config: { headers: ["authorization"] } },
          // The local proxy requires the gateway secret, so only this policy can reach it.
          ...(stripMcpQuery
            ? [{ type: "url-rewrite", config: { from: "^([^?]+)\\?.*$", to: "$1" } }]
            : [
                {
                  type: "add-headers",
                  config: { headers: { "x-mcp-oauth-provider-secret": gatewaySecret } },
                },
              ]),
          { type: "forward-internal", config: { url: mcpInternalUrl, on_error: "continue" } },
          json(
            {
              error: "mcp_unavailable",
              message:
                "The MCP connection is offline. Start your MCP server and check MCP_SERVER_URL in .env.",
            },
            503,
          ),
        ],
      },
      {
        expressions: ["req.url.path == '/mcp'"],
        actions: [json({ error: "invalid_token" }, 401, { "www-authenticate": challenge })],
      },
      ...(appInternalUrl && mcpUpstreamPath && mcpUpstreamPath !== "/"
        ? [
            {
              expressions: [
                `!req.url.raw_path.unescapeUrl().lower().matches(${JSON.stringify(appPathBlocklist)})`,
              ],
              actions: [
                { type: "forward-internal", config: { url: appInternalUrl, on_error: "continue" } },
                json(
                  {
                    error: "app_unavailable",
                    message: "Start the website configured in APP_URL and retry.",
                  },
                  503,
                ),
              ],
            },
          ]
        : []),
    ],
  };
}

// The outer policy converts ngrok's JWT failures into MCP's 401 challenge.
export function createValidationPolicy({ issuer, jwksUrl }: { issuer: string; jwksUrl: string }) {
  const challenge = `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="mcp:use"`;
  const payload = "actions.ngrok.jwt_validation.tokens[0].payload";
  return {
    on_http_request: [
      {
        actions: [
          {
            type: "jwt-validation",
            config: {
              issuer: { allow_list: [{ value: issuer }] },
              audience: { allow_list: [{ value: `${issuer}/mcp` }] },
              http: {
                tokens: [
                  {
                    type: "access_token",
                    method: "header",
                    name: "authorization",
                    prefix: "Bearer ",
                  },
                ],
              },
              jws: {
                allowed_algorithms: ["RS256"],
                keys: { sources: { additional_jkus: [jwksUrl] } },
              },
            },
          },
        ],
      },
      {
        expressions: [
          "(!('scope' in actions.ngrok.jwt_validation.tokens[0].payload) || !('mcp:use' in actions.ngrok.jwt_validation.tokens[0].payload.scope.split(' ')))",
        ],
        actions: [json({ error: "insufficient_scope" }, 403, { "www-authenticate": challenge })],
      },
      // ngrok exposes temporal JWT claims as Go-formatted UTC strings; parsing failures fall through to denial.
      {
        expressions: [
          "actions.ngrok.jwt_validation.tokens[0].verified && 'exp' in actions.ngrok.jwt_validation.tokens[0].payload && timestamp(actions.ngrok.jwt_validation.tokens[0].payload.exp.replace(' +0000 UTC','Z').replace(' ','T')) > timestamp(time.now) && (!('nbf' in actions.ngrok.jwt_validation.tokens[0].payload) || timestamp(actions.ngrok.jwt_validation.tokens[0].payload.nbf.replace(' +0000 UTC','Z').replace(' ','T')) <= timestamp(time.now))",
        ],
        actions: [
          {
            type: "custom-response",
            config: {
              status_code: 200,
              // The issuer writes header-safe claims, so no line can contain a newline.
              body: [
                '{"valid":true}',
                ...["provider", "provider_user_id", "email", "name"].map(
                  (claim) => `\${'${claim}' in ${payload} ? ${payload}.${claim} : ''}`,
                ),
              ].join("\n"),
              headers: { "content-type": "text/plain", "cache-control": "no-store" },
            },
          },
        ],
      },
      { actions: [json({ error: "invalid_token" }, 401)] },
    ],
  };
}
