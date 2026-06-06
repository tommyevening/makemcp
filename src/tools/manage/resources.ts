/**
 * Account-resource tools: list connections and webhooks so the agent can fill
 * `__IMTCONN__` (connection id) and `gateway:CustomWebHook` `parameters.hook`
 * (webhook id) for true one-shot deploys — no manual id copying.
 *
 * All read against the user's own team. Require API credentials.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../../context.js";
import { MakeApiError, type MakeConnection, type MakeHook } from "../../make/client.js";

function errText(err: unknown): string {
  if (err instanceof MakeApiError) return `${err.message}\n${JSON.stringify(err.body, null, 2)}`;
  return err instanceof Error ? err.message : String(err);
}

export function registerResourceTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "make_list_connections",
    {
      title: "List Make connections",
      description:
        "List the connections (authenticated accounts) in your Make team. Use the returned `id` as a module's `parameters.__IMTCONN__`. Match a module's required connection type (from get_module, e.g. account:google) against a connection's `accountName`.",
      inputSchema: {
        type: z
          .string()
          .optional()
          .describe("Filter by connection type / app, matched against accountName & name (e.g. 'google', 'slack')."),
        teamId: z.number().int().optional().describe("Defaults to MAKE_TEAM_ID."),
      },
    },
    async ({ type, teamId }) => {
      try {
        const { connections } = await ctx.getClient().listConnections(teamId);
        let items: MakeConnection[] = connections ?? [];
        if (type) {
          const q = type.toLowerCase();
          items = items.filter(
            (c) => c.accountName?.toLowerCase().includes(q) || c.name?.toLowerCase().includes(q),
          );
        }
        if (items.length === 0) {
          return { content: [{ type: "text", text: `No connections${type ? ` matching "${type}"` : ""}.` }] };
        }
        const lines = items.map(
          (c) => `- id=${c.id}  type=${c.accountName}  name="${c.name}"${c.accountLabel ? `  (${c.accountLabel})` : ""}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `${items.length} connection(s):\n${lines.join("\n")}\n\nUse an id as parameters.__IMTCONN__ for a module whose required account type matches its 'type'.`,
            },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `List connections failed:\n${errText(err)}` }] };
      }
    },
  );

  server.registerTool(
    "make_list_hooks",
    {
      title: "List Make webhooks",
      description:
        "List webhooks in your Make team. Use a hook `id` as `parameters.hook` for a gateway:CustomWebHook trigger. Prefer hooks not already attached to a scenario.",
      inputSchema: {
        type: z.string().optional().describe("Filter by name/typeName (e.g. 'gateway-webhook')."),
        teamId: z.number().int().optional().describe("Defaults to MAKE_TEAM_ID."),
      },
    },
    async ({ type, teamId }) => {
      try {
        const { hooks } = await ctx.getClient().listHooks(teamId);
        let items: MakeHook[] = hooks ?? [];
        if (type) {
          const q = type.toLowerCase();
          items = items.filter((h) => h.typeName?.toLowerCase().includes(q) || h.name?.toLowerCase().includes(q));
        }
        if (items.length === 0) {
          return {
            content: [
              { type: "text", text: `No webhooks${type ? ` matching "${type}"` : ""}. Create one with make_create_hook.` },
            ],
          };
        }
        const lines = items.map(
          (h) =>
            `- id=${h.id}  name="${h.name}"  type=${h.typeName ?? "?"}` +
            (h.scenarioName ? `  in-use-by="${h.scenarioName}"` : "  (free)") +
            (h.gone ? "  [gone]" : ""),
        );
        return {
          content: [
            {
              type: "text",
              text: `${items.length} webhook(s):\n${lines.join("\n")}\n\nUse a free hook's id as parameters.hook in gateway:CustomWebHook.`,
            },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `List hooks failed:\n${errText(err)}` }] };
      }
    },
  );

  server.registerTool(
    "make_create_hook",
    {
      title: "Create Make webhook",
      description:
        "Create a new webhook (default a generic gateway/custom webhook) and return its id and URL. Use the id as parameters.hook in a gateway:CustomWebHook trigger.",
      inputSchema: {
        name: z.string().describe("A descriptive name for the webhook."),
        typeName: z.string().optional().describe("Webhook type. Default 'gateway-webhook' (generic custom webhook)."),
        teamId: z.number().int().optional().describe("Defaults to MAKE_TEAM_ID."),
      },
    },
    async ({ name, typeName, teamId }) => {
      try {
        const res = await ctx.getClient().createHook({ name, typeName, teamId });
        return { content: [{ type: "text", text: `✅ Webhook created.\n\n${JSON.stringify(res, null, 2)}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Create hook failed:\n${errText(err)}` }] };
      }
    },
  );
}
