# Advanced features

## More settings

In the `npx` command, replace `#main` with a release tag or commit SHA to pin a revision.

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

With `STORAGE=s3`, startup fails if the provider cannot access S3. With `STORAGE` omitted, the provider uses S3 when it has a bucket and AWS credentials and otherwise uses local JSON. Set `STORAGE=local` to always use the filesystem. S3 mode writes directly to the object and requires no local state volume. Run a single provider instance per object. A second provider with the same `NGROK_URL` exits before it reads or writes state, and conditional writes prevent a stale instance from overwriting newer state. Deploy with stop-then-start: a rolling deploy that starts the new provider before stopping the old one cannot promote, because the new provider exits while the old one holds `NGROK_URL`.

## Share with your company

Set `USERS` in `.env` to a nonempty JSON array of allowed Google emails or patterns.

```dotenv
USERS='["you@example.com","guest@example.com","/[^@]+@example\\.org/"]'
```

Use an exact email or wrap a regular expression in `/…/`. The provider compares against the whole Google email after lowercasing its ASCII letters. Write regexes in RE2 syntax and escape backslashes for JSON, as in the domain pattern above. That pattern matches `someone@example.org`.

A domain pattern matches any Google account using that email address, including personal Google accounts created with a work address. ngrok does not expose Google's hosted-domain claim, so list exact emails when that matters.

All admitted accounts get the same tool permissions. Your MCP server can tell them apart with [identity headers](#identify-users-in-your-mcp-server).

The allowlist is checked during sign-in. Restart the provider after editing it to apply the new list and invalidate existing connections.

For Docker Compose, pass `USERS` through the provider service's `environment` block.

## Identify users in your MCP server

Every forwarded MCP request carries the identity of the user who approved the connection:

| Header                | Value                                                      | Always sent |
| --------------------- | ---------------------------------------------------------- | ----------- |
| `X-MCP-User-Provider` | Sign-in provider, currently `google`                       | Yes         |
| `X-MCP-User-ID`       | The provider's user ID; the email if the provider has none | Yes         |
| `X-MCP-User-Email`    | Email address                                              | When known  |
| `X-MCP-User-Name`     | Display name                                               | When known  |

Use `X-MCP-User-Provider` and `X-MCP-User-ID` together as the stable user key. Email and name come from the provider and may be missing or change. Values are percent-encoded UTF-8 limited to 256 characters, so decode them before display, for example with `decodeURIComponent` in JavaScript or `urllib.parse.unquote` in Python.

The gateway strips these headers from incoming requests before setting them, so clients can't supply their own. The identity is captured when the user approves the connection; have the user reconnect to update it.

## Brand the consent page

Set either of these in the provider's `.env` and restart the provider.

```dotenv
MCP_SERVER_NAME=Bowie
MCP_SERVER_ICON=./bowie.png
```

The name appears in the consent page title and heading. A 100 × 100 pixel icon sits above the heading. The page uses the bundled MCP logo when no custom icon is set. Set `MCP_SERVER_ICON` to an absolute path, a path relative to the provider's working directory, a `file:` URL, or a direct HTTPS image URL that users' browsers can reach. Local PNG, JPEG, GIF, WebP and SVG files up to 256 KiB are embedded in the consent page. With no branding settings, the page uses the generic provider name. For Docker Compose, put these settings in the provider service's `environment` block.

## Start alongside Python or Node

Your MCP application never imports this package. A shell process runner can start both independent commands and stop the companion when either exits:

```sh
npx --yes --package=concurrently concurrently --kill-others \
  "python server.py" \
  "npx --yes --package=git+https://github.com/ngrok-adhoc/mcp-oauth-provider.git#main mcp-oauth-provider"
```

Use your existing HTTP server command (for example `node server.mjs`) instead of `python server.py`. Add the app command as a third entry if it runs separately. Put the command in a project script or task file if you want a short alias such as `just dev`; no MCP source changes are needed.

## Docker and background use

Build the provider image locally while public GHCR access is pending, then follow the [tutorial's Compose example](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/python.md). It runs in the background with `up -d`; use `logs -f provider` to see connection URLs and `down` to stop the stack.

The image runs as a nonroot user, opens no local ports. Set `APP_URL` and `MCP_SERVER_URL` to trusted services on your Compose network, such as `http://app:3000` and `http://mcp:8000/mcp`. Container `localhost` means the provider container. Host services can use `host.docker.internal`; on Linux, a host-gateway mapping still cannot reach a listener bound only to host loopback.

The provider can run beside an existing MCP container; the MCP server never imports this package. Process supervision does not make OAuth state persistent. No custom supervisor or OS service installer is included.

## What runs where

```text
Codex -> public ngrok /mcp -> provider forwarding adapter -> your HTTP MCP server

One public ngrok URL
  /mcp          -> Traffic Policy validates token -> private MCP route
  OAuth routes  -> local provider issues tokens and handles consent
  website paths -> Traffic Policy forwards to the optional APP_URL
```

The CLI uses the ngrok Node SDK to start **one public endpoint and two internal endpoints**, plus a private forwarding endpoint when website forwarding is enabled. JWT signature, issuer, audience, scope and time checks run in Traffic Policy. A small local forwarding adapter provides useful upstream errors; it does not implement MCP tools or change your server.

The validator also checks scope and token times with expressions. See [the policy generator](../lib/policy.ts) for the complete rules. Registration, consent, PKCE enforcement, token issuance and rotating refresh tokens run in the Node provider, not Traffic Policy.

The provider also serves the approval page; your MCP server needs no authorization route. It grants one connection permission (`mcp:use`), allowing the client to call the tools your MCP server exposes. It does not implement app-specific read/write permissions.

Reserved paths are `/mcp`, `/mcp/*`, `/mcp-debug`, `/mcp-debug/*`, `/auth`, `/auth/*`, `/token`, `/reg`, `/jwks`, `/interaction/*`, the provider's OAuth/MCP `/.well-known/` discovery paths, and ngrok's `/ngrok/*` login callbacks. ngrok forwards ordinary website paths and query strings to `APP_URL` when configured. Without it, `/` returns 404. HTTPS upstreams need a certificate trusted where the SDK runs. The configured non-root MCP path is also reserved from app fallthrough, including case and encoded variants, so hostname aliases cannot bypass authorization.

## Development limits

Access tokens last one hour. Rotating refresh tokens share a 90-day authorization window, and renewed access tokens expire no later than that window. A copied access token remains usable until it expires or the provider rotates its signing key. Reusing a rotated refresh token revokes the authorization, so no new access tokens are issued for it. This is a local development tool.

MCP upstreams get two minutes to establish a connection. Once connected, tool calls may wait for response headers or stream until completion or client cancellation. Browser sessions last seven days, and every authorization shows the consent page; authorization codes last 15 minutes.

- One Google email allowlist, one HTTP MCP resource, and HTTP loopback or documented ChatGPT, Cursor, and Claude HTTPS callbacks. Other hosted callbacks, multiple MCPs and stdio translation are outside this tool.
- `OAUTH_REQUESTS_PER_MINUTE` sets a shared limit for `/reg`, `/auth` and `/auth/*` (default 30 per client IP).
- `MCP_REQUESTS_PER_MINUTE` limits authenticated HTTP requests to `/mcp` before they reach the upstream (default 60 per verified user ID). Older tokens without a user ID use a bucket per client IP. A request that opens a stream counts once.
- Both limits use a 60-second sliding window at each ngrok ingress server. Set either variable to a whole number from 1 to 2,000,000,000 and restart to change its limit. Excess requests receive HTTP `429` with a `Retry-After` header. [Rate Limit action](https://ngrok.com/docs/gateway/traffic-policy/actions/rate-limit)
- Client metadata must be smaller than 4 KiB, and only the `query` response mode is accepted. A client registered by an older version with larger metadata or another response mode must disconnect and reconnect to register again.
- The provider keeps up to 1,000 dynamic client registrations. At capacity, it replaces the oldest registration without a live grant. If every registration has a live grant, new registrations receive a temporary service error until a grant expires.
- Keep local listeners private. Only configured public routes should reach the app and MCP.
- When the configured MCP upstream is mounted at `/`, optional app forwarding is disabled. Hostname aliases cannot safely distinguish a separate app from that root-mounted MCP server; the protected public `/mcp` route still works.
