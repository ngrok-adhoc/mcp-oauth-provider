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

| Setting                              | Use                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `NGROK_URL`                          | A fixed HTTPS origin, so connections survive restarts                  |
| `USERS`                              | More emails, or `/regex/` patterns such as `"/[^@]+@example\\.org/"`   |
| `MCP_SERVER_NAME`, `MCP_SERVER_ICON` | Brand the consent page                                                 |
| `APP_URL`                            | Send other paths to another app, so your dev domain isn't only for MCP |

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
| CLI cannot start                               | Check the terminal error, `.env`, the public URL and your account's endpoint permissions. |
| ngrok 3200 / endpoint offline                  | Check whether the provider is running and restart it if needed.                           |

## More

- [Advanced features](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/advanced.md): settings, persistence and S3, branding, identity headers, architecture and limits
- [Client setup](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/clients.md): Codex, Claude, Cursor and ChatGPT
- [Develop and release](https://github.com/ngrok-adhoc/mcp-oauth-provider/blob/main/docs/development.md)
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
