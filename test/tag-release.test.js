import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/tag-release.js", import.meta.url);

test("release tags require an explicit version and clean synchronized main, and cannot overwrite", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  const checkout = join(directory, "checkout");
  const git = (...args) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8", stdio: "pipe" }).trim();
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  mkdirSync(checkout);
  git("init", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  mkdirSync(join(checkout, "scripts"));
  copyFileSync(script, join(checkout, "scripts/tag-release.js"));
  writeFileSync(join(checkout, "package.json"), '{"version":"0.1.0"}\n');
  git("add", ".");
  git("commit", "-m", "Fixture");
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  const release = (...args) =>
    spawnSync(process.execPath, [join(checkout, "scripts/tag-release.js"), ...args], {
      cwd: directory,
      encoding: "utf8",
    });
  const denied = (args, message) => {
    const result = release(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(git("ls-remote", "--tags", "origin"), "");
  };

  denied([], /explicit version required/);
  denied(["01.2.3"], /explicit version required/);
  denied(["0.1.0", "extra"], /explicit version required/);
  git("checkout", "-b", "feature");
  denied(["0.1.0"], /must be tagged from main/);
  git("checkout", "main");
  writeFileSync(join(checkout, "untracked.txt"), "not committed");
  denied(["0.1.0"], /working tree changes/);
  rmSync(join(checkout, "untracked.txt"));
  denied(["0.2.0"], /must match the committed package.json/);
  writeFileSync(join(checkout, "ahead.txt"), "local commit");
  git("add", ".");
  git("commit", "-m", "Ahead of origin");
  denied(["0.1.0"], /main must match origin\/main/);
  git("push", "origin", "main");

  const success = release("0.1.0");
  assert.equal(success.status, 0, success.stderr);
  assert.equal(git("cat-file", "-t", "v0.1.0"), "tag");
  const original = git("ls-remote", "--tags", "origin", "refs/tags/v0.1.0");
  assert.ok(original);
  const duplicate = release("0.1.0");
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);
  assert.equal(git("ls-remote", "--tags", "origin", "refs/tags/v0.1.0"), original);
});
