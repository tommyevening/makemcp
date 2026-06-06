/**
 * Scenario management tools (write) — talk to the live Make API.
 * Require MAKE_API_KEY + MAKE_ZONE (or MAKE_API_URL); create also needs a team id.
 *
 * Safety: make_create_scenario / make_update_scenario validate the blueprint first
 * and refuse to deploy if there are errors (warnings, e.g. missing connection, are
 * surfaced but allowed).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../../context.js";
import { MakeApiError } from "../../make/client.js";
import { validateBlueprint } from "../../blueprint/validator.js";
import { coerceBlueprint, makeResolver } from "../validate/index.js";
import type { Blueprint } from "../../knowledge/types.js";

function errText(err: unknown): string {
  if (err instanceof MakeApiError) return `${err.message}\n${JSON.stringify(err.body, null, 2)}`;
  return err instanceof Error ? err.message : String(err);
}

function summarizeIssues(issues: { level: string; module?: string; moduleId?: number; message: string }[]): string {
  return issues
    .map((i) => `  - [${i.level}] ${i.module ?? ""}${i.moduleId != null ? "#" + i.moduleId : ""}: ${i.message}`)
    .join("\n");
}

export function registerScenarioTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "make_create_scenario",
    {
      title: "Create Make scenario",
      description:
        "Deploy a new scenario to Make from a blueprint. Validates first and refuses to deploy if there are errors. " +
        "Blueprint and scheduling are sent serialized as required by the Make API.",
      inputSchema: {
        blueprint: z
          .union([z.string(), z.record(z.any())])
          .describe("The Make blueprint (object or JSON string). Should pass validate_scenario first."),
        teamId: z.number().int().optional().describe("Team id to create in. Defaults to MAKE_TEAM_ID."),
        scheduling: z
          .string()
          .optional()
          .describe('Scheduling JSON string, e.g. \'{"type":"on-demand"}\' or \'{"type":"indefinitely","interval":900}\'. Default: on-demand.'),
        skipValidation: z.boolean().optional().describe("Deploy even if validation reports errors (not recommended)."),
      },
    },
    async ({ blueprint, teamId, scheduling, skipValidation }) => {
      let bp: Blueprint;
      try {
        bp = coerceBlueprint(blueprint);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Invalid blueprint JSON: ${(e as Error).message}` }] };
      }

      // Validate + autofix + enrich first.
      const result = validateBlueprint(ctx.getDb(), bp, makeResolver(ctx));
      if (!result.valid && !skipValidation) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Refusing to deploy: blueprint has errors. Fix these and retry (or pass skipValidation):\n` +
                summarizeIssues(result.issues.filter((i) => i.level === "error")),
            },
          ],
        };
      }

      const client = ctx.getClient();
      const resolvedTeam = teamId ?? client.teamId;
      if (resolvedTeam == null) {
        return {
          isError: true,
          content: [{ type: "text", text: "No team id. Set MAKE_TEAM_ID or pass teamId." }],
        };
      }

      try {
        const res = (await client.createScenario({
          teamId: resolvedTeam,
          blueprint: JSON.stringify(result.blueprint),
          scheduling: scheduling ?? '{"type":"on-demand"}',
        })) as { scenario?: { id?: number; name?: string } };

        const id = res?.scenario?.id;
        const warnings = result.issues.filter((i) => i.level === "warning");
        return {
          content: [
            {
              type: "text",
              text:
                `✅ Scenario created${id != null ? ` (id ${id})` : ""}.\n` +
                (warnings.length ? `\n⚠️ Post-deploy notes:\n${summarizeIssues(warnings)}\n` : "") +
                `\nAPI response:\n${JSON.stringify(res, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Create failed:\n${errText(err)}` }] };
      }
    },
  );

  server.registerTool(
    "make_get_scenario",
    {
      title: "Get Make scenario blueprint",
      description: "Fetch the blueprint of an existing scenario by id (useful as a template or to update it).",
      inputSchema: { scenarioId: z.number().int().describe("The scenario id.") },
    },
    async ({ scenarioId }) => {
      try {
        const res = await ctx.getClient().getScenarioBlueprint(scenarioId);
        return { content: [{ type: "text", text: "```json\n" + JSON.stringify(res, null, 2) + "\n```" }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Get failed:\n${errText(err)}` }] };
      }
    },
  );

  server.registerTool(
    "make_update_scenario",
    {
      title: "Update Make scenario blueprint",
      description: "Replace an existing scenario's blueprint. Validates first and refuses on errors unless skipValidation.",
      inputSchema: {
        scenarioId: z.number().int(),
        blueprint: z.union([z.string(), z.record(z.any())]),
        scheduling: z.string().optional(),
        skipValidation: z.boolean().optional(),
      },
    },
    async ({ scenarioId, blueprint, scheduling, skipValidation }) => {
      let bp: Blueprint;
      try {
        bp = coerceBlueprint(blueprint);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Invalid blueprint JSON: ${(e as Error).message}` }] };
      }
      const result = validateBlueprint(ctx.getDb(), bp, makeResolver(ctx));
      if (!result.valid && !skipValidation) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Refusing to update: errors present.\n${summarizeIssues(result.issues.filter((i) => i.level === "error"))}` },
          ],
        };
      }
      try {
        const res = await ctx
          .getClient()
          .updateScenarioBlueprint(scenarioId, JSON.stringify(result.blueprint), scheduling);
        return { content: [{ type: "text", text: `✅ Scenario ${scenarioId} updated.\n\n${JSON.stringify(res, null, 2)}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Update failed:\n${errText(err)}` }] };
      }
    },
  );

  server.registerTool(
    "make_run_scenario",
    {
      title: "Run Make scenario",
      description: "Trigger a manual run of a scenario by id.",
      inputSchema: { scenarioId: z.number().int() },
    },
    async ({ scenarioId }) => {
      try {
        const res = await ctx.getClient().runScenario(scenarioId);
        return { content: [{ type: "text", text: `▶️ Run triggered for scenario ${scenarioId}.\n\n${JSON.stringify(res, null, 2)}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Run failed:\n${errText(err)}` }] };
      }
    },
  );

  server.registerTool(
    "make_list_scenarios",
    {
      title: "List Make scenarios",
      description: "List scenarios in a team.",
      inputSchema: { teamId: z.number().int().optional().describe("Defaults to MAKE_TEAM_ID.") },
    },
    async ({ teamId }) => {
      try {
        const res = await ctx.getClient().listScenarios(teamId);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `List failed:\n${errText(err)}` }] };
      }
    },
  );
}
