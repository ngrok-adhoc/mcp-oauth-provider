# MCP OAuth Provider

Put Google sign-in in front of an existing local HTTP MCP server, without changing the server. ngrok handles sign-in and routing; the provider handles OAuth registration, consent and tokens.

## Why this exists

Running an MCP server on your own machine is easy. Running one centrally for your team is harder: you either hand out API tokens, or build the sign-in flow AI assistants support so people just log in. This skips both: run one command and your teammates connect with their Google account, no tokens to hand out and no auth code to write.

It's built for development and quick sharing, not production. Everyone you let in gets the same access, so it doesn't replace proper per-user authorization.

- **Share one MCP server without implementing the OAuth flow.** Teammates connect from Claude, Codex, Cursor or ChatGPT instead of each running their own.
- **Choose who gets in.** People sign in with Google. Allow exact emails or everyone with an address at your company's domain.
- **Keep the server as it is.** It stays a plain HTTP MCP server, with no code changes.
- **Make it yours.** The sign-in approval page shows your server's name and icon.

## Run with npx

Requires **Node.js 26+**, Git, and an ngrok account with paid internal endpoints and Traffic Policy actions. No Google Cloud project or OAuth app is needed.

In your MCP server's project directory, create `.env`:

```dotenv
NGROK_AUTHTOKEN=your_ngrok_agent_authtoken
USERS='["you@example.com"]'
# Your existing server's HTTP MCP endpoint, including its path.
MCP_SERVER_URL=http://127.0.0.1:3001/mcp
```

Use your ngrok **agent authtoken**, not an API key, and keep `.env` out of Git. Start your MCP server, then run:

```sh
npx --yes \
  --package=git+https://github.com/ngrok-adhoc/mcp-oauth-provider.git#main \
  mcp-oauth-provider
```

It prints the public **MCP URL**. Press **Ctrl+C** to stop.

## Connect a client

Add the printed URL to any OAuth-capable MCP client, sign in with a Google account in `USERS`, and approve access. For example:

```sh
codex mcp add my-server --url https://your-ngrok-host/mcp
claude mcp add --transport http my-server https://your-ngrok-host/mcp
```

Cursor, ChatGPT and Claude web work too; see [client setup](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/clients.md).

## Optional settings

| Setting                              | Use                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `NGROK_URL`                          | A fixed HTTPS origin, so connections survive restarts                           |
| `USERS`                              | More emails, or `/regex/` patterns such as `"/[^@]+@example\\.org/"`            |
| `MCP_SERVER_NAME`, `MCP_SERVER_ICON` | Brand the consent page                                                          |
| `APP_URL`                            | Send other paths to another app, so your dev domain isn't only for MCP          |
| `OAUTH_REQUESTS_PER_MINUTE`          | Requests to `/reg`, `/auth` and `/auth/*` per minute per client IP (default 30) |
| `MCP_REQUESTS_PER_MINUTE`            | Authenticated requests to `/mcp` per minute per user (default 60)               |

See [.env.example](.env.example) for every setting and [advanced features](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/advanced.md) for details, including [identity headers](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/advanced.md#identify-users-in-your-mcp-server) that tell your server who is calling.

## Run with Docker Compose

Follow the [Compose tutorial](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/python.md) to run the provider with a sample Python MCP server, no local Node or Python needed.

## Diagnose a connection

Open the printed [ngrok Traffic Inspector](https://dashboard.ngrok.com/traffic-inspector) link to inspect gateway requests. Verify a tool call in your MCP client to confirm the connection end to end.

| Symptom                                        | What to do                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `mcp_upstream_unavailable` (503)               | Start the MCP server, check `MCP_SERVER_URL`, and retry.                                  |
| `user_required` (403)                          | Sign in with a Google account allowed by `USERS`.                                         |
| `invalid_token` (401) or an expired connection | Reauthorize the MCP client. Claude may need logout before login after a state reset.      |
| Too many requests (429)                        | Wait for the time in `Retry-After` before retrying.                                       |
| CLI cannot start                               | Check the terminal error, `.env`, the public URL and your account's endpoint permissions. |
| ngrok 3200 / endpoint offline                  | Check whether the provider is running and restart it if needed.                           |

## How ngrok protects MCP traffic

The provider generates its Traffic Policy at startup. This YAML shows the default rule that limits client registration and authorization requests before Google sign-in.

```yaml
on_http_request:
  - expressions:
      - "req.url.path == '/reg' || req.url.path == '/auth' || req.url.path.startsWith('/auth/')"
    actions:
      - type: rate-limit
        config:
          name: "OAuth registration and authorization"
          algorithm: sliding_window
          capacity: 30
          rate: "60s"
          bucket_key:
            - "conn.client_ip"
```

The separate MCP limit runs after token validation and before forwarding to your server. It uses the verified user ID, with the client IP as a fallback for older tokens that lack that ID. Both limits use a 60-second sliding window at each ngrok ingress server. To override either default, set its environment variable and restart the provider. [.env.example](.env.example)

| Traffic Policy feature         | What it does                                                                                                                                                                                    | Implementation                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Rate limiting                  | Caps OAuth registration and authorization per client IP and authenticated MCP requests per user.                                                                                                | [OAuth limit](lib/policy.ts#L92-L109), [MCP limit](lib/policy.ts#L230-L245)                           |
| Google sign-in                 | Requires Google sign-in for consent and checks the signed-in email against `USERS`.                                                                                                             | [`oauth` and allowlist](lib/policy.ts#L110-L143)                                                      |
| OAuth discovery and challenges | Serves protected-resource metadata and tells MCP clients how to authorize when a token is missing or invalid.                                                                                   | [`custom-response` and discovery](lib/policy.ts#L144-L172), [invalid tokens](lib/policy.ts#L214-L219) |
| JWT validation                 | Calls a private validator that checks the JWT signature, issuer, audience, scope and validity window.                                                                                           | [`http-request`](lib/policy.ts#L173-L192), [`jwt-validation`](lib/policy.ts#L295-L356)                |
| Trusted identity headers       | Strips caller-supplied identity headers, adds verified identity and removes the bearer token before forwarding.                                                                                 | [`remove-headers`](lib/policy.ts#L84-L91), [`add-headers` and forwarding](lib/policy.ts#L220-L256)    |
| Private forwarding             | Sends authenticated requests to the private MCP upstream and keeps reserved routes out of optional website forwarding. With `MCP_SERVER_BINDING=internal`, it also strips the MCP query string. | [`forward-internal` and `url-rewrite`](lib/policy.ts#L246-L289)                                       |

## More

- [Advanced features](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/advanced.md): settings, persistence and S3, branding, identity headers, architecture and limits
- [Client setup](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/clients.md): Codex, Claude, Cursor and ChatGPT
- [Develop and release](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/development.md)
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
