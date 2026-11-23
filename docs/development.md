# Develop and release

## Develop

```sh
npm ci
npm run check
```

Run `npm start` to build and launch the local checkout. The provider uses TypeScript and Hono on Node.js 26 or newer. Edit the consent template in `lib/consent-page.tsx` and its stylesheet in `assets/consent.css`.

For harmless manual fixtures, run `node test/fixtures/upstreams.js` and set `APP_URL=http://127.0.0.1:54831` and `MCP_SERVER_URL=http://127.0.0.1:54832/original-mcp`.

The package's `bin` entry is the CLI; tests exercise configuration, OAuth boundaries, forwarding and Traffic Policy generation. Public npm publication and binary distribution are separate future steps.

## Build the image locally

Build from `main` and tag the image name used by the tutorial:

```sh
git clone --branch main https://github.com/ngrok-adhoc/mcp-oauth-provider.git
cd mcp-oauth-provider
docker build --tag ghcr.io/ngrok-adhoc/mcp-oauth-provider:latest .
```

Then return to your separate consumer directory containing `.env` and the copied `compose.yaml`:

```sh
cd /path/to/mcp-demo
docker compose --env-file .env up -d --pull never
```

`--pull never` uses the locally built image. Make sure `python:3.13-slim` is available locally first (`docker pull python:3.13-slim`). This verifies the local build, not registry access.

## Publish a Docker release

Maintainers release from a clean `main` checkout matching `origin/main`, after the change has been reviewed and merged. Commit the intended version in `package.json` first, then supply that exact version:

```sh
npm run tag-release -- 0.1.0
```

The command creates an annotated `v0.1.0` tag without overwriting existing tags. Its push runs **Publish image**, publishing Linux amd64/arm64 images to `ghcr.io/ngrok-adhoc/mcp-oauth-provider` with `0.1.0`, `v0.1.0`, a commit SHA tag and `latest`. Main-branch builds only warm the build cache. Wait for the image workflow to succeed before updating tutorial image versions.

Package visibility is set in the GHCR package settings, not by the workflow. After a release, confirm an anonymous pull works with `docker logout ghcr.io && docker pull ghcr.io/ngrok-adhoc/mcp-oauth-provider:latest`.

If an automated release creates its tag using `GITHUB_TOKEN`, explicitly dispatch the publishing workflow at that tag because that token's tag push does not trigger another workflow:

```sh
gh workflow run publish-image.yml --ref v0.1.0
```

The workflow must already be on the default branch for dispatch. Retry a failed image build at the same tag; never overwrite the tag or create another version merely to retry a build.
