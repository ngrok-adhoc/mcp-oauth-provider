import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openOAuthState } from "../dist/lib/state.js";

test("OAuth state is private, Git-ignored, and recovers after a process is killed", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-state-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const issuer = "https://provider.example";
  const users = ["owner@example.com"];
  const moduleUrl = new URL("../dist/lib/state.js", import.meta.url);
  const child = (body) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { openOAuthState } from ${JSON.stringify(moduleUrl.href)};
         const state = await openOAuthState(${JSON.stringify(issuer)}, ${JSON.stringify(users)});
         ${body}`,
      ],
      { cwd, encoding: "utf8", timeout: 10000 },
    );
  const initial = await openOAuthState(issuer, users, cwd);
  const directory = join(cwd, ".mcp-oauth-provider");
  const snapshot = join(directory, "oauth.json");
  try {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["check-ignore", "-q", snapshot], { cwd });
    const blocked = child("await state.close();");
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /already locked/);
  } finally {
    await initial.close();
  }
  const crashed = child(`
    const sessions = state.adapter("Session");
    await sessions.upsert("session", { uid: "uid", accountId: "owner" }, 60);
    process.kill(process.pid, "SIGKILL");
  `);
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  // A lock left by a dead process on this host is cleared automatically.
  const recovered = await openOAuthState(issuer, users, cwd);
  try {
    assert.equal(recovered.kid, initial.kid);
    assert.deepEqual(await recovered.adapter("Session").findByUid("uid"), {
      uid: "uid",
      accountId: "owner",
    });
  } finally {
    await recovered.close();
  }
  // Locks from another host, or without a holder, may belong to a live provider.
  const lock = join(directory, ".lock");
  await mkdir(lock);
  await assert.rejects(() => openOAuthState(issuer, users, cwd), /already locked/);
  await writeFile(join(lock, "holder"), `other-host ${process.pid + 1}`);
  await assert.rejects(() => openOAuthState(issuer, users, cwd), /already locked/);
  // Same hostname in another PID namespace, such as a second container: its PIDs are not ours to check.
  await writeFile(join(lock, "holder"), `${hostname()}/pid:[1] 999999`);
  await assert.rejects(() => openOAuthState(issuer, users, cwd), /already locked/);
  await rm(lock, { recursive: true });

  const state = await openOAuthState(issuer, users, cwd);
  const pending = join(directory, ".oauth.json.tmp");
  await mkdir(pending);
  const unavailable = { statusCode: 503, error: "temporarily_unavailable" };
  try {
    await assert.rejects(
      state.adapter("Session").upsert("failed", { uid: "failed" }, 60),
      unavailable,
    );
    await assert.rejects(state.adapter("Session").find("session"), unavailable);
  } finally {
    await rmdir(pending);
    await state.close();
  }
  const beforeReset = await openOAuthState(issuer, users, cwd);
  try {
    assert.ok(await beforeReset.adapter("Session").find("session"));
    assert.equal(await beforeReset.adapter("Session").find("failed"), undefined);
  } finally {
    await beforeReset.close();
  }

  const changedIssuer = await openOAuthState("https://replacement.example", users, cwd);
  try {
    assert.notEqual(changedIssuer.kid, initial.kid);
    assert.equal(await changedIssuer.adapter("Session").find("session"), undefined);
  } finally {
    await changedIssuer.close();
  }

  await writeFile(snapshot, "{invalid");
  await assert.rejects(() => openOAuthState(issuer, users, cwd), /Cannot read OAuth state/);
  assert.equal(await readFile(snapshot, "utf8"), "{invalid");
  await chmod(snapshot, 0o644);
  await assert.rejects(() => openOAuthState(issuer, users, cwd), /state file must be.*private/);
  await chmod(snapshot, 0o600);
  const renamed = join(directory, "renamed.json");
  await rename(snapshot, renamed);
  await symlink(renamed, snapshot);
  await assert.rejects(() => openOAuthState(issuer, users, cwd), /state file must be.*private/);
});

test("S3 stores OAuth state directly and rejects stale and failed writes", async (t) => {
  const diagnostics = t.mock.method(console, "error", () => {});
  const { createHash } = await import("node:crypto");
  const { once } = await import("node:events");
  const { createServer } = await import("node:http");
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-s3-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let snapshot;
  let etag;
  let unavailable = false;
  const calls = [];
  const server = createServer(async (req, res) => {
    assert.equal(new URL(req.url, "http://localhost").pathname, "/fixture-bucket/provider.json");
    calls.push(req.method);
    if (req.method === "GET") {
      if (snapshot) return res.writeHead(200, { etag }).end(snapshot);
      return res
        .writeHead(404, { "content-type": "application/xml" })
        .end("<Error><Code>NoSuchKey</Code><Message>Missing key</Message></Error>");
    }
    assert.equal(req.method, "PUT");
    let body = "";
    for await (const chunk of req) body += chunk;
    if (unavailable) return res.writeHead(503).end();
    if (etag ? req.headers["if-match"] !== etag : req.headers["if-none-match"] !== "*") {
      return res
        .writeHead(412, { "content-type": "application/xml" })
        .end("<Error><Code>PreconditionFailed</Code><Message>Stale write</Message></Error>");
    }
    snapshot = body;
    etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    res.writeHead(200, { etag }).end();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const endpoint = process.env.AWS_ENDPOINT_URL_S3;
  process.env.AWS_ENDPOINT_URL_S3 = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    if (endpoint === undefined) delete process.env.AWS_ENDPOINT_URL_S3;
    else process.env.AWS_ENDPOINT_URL_S3 = endpoint;
  });

  const issuer = "https://provider.example";
  const users = ["owner@example.com"];
  const s3 = {
    bucket: "fixture-bucket",
    key: "provider.json",
    required: true,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  };
  const first = await openOAuthState(issuer, users, cwd, s3);
  t.after(() => first.close());
  assert.deepEqual(calls, ["GET", "PUT"]);
  const records = first.adapter("Session");
  await Promise.all([records.upsert("a", { uid: "a" }, 60), records.upsert("b", { uid: "b" }, 60)]);
  assert.equal(JSON.parse(snapshot).records.length, 2);

  const second = await openOAuthState(issuer, users, cwd, s3);
  t.after(() => second.close());
  assert.equal(first.kid, second.kid);
  const storageError = { statusCode: 503, error: "temporarily_unavailable" };
  await assert.rejects(records.upsert("stale", { uid: "stale" }, 60), storageError);
  assert.match(diagnostics.mock.calls[0].arguments[0], /changed in S3/);
  assert.deepEqual(await second.adapter("Session").findByUid("a"), { uid: "a" });
  assert.equal(await second.adapter("Session").find("stale"), undefined);

  unavailable = true;
  await assert.rejects(second.adapter("Session").upsert("lost", { uid: "lost" }, 60), storageError);
  await assert.rejects(second.adapter("Session").find("a"), storageError);
  assert.equal(diagnostics.mock.callCount(), 2);
  assert.match(diagnostics.mock.calls[1].arguments[0], /Cannot save OAuth state to s3.*restart/);
  assert.equal(JSON.parse(snapshot).records.length, 2);
  await assert.rejects(stat(join(cwd, ".mcp-oauth-provider")), { code: "ENOENT" });

  unavailable = false;
  const changed = await openOAuthState(issuer, ["new@example.com"], cwd, s3);
  t.after(() => changed.close());
  assert.notEqual(changed.kid, first.kid);
  assert.equal(await changed.adapter("Session").find("a"), undefined);
});

test("registration evicts only clients without live grants", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-registration-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const issuer = "https://provider.example";
  const users = ["owner@example.com"];
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  await (await openOAuthState(issuer, users, cwd)).close();
  const filename = join(cwd, ".mcp-oauth-provider", "oauth.json");
  const snapshot = JSON.parse(await readFile(filename, "utf8"));
  const soon = Math.floor(now / 1000) + 60;
  for (let id = 0; id < 1000; id++) {
    const clientId = String(id);
    snapshot.records.push(
      { model: "Client", id: clientId, payload: { client_id: clientId } },
      { model: "Grant", id: clientId, payload: { clientId }, expires: id === 1 ? soon - 61 : soon },
    );
  }
  await writeFile(filename, JSON.stringify(snapshot));
  const state = await openOAuthState(issuer, users, cwd);
  try {
    const clients = state.adapter("Client");
    await clients.upsert("new", { client_id: "new" });
    assert.ok(await clients.find("0"));
    assert.equal(await clients.find("1"), undefined);
    await state.adapter("Grant").upsert("new", { clientId: "new" }, 60);
    const beforeRejection = await readFile(filename, "utf8");
    await assert.rejects(clients.upsert("extra", { client_id: "extra" }), {
      statusCode: 503,
      error_description: "OAuth client registration capacity is full.",
    });
    assert.equal(await readFile(filename, "utf8"), beforeRejection);
    await state.adapter("Grant").destroy("0");
    await clients.upsert("extra", { client_id: "extra" });
    assert.equal(await clients.find("0"), undefined);
    assert.ok(await clients.find("extra"));
  } finally {
    await state.close();
  }
});

test("automatic S3 falls back without credentials and required S3 fails closed", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-s3-credentials-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = new URL("../dist/lib/state.js", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { stat } from "node:fs/promises";
      import { openOAuthState } from ${JSON.stringify(source.href)};
      const issuer = "https://provider.example";
      const users = ["owner@example.com"];
      const options = {bucket:"fixture-bucket", key:"provider.json", region:"us-east-1"};
      await assert.rejects(
        openOAuthState(issuer, users, process.cwd(), {...options, required:true}),
        /Cannot resolve AWS credentials/,
      );
      await assert.rejects(stat(".mcp-oauth-provider"), {code:"ENOENT"});
      const local = await openOAuthState(issuer, users, process.cwd(), {...options, required:false});
      await local.close();
      assert.ok(await stat(".mcp-oauth-provider/oauth.json"));
    `,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 10000,
      env: {
        HOME: cwd,
        USERPROFILE: cwd,
        AWS_CONFIG_FILE: join(cwd, "aws-config"),
        AWS_SHARED_CREDENTIALS_FILE: join(cwd, "aws-credentials"),
        AWS_EC2_METADATA_DISABLED: "true",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

test("anonymous authorization requests do not write OAuth state", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-oauth-interactions-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const state = await openOAuthState("https://provider.example", ["owner@example.com"], cwd);
  try {
    const filename = join(cwd, ".mcp-oauth-provider", "oauth.json");
    const before = await readFile(filename, "utf8");
    const interactions = state.adapter("Interaction");
    await interactions.upsert("uid", { uid: "uid", params: {} }, 60);
    assert.deepEqual(await interactions.find("uid"), { uid: "uid", params: {} });
    assert.equal(await readFile(filename, "utf8"), before);
    await interactions.destroy("uid");
    assert.equal(await interactions.find("uid"), undefined);
  } finally {
    await state.close();
  }
});
