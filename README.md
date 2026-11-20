# MCP OAuth Provider

Connect an existing local HTTP MCP server through ngrok-managed Google sign-in, without changing the server. Connect Codex or another OAuth-capable MCP client at `/mcp`. No sample app or separate web app is required.

This is a lightweight developer tool: ngrok Traffic Policy handles access checks and routing; the provider handles OAuth registration, consent and tokens.

[Run with npx from Git](#run-with-npx), or use Docker with the [Compose tutorial](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/python.md).

## Run with npx

Start with your existing HTTP MCP server. Set its upstream URL below; the provider adds OAuth without changing the server’s code or tools.

Requires **Node.js 26+**, npm/npx, Git, and an ngrok account with paid internal endpoints and the required Traffic Policy actions. No separate ngrok executable, Google Cloud project or custom OAuth application is needed.

Run directly from the repository’s `main` branch with `npx`; no manual clone, packaging or npm publication is needed. Start in your MCP server’s project directory:

```sh
cd /path/to/your/mcp-server
```

Add these settings to that directory's `.env`:

```dotenv
NGROK_AUTHTOKEN=your_ngrok_agent_authtoken
USERS='["you@example.com"]'
# Your existing server’s HTTP MCP endpoint, including its path.
MCP_SERVER_URL=http://127.0.0.1:3001/mcp
```

Keep `.env` out of Git. Use your **agent authtoken**, not an ngrok API key. The SDK needs this value even if the ngrok CLI is already signed in.

Start your MCP server as usual, then run:

```sh
npx --yes \
  --package=git+https://github.com/ngrok-adhoc/mcp-oauth-provider.git#main \
  mcp-oauth-provider
```

`npx` fetches the package from GitHub and installs its dependencies in npm’s cache; your MCP server needs no package changes.

Replace `#main` with a release tag or commit SHA to pin a revision.

The command prints the public **MCP URL**, the upstream **MCP Server URL**, and a Traffic Inspector link filtered to the public host. Add the public `/mcp` URL to your OAuth-capable MCP client, sign in with the configured Google account, and approve access. Press **Ctrl+C** to stop the provider. Your MCP server and any optional web app keep running.

`MCP_SERVER_URL` is required. If it is unset or blank, the provider exits before opening any listeners or connecting to ngrok. If you also have a web app, set `APP_URL` to its origin:

```dotenv
# Optional web app; not needed for MCP connections.
APP_URL=http://127.0.0.1:3000
# Optional; omit to let ngrok allocate the public URL.
# NGROK_URL=https://your-assigned-dev-domain.ngrok-free.app
```

Upstreams are trusted HTTP(S) URLs from your `.env` or environment. Use loopback addresses locally, or host/service names on a private Docker network; never accept these settings from a public request. `APP_URL` is an origin; `MCP_SERVER_URL` includes the existing MCP path. The `APP_URL` website shares the public origin with the OAuth sign-in and consent pages, so only forward a website whose scripts you fully trust. `NGROK_URL`, when set, is an HTTPS origin available to your account. A dev-domain name does not make the required paid actions free.

If the MCP server uses an ngrok internal endpoint in the same account, set `MCP_SERVER_BINDING=internal` and use its `.internal` URL ending in `/mcp` for `MCP_SERVER_URL`. The gateway forwards authenticated requests to that endpoint. If the upstream checks the HTTP Host header, allow the public provider hostname.

The provider reads `.env` from the **working directory**. Existing environment variables take precedence over `.env` for each setting. If you previously configured an upstream using `MCP_URL`, rename that setting to `MCP_SERVER_URL`. Use `--help` for settings or `--version` for the package version.

## Keep OAuth connections across restarts

Set `NGROK_URL` to a fixed HTTPS origin and always launch the provider from the same project directory. The provider stores its signing keys, OAuth registrations, browser sessions, and grants in `.mcp-oauth-provider/oauth.json`. It creates the directory with owner-only access and a Git ignore rule. Keep the directory private and use one provider process per state directory. Use Docker on Windows.

The provider saves each change with an atomic file replacement. The `.lock` directory records the machine and process that hold it. A lock left by a provider process that has exited on the same machine is cleared automatically. Containers can't check each other's processes, so after a container is killed, confirm no other provider uses the volume and remove the lock by hand, for example `docker compose run --rm --entrypoint rm provider -rf /app/.mcp-oauth-provider/.lock`. Run one provider per state directory.

If a storage write fails, OAuth operations return a temporary service error. Check the provider logs, restore access to the state store, and restart the provider.

The Compose example sets `STORAGE=local` and mounts a named volume at `/app/.mcp-oauth-provider`. Keep that volume when replacing the container. If the public origin or the `USERS` allowlist changes, the provider clears stored authorizations and rotates its signing keys at startup. Clients then need to sign in again.

### Store OAuth state in S3

Set these environment variables for a deployment that should read and write the snapshot directly in S3.

```dotenv
STORAGE=s3
AWS_REGION=ap-southeast-2
S3_BUCKET=your-private-bucket
S3_KEY=mcp-oauth-provider/oauth.json
# Recommended: the 12-digit AWS account ID that owns the bucket.
S3_BUCKET_OWNER=123456789012
```

Use the AWS SDK's standard credential chain, such as the deployment's IAM role or the `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN` environment variables. Use a private bucket and a separate key per provider. The snapshot contains private signing keys and live OAuth credentials. Set `S3_BUCKET_OWNER` so S3 rejects reads and writes if the bucket name ever belongs to another account, for example after a typo or a deleted bucket. Grant `s3:GetObject` and `s3:PutObject` on the state object. For the first startup with an absent object, allow `s3:ListBucket` so S3 can report that the key does not exist.

With `STORAGE=s3`, startup fails if the provider cannot access S3. With `STORAGE` omitted, the provider uses S3 when it has a bucket and AWS credentials and otherwise uses local JSON. Set `STORAGE=local` to always use the filesystem. S3 mode writes directly to the object and requires no local state volume. Run a single provider instance per object. A second provider with the same `NGROK_URL` exits before it reads or writes state, and conditional writes prevent a stale instance from overwriting newer state.

## Connect Codex and call a tool

Replace `https://your-ngrok-host/mcp` with the **MCP URL** printed by the provider. It uses `/mcp` on your `NGROK_URL` or the public origin ngrok allocates at startup.

```sh
codex mcp add my-server --url https://your-ngrok-host/mcp
codex mcp login my-server
codex
```

Sign in with a Google account in `USERS` and approve the connection. Ask Codex to list the tools from `my-server`, then call one of your server’s tools. Approve the tool call if prompted and verify its actual result.

The upstream must accept HTTP MCP requests without a separate bearer token. This provider removes its access token before forwarding; it does not sign in to another OAuth-protected MCP service. Stdio servers need an HTTP transport before they can be used here.

## Share with your company

Set `USERS` in `.env` to a nonempty JSON array of allowed Google emails or patterns.

```dotenv
USERS='["you@example.com","guest@example.com","/[^@]+@example\\.org/"]'
```

Use an exact email or wrap a regular expression in `/…/`. The provider compares against the whole Google email after lowercasing its ASCII letters. Write regexes in RE2 syntax and escape backslashes for JSON, as in the domain pattern above. That pattern matches `someone@example.org`.

A domain pattern matches any Google account using that email address, including personal Google accounts created with a work address. ngrok does not expose Google's hosted-domain claim, so list exact emails when that matters.

All admitted accounts get the same tool permissions. The provider uses a shared account internally and forwards MCP requests to the upstream without the Google identity.

The allowlist is checked during sign-in. Restart the provider after editing it to apply the new list and invalidate existing connections.

For Docker Compose, pass `USERS` through the provider service's `environment` block.

## Brand the consent page

Set either of these in the provider's `.env` and restart the provider.

```dotenv
MCP_SERVER_NAME=Bowie
MCP_SERVER_ICON=./bowie.png
```

The name appears in the consent page title and heading. A 100 × 100 pixel icon sits above the heading. The page uses the bundled MCP logo when no custom icon is set. Set `MCP_SERVER_ICON` to an absolute path, a path relative to the provider's working directory, a `file:` URL, or a direct HTTPS image URL that users' browsers can reach. Local PNG, JPEG, GIF, WebP and SVG files up to 256 KiB are embedded in the consent page. With no branding settings, the page uses the generic provider name. For Docker Compose, put these settings in the provider service's `environment` block.

## Client compatibility

Checked against official client documentation on **19 November 2026**. Use public-client dynamic registration (DCR), authorization code + PKCE (`S256`), and the public HTTPS `/mcp` URL. The provider advertises only token authentication method `none`, requires no client secret, and issues rotating refresh tokens for clients registered with the `refresh_token` grant. No `offline_access` scope is required or advertised.

| Client / surface    | Documented OAuth behavior and provider fit                                                                                                                                             | Verification performed here                                                                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI           | Uses DCR by default and its published identity when CIMD is enabled. Loopback callbacks, issuer identification, scoped access and refresh tokens fit the provider.                     | Actual **0.169.0** CLI discovered a temporary local provider, registered successfully (`201`, `native`, `none`, authorization-code + refresh grants), and reached authorization with `http://127.0.0.1:<port>/callback`. Provider tests cover consent, PKCE, tokens and refresh. Browser/Google/ngrok/tool-call flow not completed. |
| Claude Code CLI     | Supports automatic DCR and loopback callbacks. Current versions use `http://localhost:<port>/callback`; the provider also accepts the `127.0.0.1` form used by other versions.         | Actual **2.1.325** CLI discovered a temporary local provider, registered successfully with the same public-client grants, and reached authorization with a localhost callback. Provider tests cover consent, PKCE, tokens and refresh. Browser/Google/ngrok/tool-call flow not completed.                                           |
| Claude web / iOS    | Supports automatic DCR and opt-in Claude published identity. Both use `https://claude.ai/api/mcp/auth_callback`.                                                                       | Provider tests cover both registration modes, consent, PKCE, token exchange and refresh. A live iOS tool call is pending.                                                                                                                                                                                                           |
| Cursor desktop      | DCR can register **both** `http://localhost:8787/callback` and `https://www.cursor.com/agents/mcp/oauth/callback`, and may use the hosted callback even on desktop. Both are accepted. | Provider tests register both callbacks together and complete the OAuth flow separately through each, including refresh. No live Cursor OAuth session or tool call completed.                                                                                                                                                        |
| Cursor web / Agents | Uses the same exact hosted Cursor callback, authorization code + PKCE, public DCR and refresh.                                                                                         | Same provider-side callback coverage; expected compatible from documentation, not verified in a live hosted agent.                                                                                                                                                                                                                  |
| ChatGPT web         | Use DCR with either documented ChatGPT callback form.                                                                                                                                  | Provider tests cover both callback forms. No live ChatGPT/Google/ngrok/tool-call flow completed.                                                                                                                                                                                                                                    |

The CLI probes used synthetic local discovery/challenge responses and this repository's real OAuth issuer, stopped at the authorization step, and did not issue tokens or complete sign-in. They do not exercise Traffic Policy. The automated provider tests simulate the trusted Google gateway header; they do not contact Google or run ngrok's policy engine. A passing provider test is not a claim that a particular client completed end-to-end login or refreshed its own stored credentials.

Research sources: [Cursor MCP](https://cursor.com/docs/mcp), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code MCP](https://code.claude.com/docs/en/mcp), and [ChatGPT authentication](https://developers.openai.com/plugins/build/auth). Client behavior can change; the versions above apply only to the partial CLI probes.

### Cursor setup

Add this to your project's `.cursor/mcp.json` or your global `~/.cursor/mcp.json`, replacing the URL:

```json
{
  "mcpServers": {
    "company-tools": {
      "url": "https://your-ngrok-host/mcp"
    }
  }
}
```

Connect/authenticate the server in Cursor's MCP settings and complete Google sign-in and consent. Omit static `auth.CLIENT_ID`, `auth.CLIENT_SECRET` and bearer headers so Cursor can use DCR. Its hosted callback is allowed only at the exact URL above: alternate hosts, paths, ports, queries, fragments and legacy `cursor://` callbacks are rejected. Older Cursor versions using the custom scheme are not covered; update before testing.

### Codex and Claude Code login

After adding the server with the commands above, use `codex mcp login my-server` or `claude mcp login my-server` to sign in. Codex uses its published identity when CIMD is enabled. On versions that support the flag, `codex mcp login my-server --oauth-client-registration dcr` selects DCR explicitly. Use DCR for Claude Code. Leave client secrets blank. In Claude Code, `/mcp` → Authenticate is also supported.

The loopback hostname, path and active port registered by a DCR client must match its authorization/token exchange. No fixed callback port is required for these clients. Custom hosted callback overrides in Codex are not supported by this provider, even though Codex itself offers them.

### Set up a hosted Claude connector

Claude's hosted connector uses `https://claude.ai/api/mcp/auth_callback`. Anthropic's cloud sends requests to your public ngrok endpoint. Claude Code's CLI login above uses a local loopback callback. [Claude connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

1. Start your HTTP MCP server and this provider. Copy the printed public HTTPS ngrok URL ending in `/mcp`.
2. On `claude.ai`, open **Customize** → **Connectors**, add a custom web connector, and enter that URL. If Claude for iOS offers **Add custom connector** on your account, you can also set up the connection there.
3. Under **Authentication**, choose **Sign in now**. Under **OAuth client**, choose **Use Claude’s published identity** if the provider is running with `CLAUDE_CIMD=1`. **Register automatically** works with either setting. Add the connector, sign in with an allowed Google account, and approve access.
4. Open Claude for iOS with the same Claude account. Enable the connector in a fresh chat, call a read-only tool, and confirm the result in Claude and the forwarded call in Traffic Inspector.

`CLAUDE_CIMD=1` enables Client ID Metadata Documents (CIMD) for the published identities of hosted Claude and Codex. Discovery advertises CIMD to every client when enabled. Use DCR for other clients, or omit the setting on a shared provider if an unsupported client automatically selects CIMD. [Claude metadata](https://claude.ai/oauth/mcp-oauth-client-metadata) · [Codex metadata](https://chatgpt.com/oauth/codex/client.json) For Docker Compose, add `CLAUDE_CIMD: "1"` to the provider service's `environment` block.

### Finish end-to-end verification

For each client, start the provider and an existing HTTP MCP server, add the public URL, and complete Google sign-in with an allowed account. Confirm the client discovers tools, call a harmless tool and verify its real result in the client and check the request in Traffic Inspector. Repeat with an outside-domain account and confirm access is denied. Testing client-managed refresh requires observing an actual renewal; the provider tests exercise refresh directly rather than waiting for the one-hour access-token lifetime. If the issuer or allowlist changes, clear the client’s saved authentication and reconnect.

## Test in ChatGPT web

For ChatGPT, the provider accepts these HTTPS callbacks documented by [OpenAI](https://developers.openai.com/plugins/build/auth):

- `https://chatgpt.com/connector_platform_oauth_redirect`
- `https://chatgpt.com/connector/oauth/<callback_id>` (one identifier containing letters, digits, underscores or hyphens)

Other ChatGPT origins and paths, callback query strings and fragments are rejected. ChatGPT must register its exact callback through dynamic client registration (DCR). Authorization and token exchange must use that registered URI. PKCE with `S256` is required. The provider advertises issuer identification and returns `iss` in success and error authorization callbacks.

1. Start your HTTP MCP server and this provider. Keep both running.
2. In ChatGPT web, add a custom MCP server using the printed public HTTPS `/mcp` URL. Account and workspace permissions must allow custom MCP servers.
3. Select OAuth authentication and automatic/dynamic client registration (DCR), if the interface offers a registration choice. Leave manually configured client IDs and secrets blank. Published identity support covers hosted Claude and Codex CLI.
4. Complete Google sign-in with an allowed account and approve access.
5. Select the resulting connection in a chat and ask ChatGPT to call a tool. Verify the tool's actual result and the request in Traffic Inspector.

The automated tests exercise registration, consent, issuer identification, PKCE, token exchange and rotating refresh tokens for both ChatGPT callback forms, both Cursor callback choices, and IPv4/localhost/IPv6 loopback callbacks. They do not prove a live ChatGPT connection; verify that in your account. Refresh tokens survive provider restarts with the same public origin, allowlist, and state directory, within the original grant window.

## What runs where

```text
Codex -> public ngrok /mcp -> provider forwarding adapter -> your HTTP MCP server

One public ngrok URL
  /mcp          -> Traffic Policy validates token -> private MCP route
  OAuth routes  -> local provider issues tokens and handles consent
  website paths -> Traffic Policy forwards to the optional APP_URL
```

The CLI uses the ngrok Node SDK to start **one public endpoint and two internal endpoints**, plus a private forwarding endpoint when website forwarding is enabled. JWT signature, issuer, audience, scope and time checks run in Traffic Policy. A small local forwarding adapter provides useful upstream errors; it does not implement MCP tools or change your server.

The validator also checks scope and token times with expressions. See [the policy generator](lib/policy.ts) for the complete rules. Registration, consent, PKCE enforcement, token issuance and rotating refresh tokens run in the Node provider, not Traffic Policy.

The provider also serves the approval page; your MCP server needs no authorization route. It grants one connection permission (`mcp:use`), allowing the client to call the tools your MCP server exposes. It does not implement app-specific read/write permissions.

Reserved paths are `/mcp`, `/mcp/*`, `/mcp-debug`, `/mcp-debug/*`, `/auth`, `/auth/*`, `/token`, `/reg`, `/jwks`, `/interaction/*`, the provider's OAuth/MCP `/.well-known/` discovery paths, and ngrok's `/ngrok/*` login callbacks. ngrok forwards ordinary website paths and query strings to `APP_URL` when configured. Without it, `/` returns 404. HTTPS upstreams need a certificate trusted where the SDK runs. The configured non-root MCP path is also reserved from app fallthrough, including case and encoded variants, so hostname aliases cannot bypass authorization.

## Try with Docker Compose

Requires Docker with Compose, a Google account and an ngrok account with the required paid endpoints and Traffic Policy actions. No local Python, Node installation or repository checkout is needed.

The image is public on GitHub Container Registry, so no registry login is needed. To use a local build instead, follow [Build the image locally](#build-the-image-locally).

```sh
mkdir mcp-demo
cd mcp-demo
```

Create `.env` in that directory:

```dotenv
NGROK_AUTHTOKEN=your_agent_authtoken
USERS='["you@example.com"]'
# Optional: choose an HTTPS domain available to your account.
# NGROK_URL=https://your-assigned-dev-domain.ngrok-free.app
```

Use your **ngrok agent authtoken**, not an API key. Keep `.env` private and out of Git. Copy the single [Compose example from the tutorial](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/python.md#start-the-stack) into `compose.yaml` in the same directory, then run:

```sh
docker compose --env-file .env up -d
docker compose --env-file .env logs -f provider
```

Docker pulls the provider image and starts a minimal Python HTTP MCP server with a `hello` tool. There is no demo web app or published container port. A 404 at the bare public `/` is expected.

**Connect clients to the printed public HTTPS ngrok URL ending in `/mcp`, not localhost or `http://mcp:8000/mcp`.** Localhost may appear during the browser OAuth callback; that callback is not the MCP server address.

Replace `https://your-ngrok-host/mcp` below with the public MCP URL printed by your provider.

For Codex, open a second terminal:

```sh
codex mcp add hello-compose --url https://your-ngrok-host/mcp
codex
```

Complete browser sign-in and approve the connection. If adding did not start sign-in, run `codex mcp login hello-compose` before starting Codex.

For Claude Code:

```sh
claude mcp add --transport http hello-compose https://your-ngrok-host/mcp
claude mcp login hello-compose
claude
```

Ask either client:

> Call the hello tool from hello-compose and show its exact result.

Approve the tool call if prompted. Expect **`Hello from Python!`**. The provider hosts sign-in, approval and token handling; the downstream MCP server needs no OAuth routes, provider imports or token-handling code. It only needs an existing HTTP MCP endpoint reachable by the provider. No separate app is required; stdio servers are outside this tool.

See the [Compose guide](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/python.md) for shutdown and reconnecting after a provider restart.

## Start alongside Python or Node

Your MCP application never imports this package. A shell process runner can start both independent commands and stop the companion when either exits:

```sh
npx --yes --package=concurrently concurrently --kill-others \
  "python server.py" \
  "npx --yes --package=git+https://github.com/ngrok-adhoc/mcp-oauth-provider.git#main mcp-oauth-provider"
```

Use your existing HTTP server command (for example `node server.mjs`) instead of `python server.py`. Add the app command as a third entry if it runs separately. Put the command in a project script or task file if you want a short alias such as `just dev`; no MCP source changes are needed.

## Docker and background use

Use `ghcr.io/ngrok-adhoc/mcp-oauth-provider:latest` with the [tutorial's Compose example](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/python.md). It runs in the background with `up -d`; use `logs -f provider` to see connection URLs and `down` to stop the stack.

The image runs as a nonroot user, opens no local ports. Set `APP_URL` and `MCP_SERVER_URL` to trusted services on your Compose network, such as `http://app:3000` and `http://mcp:8000/mcp`. Container `localhost` means the provider container. Host services can use `host.docker.internal`; on Linux, a host-gateway mapping still cannot reach a listener bound only to host loopback.

The provider can run beside an existing MCP container; the MCP server never imports this package. Process supervision does not make OAuth state persistent. No custom supervisor or OS service installer is included.

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

## Diagnose a connection

Open the printed [ngrok Traffic Inspector](https://dashboard.ngrok.com/traffic-inspector) link to inspect gateway requests. Verify a tool call in your MCP client to confirm the connection end to end.

| Symptom                                        | What to do                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `mcp_upstream_unavailable` (503)               | Start the MCP server, check `MCP_SERVER_URL`, and retry.                                  |
| `user_required` (403)                          | Sign in with a Google account allowed by `USERS`.                                         |
| `invalid_token` (401) or an expired connection | Reauthorize the MCP client. Claude may need logout before login after a state reset.      |
| CLI cannot start                               | Check the terminal error, `.env`, the public URL and your account's endpoint permissions. |
| ngrok 3200 / endpoint offline                  | Check whether the provider is running and restart it if needed.                           |

## Development limits

Access tokens last one hour. Rotating refresh tokens share a 90-day authorization window, and renewed access tokens expire no later than that window. A copied access token remains usable until it expires or the provider rotates its signing key. Reusing a rotated refresh token revokes the authorization, so no new access tokens are issued for it. This is a local development tool.

MCP upstreams get two minutes to establish a connection. Once connected, tool calls may wait for response headers or stream until completion or client cancellation. Browser sessions last one day, and every authorization shows the consent page; authorization codes last 15 minutes.

- One Google email allowlist, one HTTP MCP resource, and HTTP loopback or documented ChatGPT, Cursor, and Claude HTTPS callbacks. Other hosted callbacks, multiple MCPs and stdio translation are outside this tool.
- `/reg` and `/auth` are rate-limited per client IP (30 requests per minute at each ngrok edge server). Client metadata must be smaller than 4 KiB, and only the `query` response mode is accepted. A client registered by an older version with larger metadata or another response mode must disconnect and reconnect to register again.
- The provider keeps up to 1,000 dynamic client registrations. At capacity, it replaces the oldest registration without a live grant. If every registration has a live grant, new registrations receive a temporary service error until a grant expires.
- Keep local listeners private. Only configured public routes should reach the app and MCP.
- When the configured MCP upstream is mounted at `/`, optional app forwarding is disabled. Hostname aliases cannot safely distinguish a separate app from that root-mounted MCP server; the protected public `/mcp` route still works.

## Develop

```sh
npm ci
npm run check
```

Run `npm start` to build and launch the local checkout. The provider uses TypeScript and Hono on Node.js 26 or newer. Edit the consent template in `lib/consent-page.tsx` and its stylesheet in `assets/consent.css`.

For harmless manual fixtures, run `node test/fixtures/upstreams.js` and set `APP_URL=http://127.0.0.1:54831` and `MCP_SERVER_URL=http://127.0.0.1:54832/original-mcp`.

The package's `bin` entry is the CLI; tests exercise configuration, OAuth boundaries, forwarding and Traffic Policy generation. Public npm publication and binary distribution are separate future steps.

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

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
