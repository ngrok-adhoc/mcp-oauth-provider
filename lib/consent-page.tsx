import { readFileSync } from "node:fs";

const defaultLogo = readFileSync(new URL("../../assets/mcp-icon.svg", import.meta.url)).toString(
  "base64",
);

interface ConsentPageProps {
  serverName?: string;
  icon?: URL;
  clientName: string;
  clientId: string;
  resource: string;
  redirectUri: string;
  uid: string;
  csrf: string;
}

export function ConsentPage({
  serverName,
  icon,
  clientName,
  clientId,
  resource,
  redirectUri,
  uid,
  csrf,
}: ConsentPageProps) {
  const logo = icon?.href ?? `data:image/svg+xml;base64,${defaultLogo}`;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{serverName ?? "MCP OAuth Provider"}</title>
        <link rel="stylesheet" href="/interaction/consent.css" />
      </head>
      <body>
        <main>
          <header>
            <img
              class={icon ? "logo" : "logo default-logo"}
              src={logo}
              width="100"
              height="100"
              alt=""
              referrerpolicy="no-referrer"
            />
            <h1>
              {clientName} wants to connect to {serverName ?? "your MCP server"}
            </h1>
          </header>
          <div class="permission">
            <p>
              This tool uses ngrok to OAuth to your existing HTTP MCP server and forward authorized
              requests to it.
            </p>
            <p class="muted">
              Approved users share the same permissions, including access to all read and write
              tools.
            </p>
          </div>
          <details open>
            <summary>Connection details</summary>
            <dl>
              <div>
                <dt>Client name</dt>
                <dd>
                  {clientName} <span class="muted">(provided by the client)</span>
                </dd>
              </div>
              <div>
                <dt>Client ID</dt>
                <dd>
                  <code>{clientId}</code>
                </dd>
              </div>
              <div>
                <dt>MCP endpoint</dt>
                <dd>
                  <code>{resource}</code>
                </dd>
              </div>
              <div>
                <dt>Return address</dt>
                <dd>
                  <code>{redirectUri}</code>
                </dd>
              </div>
            </dl>
          </details>
          <form method="post" action={`/interaction/${encodeURIComponent(uid)}`}>
            <input type="hidden" name="csrf" value={csrf} />
            <div class="actions">
              <button type="submit" name="decision" value="deny">
                Cancel
              </button>
              <button type="submit" class="primary" name="decision" value="allow">
                Authorize
              </button>
            </div>
          </form>
        </main>
      </body>
    </html>
  );
}
