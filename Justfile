_default:
    @just --list
    

build: node-build docker-build
node-build:
  npm run build

docker-build:
  docker build -t ghcr.io/ngrok-adhoc/mcp-oauth-provider:latest .