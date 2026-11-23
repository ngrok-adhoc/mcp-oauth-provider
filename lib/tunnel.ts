import { randomBytes } from "node:crypto";
import https from "node:https";
import { normalize } from "node:path/posix";

import type ngrok from "@ngrok/ngrok";
import type { Listener, Session } from "@ngrok/ngrok";

import type { AccessEntry } from "./config.js";

import { createPolicy, createValidationPolicy } from "./policy.js";

function publicOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("PUBLIC_URL must be an HTTPS origin without a path.");
  return url.origin;
}

function localOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("The local tunnel upstream must be an HTTP loopback origin.");
  return url.origin;
}

async function closeResources(session: Session, listeners: Listener[]) {
  await Promise.allSettled(listeners.map((listener) => listener.close()));
  await session.close().catch(() => {});
}

export async function reservePublicUrl({
  authtoken,
  publicUrl,
  sdk,
}: {
  authtoken: string;
  publicUrl?: string;
  sdk?: Pick<typeof ngrok, "SessionBuilder">;
}) {
  sdk ??= (await import("@ngrok/ngrok")).default;
  const session = await new sdk.SessionBuilder().authtoken(authtoken).connect();
  let provisional: Listener | undefined;
  try {
    // Claim the public URL before OAuth state opens: a second instance fails here instead of
    // rewriting shared state that the running instance owns.
    // shortcut: the claim is released while state opens, so two instances starting at the same
    // moment can both pass; run one provider per state object.
    const configured = publicUrl ? publicOrigin(publicUrl) : undefined;
    const endpoint = session.httpEndpoint().binding("public");
    if (configured) endpoint.domain(new URL(configured).hostname);
    provisional = await endpoint
      .trafficPolicy(
        JSON.stringify({
          on_http_request: [
            {
              actions: [
                {
                  type: "custom-response",
                  config: {
                    status_code: 503,
                    body: "MCP OAuth Provider is starting. Retry shortly.",
                    headers: { "content-type": "text/plain", "cache-control": "no-store" },
                  },
                },
              ],
            },
          ],
        }),
      )
      .listen();
    const reservedUrl = provisional.url();
    if (!reservedUrl) throw new Error("ngrok did not allocate a public URL.");
    const issuer = configured ?? publicOrigin(reservedUrl);
    await provisional.close();
    provisional = undefined;
    return {
      session,
      issuer,
      close: () => closeResources(session, provisional ? [provisional] : []),
    };
  } catch (error) {
    await closeResources(session, provisional ? [provisional] : []);
    throw error;
  }
}

async function waitForJwks(url: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const request = https.get(url, { agent: false }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on("error", () => resolve(false));
      request.setTimeout(10000, () => {
        request.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "The public signing-key endpoint did not become reachable. Check ngrok connectivity and restart MCP OAuth Provider.",
  );
}

export async function startTunnels({
  session,
  issuer,
  helperUrl,
  mcpUrl,
  appUrl,
  internalMcpOrigin,
  mcpUpstreamUrl,
  gatewaySecret,
  users,
  oauthRequestsPerMinute,
  mcpRequestsPerMinute,
  jwksUrl,
}: {
  session: Session;
  issuer: string;
  helperUrl: string;
  mcpUrl: string;
  appUrl?: string;
  internalMcpOrigin?: string;
  mcpUpstreamUrl: string;
  gatewaySecret: string;
  users: AccessEntry[];
  oauthRequestsPerMinute?: number;
  mcpRequestsPerMinute?: number;
  jwksUrl?: string;
}) {
  const listeners: Listener[] = [];
  try {
    issuer = publicOrigin(issuer);
    helperUrl = localOrigin(helperUrl);
    mcpUrl = localOrigin(mcpUrl);
    const suffix = randomBytes(8).toString("hex");
    const mcpInternalUrl =
      internalMcpOrigin ?? `https://mcp-oauth-provider-backend-${suffix}.internal`;
    const validationUrl = `https://mcp-oauth-provider-validator-${suffix}.internal`;
    const mcpUpstreamPath = appUrl
      ? normalize(decodeURIComponent(new URL(mcpUpstreamUrl).pathname).replaceAll("\\", "/"))
          .replace(/\/+$/, "")
          .toLowerCase() || "/"
      : undefined;
    const app = appUrl && mcpUpstreamPath !== "/" ? new URL(appUrl) : undefined;
    const appInternalUrl = app && `https://mcp-oauth-provider-app-${suffix}.internal`;
    jwksUrl ??= `${issuer}/jwks?v=${suffix}`;
    const keyUrl = new URL(jwksUrl);
    if (keyUrl.origin !== issuer || keyUrl.pathname !== "/jwks")
      throw new Error("Signing keys must be served by this provider's /jwks endpoint.");
    const policy = createPolicy({
      issuer,
      mcpInternalUrl,
      validationUrl,
      gatewaySecret,
      users,
      oauthRequestsPerMinute,
      mcpRequestsPerMinute,
      stripMcpQuery: Boolean(internalMcpOrigin),
      appInternalUrl,
      mcpUpstreamPath,
    });
    if (!internalMcpOrigin) {
      listeners.push(
        await session
          .httpEndpoint()
          .domain(new URL(mcpInternalUrl).hostname)
          .binding("internal")
          .listenAndForward(mcpUrl),
      );
    }
    if (app && appInternalUrl) {
      listeners.push(
        await session
          .httpEndpoint()
          .domain(new URL(appInternalUrl).hostname)
          .binding("internal")
          .requestHeader("host", app.host)
          .verifyUpstreamTls(true)
          .listenAndForward(app.href),
      );
    }
    listeners.push(
      await session
        .httpEndpoint()
        .domain(new URL(issuer).hostname)
        .binding("public")
        .trafficPolicy(JSON.stringify(policy))
        .listenAndForward(helperUrl),
    );
    // The JWT validator fetches signing keys when its policy is registered.
    await waitForJwks(jwksUrl);
    listeners.push(
      await session
        .httpEndpoint()
        .domain(new URL(validationUrl).hostname)
        .binding("internal")
        .trafficPolicy(JSON.stringify(createValidationPolicy({ issuer, jwksUrl })))
        .listen(),
    );
    return {
      issuer,
      listeners,
      appUrl: app?.href,
      close: () => closeResources(session, listeners),
    };
  } catch (error) {
    await closeResources(session, listeners);
    throw error;
  }
}
