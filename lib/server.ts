import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";

import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";

import { createIssuer, type IssuerOptions } from "./issuer.js";

const visibleUrl = (value: URL) => {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
};
const json = (res: ServerResponse, status: number, body: object) => {
  if (!res.destroyed && !res.headersSent)
    res
      .writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(JSON.stringify(body));
};
const transport = (url: URL) => (url.protocol === "https:" ? httpsRequest : httpRequest);
function headersWithoutHopByHop(headers: IncomingHttpHeaders) {
  const copy = { ...headers };
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...String(headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase()),
  ])
    delete copy[name];
  return copy;
}

export async function startServers({
  mcpUrl,
  issuer,
  gatewaySecret,
  jwks,
  adapter,
  cookieKey,
  claudeCimd,
  mcpServerName,
  mcpServerIcon,
}: IssuerOptions & { mcpUrl: string }) {
  const auth = createIssuer({
    issuer,
    gatewaySecret,
    jwks,
    adapter,
    cookieKey,
    claudeCimd,
    mcpServerName,
    mcpServerIcon,
  });
  const active = new Set<ClientRequest>();
  const target = new URL(mcpUrl);
  function forwardMcp(req: IncomingMessage, res: ServerResponse) {
    const headers = headersWithoutHopByHop(req.headers);
    delete headers["x-mcp-oauth-provider-secret"];
    delete headers.authorization;
    headers.host = target.host;
    const upstream = transport(target)(target, { method: req.method, headers }, (response) => {
      clearTimeout(deadline);
      res.writeHead(response.statusCode ?? 502, headersWithoutHopByHop(response.headers));
      response.on("error", () => res.destroy());
      response.pipe(res);
    });
    active.add(upstream);
    upstream.on("close", () => {
      clearTimeout(deadline);
      active.delete(upstream);
    });
    upstream.on("error", () => {
      if (res.headersSent) return res.destroy();
      json(res, 503, {
        error: "mcp_upstream_unavailable",
        message: "MCP upstream is unavailable.",
        action: `Start the server at ${visibleUrl(target)} and retry.`,
      });
    });
    // MCP tools may compute before sending headers; bound connection setup instead.
    const deadline = setTimeout(() => upstream.destroy(), 120000);
    upstream.on("socket", (socket) => {
      if (upstream.reusedSocket) clearTimeout(deadline);
      else
        socket.once(target.protocol === "https:" ? "secureConnect" : "connect", () =>
          clearTimeout(deadline),
        );
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  }
  const consentStylesPath = "/interaction/consent.css";
  const consentStyles = readFileSync(new URL("../../assets/consent.css", import.meta.url), "utf8");
  const browser = new Hono();
  const expected = Buffer.from(gatewaySecret);
  const fromGateway = (value: unknown) => {
    const secret = Buffer.from(typeof value === "string" ? value : "");
    return secret.length === expected.length && timingSafeEqual(secret, expected);
  };
  browser.all(consentStylesPath, (c) => {
    c.header("Cache-Control", "no-store");
    if (!fromGateway(c.req.header("x-mcp-oauth-provider-secret")))
      return c.text("Open this authorization page through the ngrok sign-in gateway.", 403);
    if (c.req.method !== "GET") return c.text("Use GET.", 405, { Allow: "GET" });
    return c.body(consentStyles, 200, {
      "Content-Type": "text/css; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
  });
  const handleBrowser = getRequestListener(browser.fetch, { overrideGlobalObjects: false });

  const helper = createServer(async (req, res) => {
    try {
      const incoming = new URL(req.url ?? "/", issuer);
      const path = incoming.pathname;
      if (path === consentStylesPath) return await handleBrowser(req, res);
      if (
        [
          "/auth",
          "/token",
          "/reg",
          "/jwks",
          "/.well-known/openid-configuration",
          "/.well-known/oauth-authorization-server",
        ].includes(path) ||
        path.startsWith("/auth/") ||
        path.startsWith("/interaction/")
      )
        return await auth.handle(req, res);
      return json(res, 404, { error: "Use the protected public /mcp connection URL." });
    } catch {
      json(res, 400, { error: "Invalid request. Check the URL and retry." });
    }
  });
  const mcp = createServer((req, res) => {
    try {
      const path = new URL(req.url ?? "/", issuer).pathname;
      if (path !== "/mcp") return json(res, 404, { error: "Use /mcp." });
      // Blocks other local processes, DNS-rebound pages, and other endpoints in the ngrok account.
      if (!fromGateway(req.headers["x-mcp-oauth-provider-secret"]))
        return json(res, 403, { error: "Use the protected public /mcp connection URL." });
      forwardMcp(req, res);
    } catch {
      json(res, 400, { error: "Invalid request. Check the URL and retry." });
    }
  });
  async function close() {
    for (const req of active) req.destroy();
    await Promise.all(
      [helper, mcp].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  }
  try {
    for (const server of [helper, mcp]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
  } catch (error) {
    await close();
    throw error;
  }
  function localUrl(server: Server) {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a loopback TCP listener.");
    return `http://127.0.0.1:${address.port}`;
  }
  return { helperUrl: localUrl(helper), mcpProxyUrl: localUrl(mcp), close };
}
