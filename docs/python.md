# Test end to end with Docker Compose

This optional smoke test starts an HTTP MCP `hello` server and the OAuth provider with one Compose file. To connect a real server, start with [Run with npx](../README.md#run-with-npx) instead. This test needs no existing MCP server and no local Python or Node installation. No separate web app is required.

```text
Codex / Claude Code → https://your-ngrok-host/mcp
                      ngrok Traffic Policy → provider → mcp:8000/mcp
```

The Compose example below uses the provider image from GitHub Container Registry and injects a minimal server into an official Python container with the pinned MCP SDK. Python contains no OAuth or provider imports. Neither container publishes a host port. The only public entry is ngrok.

## Start the stack

Requires Docker with Compose, an ngrok account with the required paid endpoints/Traffic Policy actions, and a Google account for sign-in. No custom Google application is needed.

Public access to the v0.1.1 image is pending. If you do not have access to the GHCR package, [build the image locally](development.md#build-the-image-locally) and add `--pull never` to the Compose command below.

Create a new directory:

```sh
mkdir mcp-demo
cd mcp-demo
```

Create `.env` in that directory with your **agent authtoken** and allowed Google email:

```dotenv
NGROK_AUTHTOKEN=your_ngrok_agent_authtoken
USERS='["you@example.com"]'
# Set a fixed HTTPS origin to keep OAuth connections after a restart.
# NGROK_URL=https://your-assigned-dev-domain.ngrok-free.app
```

Keep `.env` private and out of Git. Save this as `compose.yaml` in the same directory:

```yaml
services:
  mcp:
    image: python:3.13-slim
    init: true
    command:
      - sh
      - -ec
      - |
        pip install --no-cache-dir 'mcp==2.3.0'
        exec python -u - <<'PY'
        from mcp.server import MCPServer
        from mcp.types import ToolAnnotations

        mcp = MCPServer("Hello Python")

        @mcp.tool(annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False,
                                             idempotent_hint=True, open_world_hint=False))
        async def hello() -> str:
            """Return a greeting from the Python container."""
            return "Hello from Python!"

        mcp.run("streamable-http", host="0.0.0.0", port=8000,
                stateless_http=True, json_response=True)
        PY
    healthcheck:
      test:
        [
          "CMD",
          "python",
          "-c",
          "import socket; socket.create_connection(('127.0.0.1', 8000), timeout=2).close()",
        ]
      interval: 3s
      timeout: 3s
      retries: 30
      start_period: 30s

  provider:
    image: ghcr.io/ngrok-adhoc/mcp-oauth-provider-public:0.1.1
    init: true
    depends_on:
      mcp:
        condition: service_healthy
    environment:
      NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN:?Set NGROK_AUTHTOKEN in .env}
      USERS: ${USERS:?Set USERS in .env}
      NGROK_URL: ${NGROK_URL:-}
      MCP_SERVER_URL: http://mcp:8000/mcp
      STORAGE: local
    volumes:
      - oauth-state:/app/.mcp-oauth-provider

volumes:
  oauth-state:
```

Start the stack. Docker pulls the images automatically when it can access the GHCR package:

To use a local build, add `--pull never` to the command.

```sh
docker compose --env-file .env up -d
docker compose --env-file .env logs -f provider
```

Wait for the provider’s printed **MCP** URL. Use the public HTTPS MCP URL ending in `/mcp`, not `localhost` or the private Docker service address. The TCP health check must pass before the provider starts. The first run downloads images and Python dependencies; no extra source files are needed.

Set `USERS='["guest@example.com","/[^@]+@example\\.org/"]'` in `.env` to give coworkers MCP access. See [company access](advanced.md#share-with-your-company) for matching and token lifetime details.

See the [client compatibility matrix](clients.md#client-compatibility) for documented requirements, automated coverage and the limits of the partial CLI probes. The steps below are manual verification instructions, not a record of completed end-to-end client tests.

## Test with Codex

In a second terminal, replace the URL below with the printed public MCP URL:

```sh
codex mcp add hello-compose --url https://your-ngrok-host/mcp
codex
```

Complete Google sign-in and approve access when prompted. If adding did not start login, run `codex mcp login hello-compose` first. In the new Codex session, ask:

> Call the hello tool from hello-compose and show its exact result.

Approve the tool call if Codex prompts. Expect an actual MCP tool call returning **Hello from Python!**. Use `/mcp` to inspect the server if the tool is unavailable. These commands follow the [Codex MCP guide](https://developers.openai.com/codex/mcp).

## Test with Claude Code

From the same directory:

```sh
claude mcp add --transport http hello-compose https://your-ngrok-host/mcp
claude mcp login hello-compose
claude
```

Complete the browser flow, then ask the same question. In Claude Code, `/mcp` also shows connection status and an **Authenticate** action. These commands follow the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

The MCP client may open a `localhost` callback during browser sign-in; that is normal and is not the MCP server URL.

The provider hosts the approval page. Its single connection permission allows the client to use the MCP tools; your Python app implements no authorization route or permission UI. Client tool-call confirmations still apply.

Check the request using the printed Traffic Inspector link. A plain `curl` to public `/mcp` without a token should return **401**; that is the expected access check. This MCP-only example has no app page at `/`; a 404 there is expected.

## Keep running, stop or reconnect

Access tokens last one hour. Rotating refresh tokens share a 90-day authorization window, and renewed access tokens expire no later than that window. Provider keys and OAuth records live in the `oauth-state` volume. Keep the volume, a fixed `NGROK_URL`, and the same `USERS` list to stay connected when restarting or rebuilding the provider.

Changing `USERS` or the public origin clears authorizations. If you need to reconnect, run `codex mcp logout hello-compose` and then `codex mcp login hello-compose`, or use the equivalent `claude mcp logout` and `claude mcp login` commands.

Restarting only the `mcp` service keeps authorization intact. View startup URLs and errors with:

```sh
docker compose --env-file .env logs -f provider
```

Stop the stack:

```sh
docker compose --env-file .env down
```

If startup fails, check Docker and the provider logs, `.env` and account entitlements. If forwarding fails, check `docker compose --env-file .env logs mcp` and the [connection diagnostics](../README.md#diagnose-a-connection).
