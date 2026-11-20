import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { startServers } from "../dist/lib/server.js";

async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
const gatewaySecret = "test-gateway-secret-".repeat(3);
const gateway = { headers: { "x-mcp-oauth-provider-secret": gatewaySecret } };
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = {
  keys: [{ ...privateKey.export({ format: "jwk" }), kid: "server-test", use: "sig", alg: "RS256" }],
};

async function fixture(t, handler, path = "/private-mcp") {
  const upstream = createServer(handler);
  const url = await listen(upstream);
  const servers = await startServers({
    mcpUrl: `${url}${path}`,
    issuer: "https://provider.example",
    gatewaySecret,
    jwks,
  });
  t.after(async () => {
    await servers.close();
    await close(upstream);
  });
  return { upstream, url, ...servers };
}

test("only the private adapter forwards to the fixed MCP target", async (t) => {
  const { helperUrl, mcpProxyUrl } = await fixture(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.writeHead(req.url === "/private-mcp" ? 201 : 200, {
      "content-type": "application/json",
      "x-upstream": "preserved",
    });
    res.end(
      JSON.stringify({
        url: req.url,
        body,
        authorization: req.headers.authorization,
        secret: req.headers["x-mcp-oauth-provider-secret"],
      }),
    );
  });
  for (const path of [
    "/",
    "/assets/app.css",
    "/mcp",
    "/mcp/child",
    "/mcp-debug",
    "/private-mcp",
    "/%70rivate-mcp",
  ])
    assert.equal((await fetch(`${helperUrl}${path}`)).status, 404, path);
  const mcp = await fetch(`${mcpProxyUrl}/mcp?ignored=secret`, {
    method: "POST",
    body: "unchanged MCP payload",
    headers: {
      authorization: "Bearer not-for-upstream",
      "x-mcp-oauth-provider-secret": gatewaySecret,
    },
  });
  assert.equal(mcp.status, 201);
  assert.equal(mcp.headers.get("x-upstream"), "preserved");
  assert.deepEqual(await mcp.json(), { url: "/private-mcp", body: "unchanged MCP payload" });
  assert.equal((await fetch(`${mcpProxyUrl}/other`)).status, 404);
  const ungated = await fetch(`${mcpProxyUrl}/mcp`, {
    headers: { "x-mcp-oauth-provider-secret": "wrong" },
  });
  assert.equal(ungated.status, 403);
  assert.equal((await fetch(`${mcpProxyUrl}/mcp`)).status, 403);
  const malformedStatus = await new Promise((resolve, reject) => {
    const target = new URL(mcpProxyUrl);
    const request = httpRequest(
      { hostname: target.hostname, port: target.port, path: "http://[", method: "GET" },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(malformedStatus, 400);
  assert.equal((await fetch(`${helperUrl}/.well-known/oauth-authorization-server`)).status, 200);
  const stylesheet = `${helperUrl}/interaction/consent.css`;
  assert.equal((await fetch(stylesheet)).status, 403);
  const asset = await fetch(stylesheet, {
    headers: { "x-mcp-oauth-provider-secret": gatewaySecret },
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/css; charset=utf-8");
  assert.match(await asset.text(), /\.permission/);
});

test("offline upstream returns a useful 503 and recovers without provider restart", async (t) => {
  const { upstream, url, mcpProxyUrl } = await fixture(t, (req, res) => res.end("recovered"));
  const port = new URL(url).port;
  await close(upstream);
  const mcp = await fetch(`${mcpProxyUrl}/mcp`, gateway);
  assert.equal(mcp.status, 503);
  const error = await mcp.json();
  assert.equal(error.error, "mcp_upstream_unavailable");
  assert.match(error.action, /Start the server/);
  await listen(upstream, Number(port));
  assert.equal(await (await fetch(`${mcpProxyUrl}/mcp`, gateway)).text(), "recovered");
});

test("established MCP requests can wait for slow tool response headers", async (t) => {
  let finish;
  let received;
  const waiting = new Promise((resolve) => (received = resolve));
  const { mcpProxyUrl } = await fixture(t, (_req, res) => {
    finish = () => res.end("slow tool result");
    received();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = new Promise((resolve, reject) => {
    const req = httpRequest(`${mcpProxyUrl}/mcp`, gateway, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
  await waiting;
  t.mock.timers.tick(300001);
  finish();
  assert.deepEqual(await response, { status: 200, body: "slow tool result" });
});

test("MCP responses stream before the upstream closes", async (t) => {
  let finish;
  const { mcpProxyUrl } = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    finish = () => res.end("data: last\n\n");
  });
  const response = await fetch(`${mcpProxyUrl}/mcp`, gateway);
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /data: first/);
  finish();
  assert.match(new TextDecoder().decode((await reader.read()).value), /data: last/);
  assert.equal((await reader.read()).done, true);
});

test("a root-mounted MCP server is reachable only through the private adapter", async (t) => {
  let requests = 0;
  const { helperUrl, mcpProxyUrl } = await fixture(
    t,
    (req, res) => {
      requests++;
      res.end(req.url);
    },
    "/",
  );
  assert.equal((await fetch(`${helperUrl}/`)).status, 404);
  assert.equal((await fetch(`${helperUrl}/anything`)).status, 404);
  assert.equal(requests, 0);
  assert.equal(await (await fetch(`${mcpProxyUrl}/mcp`, gateway)).text(), "/");
  assert.equal(requests, 1);
});
