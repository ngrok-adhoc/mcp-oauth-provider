# Client setup and compatibility

## Codex

Replace `https://your-ngrok-host/mcp` with the **MCP URL** printed by the provider. It uses `/mcp` on your `NGROK_URL` or the public origin ngrok allocates at startup.

```sh
codex mcp add my-server --url https://your-ngrok-host/mcp
codex mcp login my-server
codex
```

Sign in with a Google account in `USERS` and approve the connection. Ask Codex to list the tools from `my-server`, then call one of your server’s tools. Approve the tool call if prompted and verify its actual result.

The upstream must accept HTTP MCP requests without a separate bearer token. This provider removes its access token before forwarding; it does not sign in to another OAuth-protected MCP service. Stdio servers need an HTTP transport before they can be used here.

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
