#!/usr/bin/env bash
set -euo pipefail

tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"

npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund "$tarball"
npm audit --audit-level=low

if [[ ${2:-} != --audit-only ]]; then
  npm rebuild
  version=$(node -p 'require("./node_modules/mcp-oauth-provider/package.json").version')
  test "$(./node_modules/.bin/mcp-oauth-provider --version)" = "$version"
  ./node_modules/.bin/mcp-oauth-provider --help
  node -e 'require("@ngrok/ngrok"); console.log("Native ngrok SDK loaded")'
fi
