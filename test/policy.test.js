import assert from "node:assert/strict";
import test from "node:test";
import { RE2JS } from "re2js";
import { createPolicy, createValidationPolicy, identityHeaders } from "../dist/lib/policy.js";

const settings = {
  issuer: "https://example.ngrok.app",
  mcpInternalUrl: "https://mcp.internal",
  validationUrl: "https://validator.internal",
  gatewaySecret: "private-per-run-secret",
  users: ["person@example.com"],
};
const expression = (rule) => (rule.expressions ?? []).join(" && ");
const withAction = (rules, type) =>
  rules.filter((rule) => rule.actions.some((action) => action.type === type));

test("only allowed Google accounts receive trusted helper access", () => {
  const adminEmail = 'owner"\\@example.com';
  const rules = createPolicy({ ...settings, users: [adminEmail] }).on_http_request;
  // Clients cannot supply the secret or identity headers.
  assert.deepEqual(rules[0].actions[0].config.headers, [
    "x-mcp-oauth-provider-secret",
    ...identityHeaders,
  ]);
  const google = withAction(rules, "oauth");
  assert.equal(google.length, 1);
  assert.match(expression(google[0]), /interaction/);
  assert.match(expression(google[0]), /ngrok/);
  const grants = withAction(rules, "add-headers").filter((rule) =>
    expression(rule).includes("interaction"),
  );
  assert.equal(grants.length, 1);
  assert.ok(
    expression(grants[0]).includes(`identity.email.lowerAscii() == ${JSON.stringify(adminEmail)}`),
  );
  assert.match(expression(grants[0]), /has\(actions.ngrok.oauth.identity.email\)/);
  const sent = grants[0].actions.at(-1).config.headers;
  assert.equal(sent["x-mcp-oauth-provider-secret"], settings.gatewaySecret);
  assert.equal(sent["x-mcp-user-provider"], "google");
  assert.equal(sent["x-mcp-user-id"], "${actions.ngrok.oauth.identity.provider_user_id}");
  assert.equal(sent["x-mcp-user-email"], "${actions.ngrok.oauth.identity.email}");
  assert.equal(sent["x-mcp-user-name"], "${actions.ngrok.oauth.identity.name}");
  assert.throws(() => createPolicy({ ...settings, users: [] }), /USERS/);
});

test("MCP forwarding requires an exact positive validator response and fails closed", () => {
  const rules = createPolicy(settings).on_http_request;
  const forwarding = withAction(rules, "forward-internal").find((rule) =>
    rule.actions.some((action) => action.config?.url === settings.mcpInternalUrl),
  );
  assert.match(expression(forwarding), /status_code == 200/);
  const validator = RE2JS.compile(
    JSON.parse(/body\.matches\(("(?:[^"\\]|\\.)*")\)/.exec(expression(forwarding))[1]),
  );
  assert.ok(validator.matches('{"valid":true}\ngoogle\n123\na@example.com\n'));
  assert.ok(!validator.matches('{"valid":true}'));
  assert.ok(!validator.matches('{"valid":true}\ngoogle\n123\na@example.com\nname\nextra'));
  assert.ok(!validator.matches('{"valid":false}\ngoogle\n123\na@example.com\n'));
  // Each identity header is added only when present, before forwarding.
  identityHeaders.forEach((header, index) => {
    const rule = rules[rules.indexOf(forwarding) - identityHeaders.length + index];
    assert.ok(expression(rule).startsWith(expression(forwarding)));
    assert.ok(expression(rule).endsWith(`split('\\n')[${index + 1}] != ''`));
    assert.equal(
      rule.actions[0].config.headers[header],
      `\${actions.ngrok.http_request.res.body.split('\\n')[${index + 1}]}`,
    );
  });
  const [limit, removeAuthorization] = forwarding.actions;
  assert.equal(limit.type, "rate-limit");
  assert.equal(limit.config.capacity, 60);
  assert.equal(limit.config.rate, "60s");
  assert.deepEqual(limit.config.bucket_key, [
    "actions.ngrok.http_request.res.body.split('\\n')[2] == '' ? 'ip:' + conn.client_ip : 'user:' + actions.ngrok.http_request.res.body.split('\\n')[2]",
  ]);
  assert.equal(removeAuthorization.type, "remove-headers");
  assert.deepEqual(removeAuthorization.config.headers, ["authorization"]);
  assert.equal(forwarding.actions.at(-2).config.on_error, "continue");
  assert.equal(forwarding.actions.at(-1).config.status_code, 503);
  assert.match(forwarding.actions.at(-1).config.body, /MCP_SERVER_URL/);
  const after = rules[rules.indexOf(forwarding) + 1];
  assert.equal(after.actions[0].config.status_code, 401);
  assert.match(after.actions[0].config.headers["www-authenticate"], /resource_metadata=/);
  const request = withAction(rules, "http-request")[0].actions[0];
  assert.equal(request.config.max_redirects, 0);
  assert.equal(request.config.on_error, "continue");
  assert.equal(
    rules.find((rule) => expression(rule).includes("!has(actions.ngrok.http_request.res)"))
      .actions[0].config.status_code,
    503,
  );
});

test("MCP-only configuration has no website forwarding rule", () => {
  const rules = createPolicy(settings).on_http_request;
  const forwarding = withAction(rules, "forward-internal");
  assert.equal(forwarding.length, 1);
  assert.equal(
    forwarding[0].actions.find((action) => action.type === "forward-internal").config.url,
    settings.mcpInternalUrl,
  );
  assert.equal(expression(forwarding[0]).startsWith("req.url.path == '/mcp' &&"), true);
  assert.ok(
    !rules.some(
      (rule) =>
        rule.expressions === undefined &&
        rule.actions.some((action) => action.type !== "remove-headers"),
    ),
  );
  assert.ok(!rules.some((rule) => expression(rule).includes("req.url.path == '/'")));
  const reserved = rules.filter((rule) =>
    rule.actions.some((action) => action.config?.status_code === 404),
  );
  assert.equal(reserved.length, 1);
  assert.equal(expression(reserved[0]), "req.url.path.startsWith('/mcp/')");
});

test("JWT validator positively requires verified audience, scope and parsed time", () => {
  const rules = createValidationPolicy({
    issuer: settings.issuer,
    jwksUrl: `${settings.issuer}/jwks?v=current`,
  }).on_http_request;
  const jwt = rules[0].actions[0].config;
  assert.equal(jwt.audience.allow_list[0].value, `${settings.issuer}/mcp`);
  assert.deepEqual(jwt.jws.allowed_algorithms, ["RS256"]);
  assert.equal(rules[1].actions[0].config.status_code, 403);
  const allow = rules.find((rule) =>
    rule.actions.some((action) => action.config?.body?.startsWith('{"valid":true}\n')),
  );
  const lines = allow.actions[0].config.body.split("\n");
  assert.equal(lines.length, identityHeaders.length + 1);
  assert.match(
    lines[3],
    /^\$\{'email' in actions\.ngrok\.jwt_validation\.tokens\[0\]\.payload \? .*\.email : ''\}$/,
  );
  assert.match(expression(allow), /tokens\[0\].verified/);
  assert.match(expression(allow), /'exp' in/);
  assert.match(expression(allow), /timestamp\(time.now\)/);
  assert.match(expression(allow), /payload.nbf/);
  assert.equal(rules.at(-1).actions[0].config.status_code, 401);
});

test("exact addresses and regexes can authorize MCP users", () => {
  const rules = createPolicy({
    ...settings,
    users: [
      ...settings.users,
      "guest@example.com",
      { regex: "\\A(?:[^@]+@ngrok\\.com|guest@example\\.org)\\z" },
    ],
  }).on_http_request;
  const grants = withAction(rules, "add-headers").filter((rule) =>
    expression(rule).includes("interaction"),
  );
  const denials = rules.filter((rule) =>
    rule.actions.some((action) => action.config?.status_code === 403),
  );
  const matches = (rule, path, email) =>
    Function(
      "req",
      "actions",
      "has",
      "matchesRegex",
      `return ${expression(rule)
        .replaceAll(
          "actions.ngrok.oauth.identity.email.lowerAscii().matches(",
          "matchesRegex(actions.ngrok.oauth.identity.email.toLowerCase(), ",
        )
        .replaceAll(".lowerAscii()", ".toLowerCase()")}`,
    )(
      { url: { path } },
      { ngrok: { oauth: { identity: email === undefined ? {} : { email } } } },
      (value) => value !== undefined,
      (value, pattern) => RE2JS.compile(pattern).matches(value),
    );
  for (const [path, email, allowed] of [
    ["/interaction/login", "alice@ngrok.com", true],
    ["/interaction/login", "guest@example.com", true],
    ["/interaction/login", "guest@example.org", true],
    ["/interaction/login", "other@example.com", false],
    ["/interaction/login", "guest@example.com.evil.com", false],
    ["/interaction/login", "guest@example.org.evil.com", false],
    ["/interaction/login", "alice@evilngrok.com", false],
    ["/interaction/login", "alice@ngrok.com.evil.com", false],
    ["/interaction/login", "alice@sub.ngrok.com", false],
    ["/interaction/login", "PERSON@Example.com", true],
    ["/interaction/login", undefined, false],
    ["/interaction/login", "", false],
  ]) {
    assert.equal(
      grants.some((rule) => matches(rule, path, email)),
      allowed,
      `${path}: ${email}`,
    );
    assert.equal(
      denials.some((rule) => matches(rule, path, email)),
      !allowed,
      `${path}: ${email}`,
    );
  }
  const forwarding = withAction(rules, "forward-internal")[0];
  assert.match(expression(forwarding), /status_code == 200/);
  assert.equal(rules[0].actions[0].type, "remove-headers");
});

test("website fallback preserves MCP and OAuth paths in Traffic Policy", () => {
  const appInternalUrl = "https://website.internal";
  const mcpUpstreamPath = "/private/mcp";
  const routing = (path) =>
    withAction(
      createPolicy({
        ...settings,
        appInternalUrl,
        mcpUpstreamPath: path,
      }).on_http_request,
      "forward-internal",
    );
  assert.equal(routing("/").length, 1);
  const website = routing(mcpUpstreamPath).at(-1);
  assert.equal(website.actions[0].config.url, appInternalUrl);
  const literal = /\.matches\((.*)\)$/.exec(expression(website))[1];
  const blocked = RE2JS.compile(JSON.parse(literal));
  for (const path of ["/", "/about", "/docs/my%20file", "/assets/main.css"])
    assert.equal(blocked.matcher(decodeURIComponent(path).toLowerCase()).find(), false, path);
  for (const path of [
    "/mcp",
    "/MCP/child",
    "/mcp-debug",
    "/auth",
    "/interaction/1",
    "/ngrok/callback",
    "/.well-known/oauth-authorization-server",
    "/private/mcp",
    "/%70rivate/mcp",
    "/private/%2fmcp",
    "/private%5cmcp",
    "/somewhere/../private/mcp",
  ]) {
    assert.equal(blocked.matcher(decodeURIComponent(path).toLowerCase()).find(), true, path);
  }
});

test("anonymous OAuth endpoints are rate limited and only the policy can reach the local MCP proxy", () => {
  const rules = createPolicy(settings).on_http_request;
  const limits = withAction(rules, "rate-limit");
  assert.equal(limits.length, 2);
  const [limit] = limits;
  assert.match(expression(limit), /'\/reg'/);
  assert.match(expression(limit), /'\/auth'/);
  assert.equal(limit.actions[0].config.capacity, 30);
  assert.equal(limit.actions[0].config.rate, "60s");
  assert.deepEqual(limit.actions[0].config.bucket_key, ["conn.client_ip"]);
  const mcpForward = (policy) =>
    withAction(policy.on_http_request, "forward-internal").find((rule) =>
      rule.actions.some((action) => action.config?.url === settings.mcpInternalUrl),
    );
  const secret = mcpForward(createPolicy(settings)).actions.find(
    (action) => action.type === "add-headers",
  );
  assert.equal(secret.config.headers["x-mcp-oauth-provider-secret"], settings.gatewaySecret);
  // A user-owned internal MCP endpoint must never receive the gateway secret.
  const internal = mcpForward(createPolicy({ ...settings, stripMcpQuery: true }));
  assert.ok(!internal.actions.some((action) => action.type === "add-headers"));
});
