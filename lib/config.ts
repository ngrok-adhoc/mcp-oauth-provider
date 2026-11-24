import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { RE2JS } from "re2js";

import type { S3Storage } from "./state-storage.js";

export type AccessEntry = string | { regex: string };

function readUsers(value?: string): AccessEntry[] {
  const invalid = () =>
    new Error("Set USERS to a JSON array of email addresses or /regex/ strings.");
  let entries: unknown;
  try {
    entries = JSON.parse(value ?? "[]");
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(entries) ||
    !entries.every((entry): entry is string => typeof entry === "string")
  )
    throw invalid();
  if (!entries.length) throw new Error("Set at least one entry in USERS.");

  return [...new Set(entries.map((entry) => entry.trim()))].map((entry) => {
    const pattern = entry.slice(1, -1);
    if (entry.startsWith("/") && entry.endsWith("/") && pattern.trim()) {
      const regex = `\\A(?:${pattern})\\z`;
      try {
        RE2JS.compile(pattern);
        RE2JS.compile(regex);
      } catch {
        throw new Error("Set USERS regex entries to valid RE2 patterns delimited by slashes.");
      }
      return { regex };
    }
    if (!/^[^\s@,*]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(entry) || entry.startsWith("/"))
      throw invalid();
    return entry.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  });
}

function hasSvgRoot(source: string) {
  let contents = source
    .trimStart()
    .replace(/^<\?xml[^>]*\?>/, "")
    .trimStart();
  while (contents.startsWith("<!--")) {
    const end = contents.indexOf("-->", 4);
    if (end === -1) return false;
    contents = contents.slice(end + 3).trimStart();
  }
  return /^<svg[\s>]/.test(contents);
}

async function readIcon(setting: string | undefined, cwd: string) {
  if (!setting) return undefined;
  const url = isAbsolute(setting) ? null : URL.parse(setting);
  if (url && url.protocol !== "file:") {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname)
    )
      throw new Error(
        "Set MCP_SERVER_ICON to a local image or an HTTPS image URL without credentials.",
      );
    return url;
  }

  const maxBytes = 256 * 1024;
  let bytes;
  try {
    const path = url ? fileURLToPath(url) : resolve(cwd, setting);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error();
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new Error();
      bytes = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("Set MCP_SERVER_ICON to a readable local image of at most 256 KiB.");
  }
  const header = bytes.subarray(0, 12).toString("latin1");
  let mime;
  if (header.startsWith("\x89PNG\r\n\x1a\n")) mime = "png";
  else if (header.startsWith("\xff\xd8\xff")) mime = "jpeg";
  else if (/^GIF8[79]a/.test(header)) mime = "gif";
  else if (header.startsWith("RIFF") && header.endsWith("WEBP")) mime = "webp";
  else if (hasSvgRoot(bytes.toString("utf8"))) mime = "svg+xml";
  if (!mime) throw new Error("MCP_SERVER_ICON must be a PNG, JPEG, GIF, WebP, or SVG image.");
  return new URL(`data:image/${mime};base64,${bytes.toString("base64")}`);
}

function readStorage(values: NodeJS.ProcessEnv): S3Storage | undefined {
  const mode = values.STORAGE?.trim();
  if (mode && mode !== "local" && mode !== "s3") throw new Error("Set STORAGE to local or s3.");
  if (mode === "local") return;
  const bucket = values.S3_BUCKET?.trim();
  if (!bucket) {
    if (mode === "s3") throw new Error("Set S3_BUCKET when STORAGE=s3.");
    return;
  }
  const {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    AWS_SESSION_TOKEN: sessionToken,
  } = values;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
    throw new Error(
      "Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or use the AWS credential chain.",
    );
  const owner = values.S3_BUCKET_OWNER?.trim() || undefined;
  if (owner && !/^\d{12}$/.test(owner))
    throw new Error("Set S3_BUCKET_OWNER to the 12-digit AWS account ID that owns S3_BUCKET.");
  return {
    bucket,
    owner,
    key: values.S3_KEY?.trim() || "mcp-oauth-provider/oauth.json",
    region: values.AWS_REGION?.trim() || undefined,
    profile: values.AWS_PROFILE?.trim() || undefined,
    credentials:
      accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, sessionToken } : undefined,
    required: mode === "s3",
  };
}

function readRequestsPerMinute(values: NodeJS.ProcessEnv, name: string) {
  const value = values[name]?.trim();
  if (!value) return undefined;
  const capacity = Number(value);
  if (!/^\d+$/.test(value) || capacity < 1 || capacity > 2_000_000_000)
    throw new Error(`Set ${name} to an integer from 1 to 2000000000.`);
  return capacity;
}

export async function readConfig({ cwd = process.cwd(), env = process.env } = {}) {
  let local: NodeJS.ProcessEnv = {};
  try {
    local = parseEnv(await readFile(resolve(cwd, ".env"), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new Error(
        `Cannot read .env: ${error instanceof Error ? error.message : String(error)}`,
      );
  }
  const values = { ...local, ...env };
  const users = readUsers(values.USERS);
  const authtoken = values.NGROK_AUTHTOKEN?.trim();
  if (!authtoken || /\s/.test(authtoken))
    throw new Error("Set NGROK_AUTHTOKEN in .env using your ngrok agent authtoken.");
  if (!values.MCP_SERVER_URL?.trim())
    throw new Error("Set MCP_SERVER_URL to your existing HTTP(S) MCP endpoint.");
  const upstream = (name: string, originOnly = false) => {
    let url;
    try {
      url = new URL(values[name] ?? "");
    } catch {
      throw new Error(`${name} must be an HTTP(S) URL.`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (originOnly && url.pathname !== "/")
    )
      throw new Error(
        `${name} must be an HTTP(S) ${originOnly ? "origin" : "URL"} without credentials, query or fragment.`,
      );
    return url.href;
  };
  let publicUrl;
  if (values.NGROK_URL) {
    let url;
    try {
      url = new URL(values.NGROK_URL);
    } catch {
      throw new Error("NGROK_URL must be an HTTPS origin.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("NGROK_URL must be an HTTPS origin without a path.");
    publicUrl = url.origin;
  }
  const mcpUrl = new URL(upstream("MCP_SERVER_URL"));
  const mcpBinding = values.MCP_SERVER_BINDING?.trim();
  if (mcpBinding && mcpBinding !== "internal")
    throw new Error("MCP_SERVER_BINDING must be internal or unset.");
  if (mcpBinding && (!mcpUrl.hostname.endsWith(".internal") || mcpUrl.pathname !== "/mcp"))
    throw new Error(
      "With MCP_SERVER_BINDING=internal, set MCP_SERVER_URL to an ngrok .internal URL ending in /mcp.",
    );
  return {
    users,
    oauthRequestsPerMinute: readRequestsPerMinute(values, "OAUTH_REQUESTS_PER_MINUTE"),
    mcpRequestsPerMinute: readRequestsPerMinute(values, "MCP_REQUESTS_PER_MINUTE"),
    storage: readStorage(values),
    claudeCimd: values.CLAUDE_CIMD === "1",
    mcpServerName: values.MCP_SERVER_NAME?.trim() || undefined,
    mcpServerIcon: await readIcon(values.MCP_SERVER_ICON?.trim(), cwd),
    authtoken,
    publicUrl,
    appUrl: values.APP_URL ? upstream("APP_URL", true) : undefined,
    mcpUrl: mcpUrl.href,
    internalMcpOrigin: mcpBinding ? mcpUrl.origin : undefined,
  };
}
