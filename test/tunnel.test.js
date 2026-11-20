import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { test } from "node:test";

import { reservePublicUrl, startTunnels } from "../dist/lib/tunnel.js";

function fakeSdk({ failAt = 0 } = {}) {
  const calls = [];
  const session = {
    closed: false,
    async close() {
      this.closed = true;
    },
    httpEndpoint() {
      const config = {};
      const builder = {
        domain(value) {
          config.domain = value;
          return this;
        },
        binding(value) {
          config.binding = value;
          return this;
        },
        trafficPolicy(value) {
          config.policy = JSON.parse(value);
          return this;
        },
        requestHeader(name, value) {
          config.requestHeader = [name, value];
          return this;
        },
        verifyUpstreamTls(value) {
          config.verifyUpstreamTls = value;
          return this;
        },
        async listenAndForward(value) {
          config.upstream = value;
          return this.listen();
        },
        async listen() {
          calls.push(config);
          if (calls.length === failAt) throw new Error("Account cannot create this endpoint.");
          config.closed = false;
          return {
            url: () => `https://${config.domain ?? "assigned.ngrok-free.dev"}`,
            async close() {
              config.closed = true;
            },
          };
        },
      };
      return builder;
    },
  };
  const sdk = {
    SessionBuilder: class {
      authtoken(value) {
        assert.equal(value, "fixture-token");
        return this;
      }
      async connect() {
        return session;
      }
    },
  };
  return { sdk, session, calls };
}

const configuration = {
  issuer: "https://assigned.ngrok-free.dev",
  helperUrl: "http://127.0.0.1:3100",
  mcpUrl: "http://127.0.0.1:3101",
  gatewaySecret: "g".repeat(40),
  users: ["person@example.com"],
  jwksUrl: "https://assigned.ngrok-free.dev/jwks?v=fixture-key",
};

test("URL discovery is fail-closed and closes its provisional listener", async () => {
  const fake = fakeSdk();
  const result = await reservePublicUrl({ authtoken: "fixture-token", sdk: fake.sdk });
  assert.equal(result.issuer, configuration.issuer);
  assert.equal(fake.calls[0].policy.on_http_request[0].actions[0].config.status_code, 503);
  assert.equal(fake.calls[0].closed, true);
  await result.close();
  assert.equal(fake.session.closed, true);
});

test("configured URL skips discovery and invalid origins close the session", async () => {
  const fake = fakeSdk();
  const result = await reservePublicUrl({
    authtoken: "fixture-token",
    publicUrl: configuration.issuer,
    sdk: fake.sdk,
  });
  assert.equal(fake.calls.length, 0);
  await result.close();
  const invalid = fakeSdk();
  await assert.rejects(
    reservePublicUrl({
      authtoken: "fixture-token",
      publicUrl: "https://example.com/path",
      sdk: invalid.sdk,
    }),
    /HTTPS origin/,
  );
  assert.equal(invalid.session.closed, true);
});

test("opens one public and two internal listeners, after public signing keys are ready", async (context) => {
  const fake = fakeSdk();
  let checkedKeys = false;
  context.mock.method(https, "get", (url, options, callback) => {
    assert.equal(url, configuration.jwksUrl);
    assert.equal(options.agent, false);
    assert.equal(fake.calls.length, 2);
    checkedKeys = true;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    queueMicrotask(() => callback({ statusCode: 200, resume() {} }));
    return request;
  });
  const tunnels = await startTunnels({
    ...configuration,
    users: ["guest@example.com", { regex: "\\A(?:[^@]+@ngrok\\.com)\\z" }],
    session: fake.session,
  });
  assert.equal(checkedKeys, true);
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0].binding, "internal");
  assert.equal(fake.calls[0].upstream, configuration.mcpUrl);
  assert.equal(fake.calls[1].binding, "public");
  assert.ok(JSON.stringify(fake.calls[1].policy).includes(".matches("));
  assert.ok(JSON.stringify(fake.calls[1].policy).includes("guest@example.com"));
  assert.equal(fake.calls[1].upstream, configuration.helperUrl);
  assert.equal(fake.calls[2].binding, "internal");
  assert.equal(fake.calls[2].upstream, undefined);
  assert.notEqual(fake.calls[0].domain, fake.calls[2].domain);
  assert.ok(fake.calls[0].domain.endsWith(".internal"));
  await tunnels.close();
  assert.ok(fake.calls.every((call) => call.closed));
  assert.equal(fake.session.closed, true);
});

test("an endpoint failure closes earlier listeners and preserves the actionable SDK error", async () => {
  const fake = fakeSdk({ failAt: 2 });
  await assert.rejects(
    startTunnels({ ...configuration, session: fake.session }),
    /Account cannot create/,
  );
  assert.equal(fake.calls[0].closed, true);
  assert.equal(fake.session.closed, true);
});

test("routes validated MCP requests to an existing ngrok internal endpoint", async (t) => {
  const fake = fakeSdk();
  t.mock.method(https, "get", (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    queueMicrotask(() => callback({ statusCode: 200, resume() {} }));
    return request;
  });
  const internalMcpOrigin = "https://bowie.internal";
  const tunnels = await startTunnels({
    ...configuration,
    internalMcpOrigin,
    session: fake.session,
  });
  t.after(() => tunnels.close());

  assert.deepEqual(
    fake.calls.map((call) => call.binding),
    ["public", "internal"],
  );
  const rule = fake.calls[0].policy.on_http_request.find(({ actions }) =>
    actions.some(({ type }) => type === "forward-internal"),
  );
  assert.match(rule.expressions[0], /status_code == 200/);
  assert.deepEqual(rule.actions.slice(0, 3), [
    { type: "remove-headers", config: { headers: ["authorization"] } },
    { type: "url-rewrite", config: { from: "^([^?]+)\\?.*$", to: "$1" } },
    { type: "forward-internal", config: { url: internalMcpOrigin, on_error: "continue" } },
  ]);
});

test("rejects non-loopback upstreams and foreign signing-key URLs before exposing anything", async () => {
  for (const changes of [
    { helperUrl: "http://external.example" },
    { mcpUrl: "https://localhost" },
    { jwksUrl: "https://other.example/jwks" },
  ]) {
    const fake = fakeSdk();
    await assert.rejects(startTunnels({ ...configuration, ...changes, session: fake.session }));
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.session.closed, true);
  }
});

test("an optional APP_URL becomes a direct SDK upstream for website traffic", async (t) => {
  const fake = fakeSdk();
  t.mock.method(https, "get", (_url, _options, callback) => {
    assert.equal(fake.calls.length, 3);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    queueMicrotask(() => callback({ statusCode: 200, resume() {} }));
    return request;
  });
  const tunnels = await startTunnels({
    ...configuration,
    appUrl: "https://mything.internal",
    mcpUpstreamUrl: "http://127.0.0.1:3001/private/mcp",
    session: fake.session,
  });
  t.after(() => tunnels.close());
  const website = fake.calls[1];
  const publicEndpoint = fake.calls[2];
  assert.equal(website.binding, "internal");
  assert.equal(website.upstream, "https://mything.internal/");
  assert.deepEqual(website.requestHeader, ["host", "mything.internal"]);
  assert.equal(website.verifyUpstreamTls, true);
  assert.equal(publicEndpoint.upstream, configuration.helperUrl);
  assert.equal(
    publicEndpoint.policy.on_http_request.at(-1).actions[0].config.url,
    `https://${website.domain}`,
  );
});
