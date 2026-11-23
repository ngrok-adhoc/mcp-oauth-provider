#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { readConfig } from "../lib/config.js";
import { startServers } from "../lib/server.js";
import { openOAuthState } from "../lib/state.js";
import { reservePublicUrl, startTunnels } from "../lib/tunnel.js";

let config: Awaited<ReturnType<typeof readConfig>> | undefined;
let reservation: Awaited<ReturnType<typeof reservePublicUrl>> | undefined;
let servers: Awaited<ReturnType<typeof startServers>> | undefined;
let tunnels: Awaited<ReturnType<typeof startTunnels>> | undefined;
let state: Awaited<ReturnType<typeof openOAuthState>> | undefined;
let stopping = false;
const secrets: string[] = [];
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await tunnels?.close();
    await reservation?.close();
  } finally {
    await servers?.close();
    await state?.close();
  }
}
const help = `MCP OAuth Provider

Run this command from your MCP server’s project directory. Settings come from .env or environment:
  NGROK_AUTHTOKEN  Your ngrok agent authtoken (required)
  USERS            Required JSON array of emails or /regex/ strings for MCP access
  OAUTH_REQUESTS_PER_MINUTE  Per-IP limit for registration and authorization (default 30)
  MCP_REQUESTS_PER_MINUTE    Per-user limit for authenticated MCP requests (default 60)
  CLAUDE_CIMD      Set to 1 to allow published OAuth identities for hosted Claude and Codex
  APP_URL          Optional website origin for ngrok to forward to
  MCP_SERVER_URL   Existing HTTP(S) MCP server URL, including its path (required)
  MCP_SERVER_BINDING  Set to internal for an ngrok .internal MCP endpoint
  MCP_SERVER_NAME  Optional MCP server name on the OAuth consent page
  MCP_SERVER_ICON  Optional local image path or HTTPS icon URL on the OAuth consent page
  NGROK_URL        Optional public HTTPS origin; otherwise allocated automatically
  STORAGE          local or s3 (omit for automatic selection)
  S3_BUCKET        Bucket for OAuth state
  S3_KEY           Optional S3 object key (default mcp-oauth-provider/oauth.json)
  S3_BUCKET_OWNER  Recommended AWS account ID that owns S3_BUCKET
  AWS_REGION       AWS region for S3

Your MCP server keeps its existing code. No separate web app is required. Paid internal endpoints required.
Connect your MCP client at /mcp.
Local OAuth state is saved in .mcp-oauth-provider/ in the working directory.
Use --help or --version. Stop with Ctrl+C.
`;
async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return console.log(help);
  if (values.version)
    return console.log(
      JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version,
    );
  config = await readConfig();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void stop());
  console.log("Connecting to ngrok…");
  reservation = await reservePublicUrl(config);
  if (stopping) {
    await reservation.close();
    return;
  }
  const { issuer } = reservation;
  const gatewaySecret = randomBytes(32).toString("base64url");
  secrets.push(gatewaySecret);
  state = await openOAuthState(issuer, config.users, process.cwd(), config.storage);
  if (stopping) {
    await state.close();
    return;
  }
  const { jwks, kid, adapter, cookieKey } = state;
  servers = await startServers({ ...config, issuer, gatewaySecret, jwks, adapter, cookieKey });
  if (stopping) {
    await servers.close();
    return;
  }
  tunnels = await startTunnels({
    ...config,
    session: reservation.session,
    issuer,
    helperUrl: servers.helperUrl,
    mcpUrl: servers.mcpProxyUrl,
    mcpUpstreamUrl: config.mcpUrl,
    gatewaySecret,
    jwksUrl: `${issuer}/jwks?v=${kid}`,
  });
  if (stopping) {
    await tunnels.close();
    await servers.close();
    return;
  }
  const mcpUrl = new URL("/mcp", issuer);
  const rows = [
    ["MCP URL", mcpUrl.href],
    ["MCP Server URL", config.mcpUrl],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const valueWidth = Math.max(...rows.map(([, value]) => value.length));
  const border = `+${"-".repeat(labelWidth + 2)}+${"-".repeat(valueWidth + 2)}+`;
  const table = [
    border,
    ...rows.map(
      ([label, value]) => `| ${label.padEnd(labelWidth)} | ${value.padEnd(valueWidth)} |`,
    ),
    border,
  ].join("\n");
  const inspectorUrl = `https://dashboard.ngrok.com/traffic-inspector?filter=host:${encodeURIComponent(mcpUrl.hostname)}`;
  console.log(
    `\nMCP OAuth Provider is ready\n\n${table}\n\nView MCP Traffic Inspector: ${inspectorUrl}\n\nUse Ctrl+C to stop\n`,
  );
}
main().catch(async (error) => {
  await stop().catch(() => {});
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [...secrets, config?.authtoken]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  console.error(
    `\nMCP OAuth Provider could not start: ${message}\nCheck .env and your ngrok account permissions, then rerun. Use --help for settings.`,
  );
  process.exitCode = 1;
});
