#!/usr/bin/env node
/**
 * MakeMCP entrypoint — runs the server over stdio (for Claude Desktop / Code / Cursor).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never log to stdout: it is the JSON-RPC channel. Use stderr for diagnostics.
  process.stderr.write("MakeMCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal error starting MakeMCP: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
