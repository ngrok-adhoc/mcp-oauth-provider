#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

try {
  const [version, ...extra] = process.argv.slice(2);
  if (extra.length || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? ""))
    throw new Error("Usage: npm run tag-release -- major.minor.patch (explicit version required).");

  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  const branch = git("branch", "--show-current");
  if (branch !== "main")
    throw new Error(`Releases must be tagged from main (current: ${branch || "detached HEAD"}).`);
  if (git("status", "--porcelain", "--untracked-files=normal"))
    throw new Error("Commit or remove working tree changes before tagging a release.");
  if (JSON.parse(readFileSync("package.json", "utf8")).version !== version)
    throw new Error("The explicit release version must match the committed package.json version.");

  git("fetch", "origin", "main", "--tags");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main"))
    throw new Error("Local main must match origin/main before releasing.");
  const tag = `v${version}`;
  if (git("tag", "--list", tag) || git("ls-remote", "--tags", "origin", `refs/tags/${tag}`))
    throw new Error(`Tag ${tag} already exists; release tags are never overwritten.`);

  git("tag", "-a", tag, "-m", `MCP OAuth Provider ${version}`);
  git("push", "origin", `refs/tags/${tag}`);
  console.log(`Published ${tag}; check the Publish image workflow before using the image.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
