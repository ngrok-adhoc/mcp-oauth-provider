import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createIssuer } from "../dist/lib/issuer.js";
import { openOAuthState } from "../dist/lib/state.js";

const claudeClientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const claudeCallback = "https://claude.ai/api/mcp/auth_callback";
const codexClientId = "https://chatgpt.com/oauth/codex/client.json";
const codexPublishedRedirects = ["http://127.0.0.1/callback", "http://localhost/callback"];
const jwtBearerGrant = "urn:ietf:params:oauth:grant-type:jwt-bearer";

async function checkOAuth(
  t,
  {
    redirectUri,
    redirectUris = [redirectUri],
    applicationType = "web",
    publishedClientId,
    persistent = false,
  },
) {
  const claudeCimd = Boolean(publishedClientId);
  const publishedClaude = publishedClientId === claudeClientId;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let handle;
  const server = createServer((req, res) => handle(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const gatewaySecret = "test-gateway-secret-".repeat(3);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = {
    ...privateKey.export({ format: "jwk" }),
    kid: "issuer-test",
    use: "sig",
    alg: "RS256",
  };
  const resource = "https://mcp-oauth-provider.example/mcp";
  const mcpServerName = claudeCimd ? "Bowie & <Tools>" : undefined;
  const mcpServerIcon = publishedClaude
    ? new URL("https://images.example.com/bowie.png?size=40&v=1")
    : claudeCimd
      ? new URL("data:image/svg+xml;base64,PHN2Zy8+")
      : undefined;
  const users = ["owner@example.com", "guest@example.com"];
  const project = persistent ? await mkdtemp(join(tmpdir(), "mcp-oauth-restart-")) : undefined;
  let state;
  if (project)
    t.after(async () => {
      await state?.close();
      await rm(project, { recursive: true, force: true });
    });
  async function start(allowlist = users) {
    await state?.close();
    state = undefined;
    if (project) state = await openOAuthState(issuer, allowlist, project);
    ({ handle } = createIssuer({
      issuer,
      gatewaySecret,
      jwks: state?.jwks ?? { keys: [key] },
      adapter: state?.adapter,
      cookieKey: state?.cookieKey,
      resource,
      claudeCimd,
      mcpServerName,
      mcpServerIcon,
    }));
  }
  await start();
  const signingKey = state
    ? createPublicKey({ key: state.jwks.keys[0], format: "jwk" })
    : publicKey;
  const cookies = new Map();
  async function request(path, options = {}) {
    const response = await fetch(new URL(path, issuer), {
      ...options,
      redirect: "manual",
      headers: {
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        ...options.headers,
      },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  const registration = {
    application_type: applicationType,
    client_name: '<img src=x onerror="alert(1)">',
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const metadataFetches = [];
  const expectedPublishedRedirects = publishedClaude ? [redirectUri] : codexPublishedRedirects;
  let publishedRedirects = expectedPublishedRedirects;
  if (claudeCimd) {
    const fetchLocal = globalThis.fetch;
    t.mock.method(globalThis, "fetch", (url, options) => {
      if (new URL(url).origin === issuer) return fetchLocal(url, options);
      metadataFetches.push(String(url));
      assert.equal(String(url), publishedClientId);
      assert.equal(options.redirect, "manual");
      return Response.json({
        ...registration,
        client_id: publishedClientId,
        redirect_uris: publishedRedirects,
        grant_types: [
          "authorization_code",
          "refresh_token",
          ...(publishedClaude ? [jwtBearerGrant] : []),
        ],
        ...(!publishedClaude && { token_endpoint_auth_methods_supported: ["none"] }),
      });
    });
  }
  const register = (body) =>
    request("/reg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await register({ ...registration, redirect_uris: ["https://example.com/callback"] })).status,
    400,
  );
  assert.equal(
    (
      await register({
        ...registration,
        application_type: "web",
        redirect_uris: ["https://example.com/callback"],
      })
    ).status,
    400,
  );
  assert.equal(
    (await register({ ...registration, grant_types: ["client_credentials"] })).status,
    400,
  );
  for (const redirect of [
    "https://chatgpt.com.evil.com/connector_platform_oauth_redirect",
    "https://evil.com/connector/oauth/test",
    "http://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com:444/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector_platform_oauth_redirect?next=https://evil.com",
    "https://chatgpt.com/connector_platform_oauth_redirect#fragment",
    "https://user:password@chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/",
    "https://chatgpt.com/connector/oauth/test/extra",
    "https://chatgpt.com/connector/oauth/%2Ftest",
    "https://chatgpt.com/other",
    "https://www.cursor.com.evil.com/agents/mcp/oauth/callback",
    "https://cursor.com/agents/mcp/oauth/callback",
    "http://www.cursor.com/agents/mcp/oauth/callback",
    "https://www.cursor.com:444/agents/mcp/oauth/callback",
    "https://www.cursor.com/agents/mcp/oauth/callback/extra",
    "https://www.cursor.com/agents/mcp/oauth/callback?next=https://evil.com",
    "https://www.cursor.com/agents/mcp/oauth/callback#fragment",
    "https://user:password@www.cursor.com/agents/mcp/oauth/callback",
    "cursor://anysphere.cursor-mcp/oauth/callback",
    "https://claude.ai.evil.com/api/mcp/auth_callback",
    "http://claude.ai/api/mcp/auth_callback",
    "https://claude.ai:443/api/mcp/auth_callback",
    "https://claude.ai:444/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback/extra",
    "https://claude.ai/api/mcp/other/../auth_callback",
    "https://claude.ai/api/mcp/auth_callback?next=https://evil.com",
    "https://claude.ai/api/mcp/auth_callback#fragment",
    "https://user:password@claude.ai/api/mcp/auth_callback",
  ])
    assert.equal(
      (await register({ ...registration, application_type: "web", redirect_uris: [redirect] }))
        .status,
      400,
      redirect,
    );
  assert.equal(
    (await register({ ...registration, token_endpoint_auth_method: "client_secret_post" })).status,
    400,
  );
  const codeOnly = await (await register(registration)).json();
  const { grant_types: _grantTypes, ...defaultRegistration } = registration;
  const defaultClient = await (await register(defaultRegistration)).json();
  assert.deepEqual(defaultClient.grant_types, ["authorization_code", "refresh_token"]);
  const registered = await register({
    ...registration,
    grant_types: ["authorization_code", "refresh_token"],
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const client = await registered.json();
  assert.deepEqual(client.redirect_uris, redirectUris);
  const metadata = await (await request("/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.client_id_metadata_document_supported, claudeCimd || undefined);
  assert.equal(metadata.registration_endpoint, `${issuer}/reg`);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.ok(metadata.grant_types_supported.includes("authorization_code"));
  assert.ok(metadata.grant_types_supported.includes("refresh_token"));
  assert.ok(!metadata.grant_types_supported.includes(jwtBearerGrant));
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    client_id: publishedClientId ?? client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "mcp:use",
    resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "test-state",
  };
  const authorize = (extra = {}) =>
    request(`/auth?${new URLSearchParams({ ...params, ...extra })}`);
  if (claudeCimd) {
    assert.equal((await authorize({ client_id: `${publishedClientId}/other` })).status, 400);
    assert.deepEqual(metadataFetches, []);
    assert.equal(
      (
        await register({
          ...registration,
          client_id: publishedClientId,
          grant_types: ["authorization_code", jwtBearerGrant],
        })
      ).status,
      400,
    );
    publishedRedirects = ["https://chatgpt.com/connector_platform_oauth_redirect"];
    assert.equal((await authorize()).status, 400);
    publishedRedirects = expectedPublishedRedirects;
  }
  assert.equal((await authorize({ redirect_uri: "https://chatgpt.com/other" })).status, 400);
  let response = await authorize({ code_challenge: "", code_challenge_method: "" });
  assert.match(response.headers.get("location") ?? (await response.text()), /invalid_request/);
  response = await authorize({ code_challenge_method: "plain" });
  assert.match(response.headers.get("location") ?? (await response.text()), /invalid_request/);
  let authorizationCount = 0;
  async function code(extra = {}, decision = "allow") {
    let consentForms = 0;
    let result = await authorize(extra);
    for (let step = 0; step < 10; step++) {
      const location = result.headers.get("location");
      assert.ok(location, `Expected OAuth redirect, got ${result.status}: ${await result.text()}`);
      if (location.startsWith(redirectUri)) {
        const url = new URL(location);
        assert.equal(url.searchParams.get("state"), "test-state");
        assert.equal(url.searchParams.get("iss"), issuer);
        assert.ok(consentForms <= 1, "One approval form is sufficient");
        if (authorizationCount++ === 0) assert.equal(consentForms, 1);
        if (decision === "deny") {
          assert.equal(url.searchParams.get("code"), null);
          return url.searchParams.get("error");
        }
        assert.ok(url.searchParams.get("code"), location);
        return url.searchParams.get("code");
      }
      if (location.startsWith("/interaction/")) {
        assert.equal((await request(location)).status, 403);
        assert.equal(
          (await request(location, { headers: { "x-mcp-oauth-provider-secret": "incorrect" } }))
            .status,
          403,
        );
        assert.equal(
          (
            await request(location, {
              method: "DELETE",
              headers: { "x-mcp-oauth-provider-secret": gatewaySecret },
            })
          ).status,
          405,
        );
        const page = await request(location, {
          headers: { "x-mcp-oauth-provider-secret": gatewaySecret },
        });
        if (page.status === 303) {
          result = page;
          continue;
        }
        assert.equal(page.status, 200, await page.clone().text());
        consentForms++;
        assert.ok(
          page.headers.get("content-security-policy").includes(new URL(redirectUri).origin),
        );
        const html = await page.text();
        if (claudeCimd) {
          assert.match(html, /<title>Bowie &amp; &lt;Tools&gt;<\/title>/);
          assert.match(html, /wants to connect to Bowie &amp; &lt;Tools&gt;/);
          if (publishedClaude) {
            assert.match(html, /src="https:\/\/images\.example\.com\/bowie\.png\?size=40&amp;v=1"/);
            assert.match(
              page.headers.get("content-security-policy"),
              /img-src https:\/\/images\.example\.com;/,
            );
          } else {
            assert.match(html, /src="data:image\/svg\+xml;base64,PHN2Zy8\+"/);
            assert.match(page.headers.get("content-security-policy"), /img-src data:;/);
          }
        } else {
          assert.match(html, /<title>MCP OAuth Provider<\/title>/);
          assert.match(html, /wants to connect to your MCP server/);
          assert.match(html, /class="logo default-logo" src="data:image\/svg\+xml;base64,/);
          assert.match(page.headers.get("content-security-policy"), /img-src data:;/);
        }
        assert.match(html, /width="100" height="100" alt="" referrerpolicy="no-referrer"/);
        assert.match(html, /including access to all read and write tools/);
        assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
        assert.doesNotMatch(html, /<img src=x|<script|<style/);
        assert.match(
          html,
          /This tool uses ngrok to OAuth to your existing HTTP MCP server and forward authorized requests to it\./,
        );
        assert.match(html, /rel="stylesheet" href="\/interaction\/consent\.css"/);
        assert.equal((html.match(/<form\b/g) ?? []).length, 1);
        assert.match(html, /<details open="">\s*<summary>Connection details<\/summary>/);
        assert.equal((html.match(/<div><dt>/g) ?? []).length, 4);
        assert.match(html, />Cancel<\/button>/);
        assert.match(html, />Authorize<\/button>/);
        assert.match(
          page.headers.get("content-security-policy"),
          /default-src 'none'; style-src 'self'/,
        );
        assert.doesNotMatch(page.headers.get("content-security-policy"), /script-src/);
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
        const submit = (token, origin = issuer) =>
          request(location, {
            method: "POST",
            headers: {
              "x-mcp-oauth-provider-secret": gatewaySecret,
              Origin: origin,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ csrf: token, decision }),
          });
        assert.equal((await submit("wrong")).status, 403);
        assert.equal((await submit(csrf, "https://other.example")).status, 403);
        result = await submit(csrf);
      } else result = await request(location);
    }
    assert.fail("OAuth interaction did not finish");
  }
  const exchange = (
    authorizationCode,
    codeVerifier,
    clientId = params.client_id,
    redirect = redirectUri,
  ) =>
    request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirect,
        resource,
        code: authorizationCode,
        code_verifier: codeVerifier,
      }),
    });
  assert.equal(await code({}, "deny"), "access_denied");
  const invalid = await exchange(await code(), randomBytes(32).toString("base64url"));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "invalid_grant");
  const wrongRedirect = await exchange(
    await code(),
    verifier,
    params.client_id,
    "https://chatgpt.com/other",
  );
  assert.equal(wrongRedirect.status, 400);
  assert.equal((await wrongRedirect.json()).error, "invalid_grant");
  const authorizationCode = await code();
  if (persistent) {
    const originalKeys = await (await request("/jwks")).json();
    await start([...users].reverse());
    assert.deepEqual(await (await request("/jwks")).json(), originalKeys);
  }
  const exchanged = await exchange(authorizationCode, verifier);
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const token = await exchanged.json();
  assert.equal(token.expires_in, 60 * 60);
  assert.equal(typeof token.refresh_token, "string");
  const claims = JSON.parse(Buffer.from(token.access_token.split(".")[1], "base64url"));
  const [header, payload, signature] = token.access_token.split(".");
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      signingKey,
      Buffer.from(signature, "base64url"),
    ),
  );
  assert.equal(claims.iss, issuer);
  assert.equal(claims.aud, resource);
  assert.equal(claims.sub, "owner");
  assert.equal(claims.scope, "mcp:use");
  assert.equal(claims.exp - claims.iat, 60 * 60);
  const refresh = (value, extra = {}) =>
    request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: params.client_id,
        refresh_token: value,
        resource,
        ...extra,
      }),
    });
  const rejected = async (response, error) => {
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal((await response.json()).error, error);
  };
  if (claudeCimd) {
    await rejected(
      await refresh("unused", { grant_type: jwtBearerGrant }),
      "unsupported_grant_type",
    );
    assert.ok(metadataFetches.length >= 2);
    assert.ok(metadataFetches.every((url) => url === publishedClientId));
  }
  await rejected(await refresh("not-issued"), "invalid_grant");
  const otherClient = await (
    await register({
      ...registration,
      grant_types: ["authorization_code", "refresh_token"],
    })
  ).json();
  await rejected(
    await refresh(token.refresh_token, { client_id: otherClient.client_id }),
    "invalid_grant",
  );
  await rejected(await refresh(token.refresh_token, { scope: "mcp:use admin" }), "invalid_scope");

  if (persistent) {
    await start();
    // The browser session survives a restart, but consent is still required every time.
    const remembered = await authorize();
    const consent = await request(remembered.headers.get("location"), {
      headers: { "x-mcp-oauth-provider-secret": gatewaySecret },
    });
    assert.equal(consent.status, 200, await consent.clone().text());
    assert.match(await consent.text(), /Authorize/);
  }
  now += 301_000;
  assert.ok(claims.exp > Math.floor(now / 1000));
  const renewed = await refresh(token.refresh_token);
  assert.equal(renewed.status, 200, await renewed.clone().text());
  const renewedToken = await renewed.json();
  assert.equal(renewedToken.expires_in, 60 * 60);
  assert.notEqual(renewedToken.refresh_token, token.refresh_token);
  const renewedClaims = JSON.parse(
    Buffer.from(renewedToken.access_token.split(".")[1], "base64url"),
  );
  assert.equal(renewedClaims.iss, issuer);
  assert.equal(renewedClaims.aud, resource);
  assert.equal(renewedClaims.sub, "owner");
  assert.equal(renewedClaims.scope, "mcp:use");
  assert.equal(renewedClaims.exp, Math.floor(now / 1000) + 60 * 60);

  await rejected(await refresh(token.refresh_token), "invalid_grant");
  // Reusing a consumed refresh revokes the entire grant, including its current rotation.
  await rejected(await refresh(renewedToken.refresh_token), "invalid_grant");
  const replayed = await exchange(authorizationCode, verifier);
  await rejected(replayed, "invalid_grant");

  const withoutRefresh = await exchange(
    await code({ client_id: codeOnly.client_id }),
    verifier,
    codeOnly.client_id,
  );
  assert.equal(withoutRefresh.status, 200, await withoutRefresh.clone().text());
  assert.equal((await withoutRefresh.json()).refresh_token, undefined);

  const targetToken = await (await exchange(await code(), verifier)).json();
  await rejected(
    await refresh(targetToken.refresh_token, { resource: "https://other.example/mcp" }),
    "invalid_target",
  );

  const lifetimeToken = await (await exchange(await code(), verifier)).json();
  const issuedAt = now;
  const lifetimeClaims = JSON.parse(
    Buffer.from(lifetimeToken.access_token.split(".")[1], "base64url"),
  );
  assert.equal(lifetimeClaims.exp - lifetimeClaims.iat, 60 * 60);
  now += 2 * 24 * 60 * 60 * 1000;
  const afterBrowserSession = await refresh(lifetimeToken.refresh_token);
  assert.equal(afterBrowserSession.status, 200, await afterBrowserSession.clone().text());
  const middleToken = await afterBrowserSession.json();
  assert.notEqual(middleToken.refresh_token, lifetimeToken.refresh_token);
  assert.equal(middleToken.expires_in, 60 * 60);
  now = issuedAt + (90 * 24 * 60 * 60 - 60) * 1000;
  const nearLimit = await refresh(middleToken.refresh_token);
  assert.equal(nearLimit.status, 200, await nearLimit.clone().text());
  const lastToken = await nearLimit.json();
  assert.equal(lastToken.expires_in, 60);
  const lastClaims = JSON.parse(Buffer.from(lastToken.access_token.split(".")[1], "base64url"));
  // Access tokens never outlive the 90-day grant.
  assert.equal(lastClaims.exp, Math.floor(issuedAt / 1000) + 90 * 24 * 60 * 60);
  now = issuedAt + (90 * 24 * 60 * 60 + 1) * 1000;
  assert.ok(lastClaims.exp < Math.floor(now / 1000));
  await rejected(await refresh(lastToken.refresh_token), "invalid_grant");

  if (persistent) {
    const fresh = await exchange(await code(), verifier);
    assert.equal(fresh.status, 200, await fresh.clone().text());
    const prior = await fresh.json();
    const previousKid = state.kid;
    const previousCookieKey = state.cookieKey;
    await start(["guest@example.com"]);
    assert.notEqual(state.cookieKey, previousCookieKey);
    const {
      keys: [currentKey],
    } = await (await request("/jwks")).json();
    assert.notEqual(currentKey.kid, previousKid);
    assert.equal(currentKey.d, undefined);
    const [h, p, sig] = prior.access_token.split(".");
    assert.equal(
      verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`),
        createPublicKey({ key: currentKey, format: "jwk" }),
        Buffer.from(sig, "base64url"),
      ),
      false,
    );
    const revocation = await refresh(prior.refresh_token);
    assert.ok([400, 401].includes(revocation.status));
    assert.equal((await revocation.json()).error, "invalid_client");

    const freshClient = await (await register(registration)).json();
    const login = await authorize({ client_id: freshClient.client_id });
    const interaction = login.headers.get("location");
    assert.match(interaction, /^\/interaction\//);
    await mkdir(join(project, ".mcp-oauth-provider", ".oauth.json.tmp"));
    // Interactions live in memory, so the outage surfaces when sign-in saves the browser session.
    const signedIn = await request(interaction, {
      headers: { "x-mcp-oauth-provider-secret": gatewaySecret },
    });
    assert.equal(signedIn.status, 303);
    const page = await request(signedIn.headers.get("location"));
    const message = "OAuth storage is unavailable. Contact the provider operator.";
    assert.equal(page.status, 503);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(await page.text(), message);

    const unavailable = await refresh(prior.refresh_token, { client_id: freshClient.client_id });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: "temporarily_unavailable",
      error_description: message,
    });
    const registrationUnavailable = await register(registration);
    assert.equal(registrationUnavailable.status, 503);
    assert.equal((await registrationUnavailable.json()).error_description, message);
  }
}

for (const profile of [
  {
    name: "Codex loopback",
    redirectUri: "http://127.0.0.1:9988/callback",
    applicationType: "native",
  },
  {
    name: "Claude Code loopback",
    redirectUri: "http://localhost:9988/callback",
    applicationType: "native",
  },
  { name: "IPv6 loopback", redirectUri: "http://[::1]:9988/callback", applicationType: "native" },
  { name: "Claude hosted", redirectUri: claudeCallback },
  {
    name: "JSON persistence across restarts and allowlist changes",
    redirectUri: claudeCallback,
    persistent: true,
  },
  {
    name: "Claude published identity",
    redirectUri: claudeCallback,
    publishedClientId: claudeClientId,
  },
  {
    name: "Codex published identity",
    redirectUri: "http://127.0.0.1:9988/callback",
    applicationType: "native",
    publishedClientId: codexClientId,
  },
  { name: "ChatGPT stable", redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect" },
  {
    name: "ChatGPT callback ID",
    redirectUri: "https://chatgpt.com/connector/oauth/test-callback_123",
  },
  ...["http://localhost:8787/callback", "https://www.cursor.com/agents/mcp/oauth/callback"].map(
    (redirectUri) => ({
      name: `Cursor dual registration using ${redirectUri}`,
      redirectUri,
      applicationType: "native",
      redirectUris: [
        "http://localhost:8787/callback",
        "https://www.cursor.com/agents/mcp/oauth/callback",
      ],
    }),
  ),
])
  test(`OAuth ${profile.name}: consent, PKCE, JWT, refresh and one-time codes`, (t) =>
    checkOAuth(t, profile));

test("only query responses, small valid metadata and routed features are offered", async (t) => {
  let handle;
  const server = createServer((req, res) => handle(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = { ...privateKey.export({ format: "jwk" }), kid: "k", use: "sig", alg: "RS256" };
  ({ handle } = createIssuer({ issuer, gatewaySecret: "x".repeat(40), jwks: { keys: [key] } }));
  const register = (metadata) =>
    fetch(`${issuer}/reg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1/cb"],
        token_endpoint_auth_method: "none",
        ...metadata,
      }),
    });
  const client = await (await register({})).json();
  assert.deepEqual(client.response_modes, ["query"]);
  assert.equal((await register({ response_modes: ["form_post"] })).status, 400);
  assert.equal((await register({ redirect_uris: ["not a url"] })).status, 400);
  assert.equal((await register({ client_name: "x".repeat(5000) })).status, 400);
  const auth = (mode) =>
    fetch(
      `${issuer}/auth?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1/cb",
        response_type: "code",
        response_mode: mode,
        code_challenge_method: "S256",
        code_challenge: "a".repeat(43),
      })}`,
      { redirect: "manual" },
    );
  // form_post would render the code in a page on the shared public origin.
  const formPost = await auth("form_post");
  assert.equal(formPost.status, 400);
  const rejection = await formPost.text();
  assert.match(rejection, /response_mode is not allowed/);
  assert.doesNotMatch(rejection, /name="code"/);
  const error = await fetch(`${issuer}/auth?client_id=unknown`);
  assert.equal(error.headers.get("x-frame-options"), "DENY");
  assert.match(error.headers.get("content-type"), /^text\/plain/);
  assert.doesNotMatch(await error.text(), /<|googleapis/);
  assert.match((await auth("query")).headers.get("location"), /^\/interaction\//);
  const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
  assert.deepEqual(discovery.response_modes_supported, ["query"]);
  assert.equal(discovery.dpop_signing_alg_values_supported, undefined);
  assert.equal(discovery.pushed_authorization_request_endpoint, undefined);
  assert.equal(discovery.end_session_endpoint, undefined);
});
