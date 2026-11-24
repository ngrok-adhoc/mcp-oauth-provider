#!/usr/bin/env bash
set -euo pipefail

image=$1
version=$2
test "$(docker run --rm --network none "$image" --version)" = "$version"
docker run --rm --network none "$image" --help
docker run --rm --network none --entrypoint node "$image" -e '
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  assert.equal(process.getuid(), 1000);
  assert.ok(Number(process.versions.node.split(".")[0]) >= 26);
  fs.accessSync("assets/consent.css", fs.constants.R_OK);
  fs.accessSync("assets/mcp-icon.svg", fs.constants.R_OK);
  fs.accessSync(".mcp-oauth-provider", fs.constants.W_OK);
  require("@ngrok/ngrok");
'
