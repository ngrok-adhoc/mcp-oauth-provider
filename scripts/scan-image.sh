#!/usr/bin/env bash
set -euo pipefail

docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v mcp-oauth-trivy-cache:/root/.cache/trivy \
  aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb \
  image --quiet --image-src docker --scanners vuln --exit-code 1 --table-mode detailed "$1"
