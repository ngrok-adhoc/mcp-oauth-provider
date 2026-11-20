import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readConfig } from "../dist/lib/config.js";

test("working-directory .env, environment precedence and URL boundaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-config-"));
  try {
    await writeFile(
      join(cwd, ".env"),
      'USERS=["Owner@example.com"]\nNGROK_AUTHTOKEN=fixture\nAPP_URL=http://localhost:4321\nMCP_SERVER_URL=http://localhost:4322/custom-mcp\n',
    );
    const config = await readConfig({ cwd, env: { APP_URL: "http://127.0.0.1:5000" } });
    assert.deepEqual(config.users, ["owner@example.com"]);
    assert.equal(config.appUrl, "http://127.0.0.1:5000/");
    assert.equal(config.mcpUrl, "http://localhost:4322/custom-mcp");
    assert.equal(config.publicUrl, undefined);
    assert.equal(config.claudeCimd, false);
    assert.equal(config.mcpServerName, undefined);
    assert.equal(config.mcpServerIcon, undefined);
    const branded = await readConfig({
      cwd,
      env: {
        CLAUDE_CIMD: "1",
        MCP_SERVER_NAME: " Bowie ",
        MCP_SERVER_ICON: "https://images.example.com/bowie.png",
      },
    });
    assert.equal(branded.claudeCimd, true);
    assert.equal(branded.mcpServerName, "Bowie");
    assert.equal(branded.mcpServerIcon.href, "https://images.example.com/bowie.png");
    const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
    const iconPath = join(cwd, "Bowie icon.svg");
    await writeFile(iconPath, icon);
    for (const ref of ["./Bowie icon.svg", iconPath, pathToFileURL(iconPath).href]) {
      const local = await readConfig({ cwd, env: { MCP_SERVER_ICON: ref } });
      assert.equal(
        local.mcpServerIcon.href,
        `data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}`,
      );
    }
    await writeFile(join(cwd, "invalid.png"), "not an image");
    await writeFile(join(cwd, "large.svg"), Buffer.alloc(256 * 1024 + 1));
    for (const env of [
      { APP_URL: "not a URL" },
      { APP_URL: "ftp://app:3000" },
      { APP_URL: "http://app:3000/path" },
      { APP_URL: "http://app:3000/?query=secret" },
      { MCP_SERVER_URL: "file:///mcp" },
      { MCP_SERVER_URL: "http://mcp:8000/mcp?secret=value" },
      { MCP_SERVER_URL: "http://mcp:8000/mcp#fragment" },
      { MCP_SERVER_URL: "http://x:y@localhost/mcp" },
      { NGROK_URL: "https://example.com/path" },
      { MCP_SERVER_ICON: "http://example.com/icon.png" },
      { MCP_SERVER_ICON: "https://user:secret@example.com/icon.png" },
      { MCP_SERVER_ICON: "https://example.com;img-src/icon.png" },
      { MCP_SERVER_ICON: "data:image/svg+xml,logo" },
      { MCP_SERVER_ICON: "./invalid.png" },
      { MCP_SERVER_ICON: "./large.svg" },
      { MCP_SERVER_ICON: "./missing.png" },
      { USERS: "" },
      { NGROK_AUTHTOKEN: "" },
    ]) {
      await assert.rejects(readConfig({ cwd, env }));
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("startup requires an explicit MCP_SERVER_URL before connecting to ngrok", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-missing-upstream-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../dist/bin/mcp-oauth-provider.js", import.meta.url));
  const env = {
    USERS: '["owner@example.com"]',
    NGROK_AUTHTOKEN: "fixture",
    MCP_URL: "https://public.ngrok.app/mcp",
    APP_URL: "http://app:3000",
  };
  const result = spawnSync(process.execPath, [cli], { cwd, env, encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Set MCP_SERVER_URL/);
  assert.equal(result.stdout, "");
  for (const value of ["", "   "]) {
    await assert.rejects(
      readConfig({ cwd, env: { ...env, MCP_SERVER_URL: value } }),
      /MCP_SERVER_URL/,
    );
  }
});

test("trusted configured upstreams support Docker host names and service DNS", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-container-config-"));
  const credentials = { USERS: '["owner@example.com"]', NGROK_AUTHTOKEN: "fixture" };
  try {
    for (const [appUrl, mcpUrl] of [
      ["http://host.docker.internal:3000", "http://host.docker.internal:3001/mcp"],
      ["http://app:3000", "http://mcp:8000/custom-mcp"],
      ["https://app.internal", "https://mcp.internal/mcp"],
    ]) {
      const config = await readConfig({
        cwd,
        env: { ...credentials, APP_URL: appUrl, MCP_SERVER_URL: mcpUrl },
      });
      assert.equal(config.appUrl, new URL(appUrl).href);
      assert.equal(config.mcpUrl, mcpUrl);
      assert.equal(config.internalMcpOrigin, undefined);
    }
    const env = { ...credentials, MCP_SERVER_BINDING: "internal" };
    const internal = await readConfig({
      cwd,
      env: { ...env, MCP_SERVER_URL: "https://bowie.internal/mcp" },
    });
    assert.equal(internal.internalMcpOrigin, "https://bowie.internal");
    for (const url of ["http://bowie:3001/mcp", "https://bowie.internal/custom-mcp"])
      await assert.rejects(
        readConfig({ cwd, env: { ...env, MCP_SERVER_URL: url } }),
        /MCP_SERVER_BINDING/,
      );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("access lists accept JSON email strings and slash-delimited RE2 patterns", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-access-config-"));
  const credentials = {
    USERS: '["admin@example.com"]',
    NGROK_AUTHTOKEN: "fixture",
    MCP_SERVER_URL: "http://localhost:3001/mcp",
  };
  try {
    const config = await readConfig({
      cwd,
      env: {
        ...credentials,
        USERS: JSON.stringify([
          " Guest@Example.com ",
          "/[^@]+@example\\.org/",
          " Guest@Example.com ",
        ]),
      },
    });
    assert.deepEqual(config.users, [
      "guest@example.com",
      { regex: "\\A(?:[^@]+@example\\.org)\\z" },
    ]);
    await assert.rejects(readConfig({ cwd, env: { ...credentials, USERS: "[]" } }), /USERS/);
    await assert.rejects(readConfig({ cwd, env: { NGROK_AUTHTOKEN: "fixture" } }), /USERS/);
    for (const value of [
      "guest@example.com",
      "null",
      "{}",
      '[""]',
      "[42]",
      '[{"regex":"abc"}]',
      JSON.stringify(["a@@example.com"]),
      JSON.stringify(["*@example.com"]),
      JSON.stringify(["/unterminated"]),
      JSON.stringify(["//"]),
      JSON.stringify(["/[/"]),
      JSON.stringify(["/a(?=b)/"]),
      JSON.stringify(["/(a)\\1/"]),
      JSON.stringify(["/a)|(?:b/"]),
    ]) {
      await assert.rejects(readConfig({ cwd, env: { ...credentials, USERS: value } }), /USERS/);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("storage mode selects local JSON, automatic S3, or required S3", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-storage-config-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const base = {
    USERS: '["owner@example.com"]',
    NGROK_AUTHTOKEN: "fixture",
    MCP_SERVER_URL: "http://localhost:3001/mcp",
  };
  const env = { ...base, S3_BUCKET: "private-bucket", AWS_REGION: "us-east-1" };
  assert.equal((await readConfig({ cwd, env: base })).storage, undefined);
  assert.equal((await readConfig({ cwd, env: { ...env, STORAGE: "local" } })).storage, undefined);
  assert.equal((await readConfig({ cwd, env })).storage.required, false);
  const s3 = await readConfig({
    cwd,
    env: {
      ...env,
      STORAGE: "s3",
      S3_KEY: "custom.json",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
    },
  });
  assert.equal(s3.storage.required, true);
  assert.equal(s3.storage.owner, undefined);
  const pinned = await readConfig({ cwd, env: { ...env, S3_BUCKET_OWNER: "123456789012" } });
  assert.equal(pinned.storage.owner, "123456789012");
  await assert.rejects(
    readConfig({ cwd, env: { ...env, S3_BUCKET_OWNER: "my-account" } }),
    /S3_BUCKET_OWNER/,
  );
  assert.equal(s3.storage.key, "custom.json");
  assert.equal(s3.storage.region, "us-east-1");
  assert.deepEqual(s3.storage.credentials, {
    accessKeyId: "test",
    secretAccessKey: "test",
    sessionToken: undefined,
  });
  await assert.rejects(readConfig({ cwd, env: { ...base, STORAGE: "s3" } }), /S3_BUCKET/);
  await assert.rejects(
    readConfig({ cwd, env: { ...env, AWS_ACCESS_KEY_ID: "partial" } }),
    /Set both/,
  );
  await assert.rejects(readConfig({ cwd, env: { ...env, STORAGE: "invalid" } }), /local or s3/);
});
