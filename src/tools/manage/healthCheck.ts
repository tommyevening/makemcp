/**
 * make_health_check — confirm Make API connectivity and credentials.
 *
 * The first thing to run when wiring up the server, to verify MAKE_API_KEY /
 * region before attempting any deploy.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../../context.js";
import { MakeApiError } from "../../make/client.js";

export function registerHealthCheck(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "make_health_check",
    {
      title: "Make health check",
      description:
        "Verify the Make API connection: checks the configured region (MAKE_ZONE/MAKE_API_URL) and token (MAKE_API_KEY) by fetching the authenticated user.",
      inputSchema: {},
    },
    async () => {
      try {
        const client = ctx.getClient();
        const result = await client.healthCheck();
        return {
          content: [
            {
              type: "text",
              text:
                `OK — connected to Make.\n` +
                `API URL: ${result.apiUrl}\n` +
                `Team ID: ${result.teamId ?? "(not set — set MAKE_TEAM_ID for create_scenario)"}\n\n` +
                `Authenticated user:\n${JSON.stringify(result.detail, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        const detail =
          err instanceof MakeApiError
            ? `${err.message}\n${JSON.stringify(err.body, null, 2)}`
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `Health check failed:\n${detail}` }],
        };
      }
    },
  );
}
