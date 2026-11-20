// Harmless standalone app/MCP fixtures for manual end-to-end verification.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
const factory = () => {
  const server = new McpServer({ name: "untouched-mcp-fixture", version: "1.0.0" });
  server.registerTool(
    "demo_ping",
    {
      description: "Echo a harmless test message",
      inputSchema: z.object({ message: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `Private MCP server received: ${message}` }],
    }),
  );
  return server;
};
const handler = createMcpHandler(factory, { legacy: "stateless", responseMode: "json" });
const serve = toNodeHandler(handler);
const app = createServer((req, res) =>
  res
    .writeHead(200, { "content-type": req.url === "/assets/app.css" ? "text/css" : "text/html" })
    .end(
      req.url === "/assets/app.css"
        ? "body{color:navy}"
        : "<!doctype html><title>Existing app</title><h1>Your existing app</h1><p>The provider leaves this application untouched.</p>",
    ),
);
const mcp = createServer((req, res) => {
  if (req.url !== "/original-mcp") return res.writeHead(404).end();
  void serve(req, res).catch(() => res.destroy());
});
// Raw upgrade echo verifies the tunnel byte stream, not WebSocket framing.
app.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  if (head.length) socket.write(head);
  socket.on("data", (data) => socket.write(data));
  socket.on("error", () => socket.destroy());
  socket.on("end", () => socket.end());
});
app.listen(54831, "127.0.0.1");
mcp.listen(54832, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    app.closeAllConnections();
    mcp.closeAllConnections();
    app.close();
    mcp.close();
    void handler.close();
  });
console.log("Standalone existing app54831/MCP54832 running.");
