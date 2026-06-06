/**
 * tools_documentation — self-describing catalog of MakeMCP tools.
 *
 * Gives the agent a quick map of what is available and the recommended workflow
 * (discover -> build -> validate -> deploy) before it starts calling other tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";

const OVERVIEW = `# MakeMCP — build Make (make.com) scenarios from Claude

Recommended workflow:
1. DISCOVER   - search_modules / get_module / list_apps to find the right Make modules and their parameters.
2. TEMPLATES  - search_templates / get_template to reuse proven scenario blueprints.
3. BUILD      - assemble a Make blueprint (flow[] of modules with parameters + mapper using IML {{id.field}}).
4. VALIDATE   - validate_scenario to check required params, IML references and structure (use before any deploy).
5. DEPLOY     - make_create_scenario to push the validated blueprint live; make_run_scenario to execute it.

Notes:
- A Make blueprint is { name, flow: [...modules], metadata }. Each module is { id, module: "app:action", version, parameters, mapper, metadata }.
- Mappings between modules use IML expressions like {{1.email}} referencing an earlier module's id.
- Branching uses a builtin:BasicRouter module with a routes[] array, each route having its own flow.
- Management tools require MAKE_API_KEY + MAKE_ZONE (or MAKE_API_URL) and a paid Make plan.`;

const TOOL_DOCS: Record<string, string> = {
  tools_documentation: "This tool. Returns an overview or per-tool docs. Call with no args for the overview.",
  // Discovery
  search_modules: "Search Make modules by text (module id, app, action, label). Returns module ids for blueprints.",
  get_module: "Full schema for a module: parameters (static config) + mapper fields (mappable data), connection requirement, real examples.",
  list_apps: "List Make apps covered by the knowledge DB and their module counts.",
  search_templates: "Search reusable scenario blueprints by name/app. Returns template ids.",
  get_template: "Get a template's full blueprint JSON by id.",
  // Validation
  validate_scenario:
    "Validate + autofix + enrich a blueprint. Checks structure, ids, required params, IML refs; fills metadata + designer. Run before deploy.",
  // Management (need MAKE_API_KEY + region; create needs team id)
  make_health_check: "Verify Make API connectivity and credentials (region, token). Returns the authenticated user.",
  make_create_scenario: "Deploy a new scenario from a blueprint (validates first). Sends blueprint+scheduling serialized.",
  make_get_scenario: "Fetch an existing scenario's blueprint by id.",
  make_update_scenario: "Replace an existing scenario's blueprint (validates first).",
  make_run_scenario: "Trigger a manual run of a scenario by id.",
  make_list_scenarios: "List scenarios in a team.",
  make_list_connections: "List account connections; use an id as a module's parameters.__IMTCONN__ (match by accountName).",
  make_list_hooks: "List webhooks; use a free hook's id as parameters.hook in gateway:CustomWebHook.",
  make_create_hook: "Create a webhook and get its id + URL for a gateway:CustomWebHook trigger.",
};

export function registerDocumentation(server: McpServer, _ctx: ServerContext): void {
  server.registerTool(
    "tools_documentation",
    {
      title: "MakeMCP documentation",
      description:
        "Get an overview of MakeMCP and how to build Make scenarios, or docs for a specific tool. Start here.",
      inputSchema: {
        tool: z
          .string()
          .optional()
          .describe("Optional tool name to get focused docs for. Omit for the overview."),
      },
    },
    async ({ tool }) => {
      if (tool && TOOL_DOCS[tool]) {
        return { content: [{ type: "text", text: `# ${tool}\n\n${TOOL_DOCS[tool]}` }] };
      }
      if (tool) {
        return {
          content: [
            {
              type: "text",
              text: `No docs found for "${tool}". Available tools: ${Object.keys(TOOL_DOCS).join(", ")}`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: OVERVIEW }] };
    },
  );
}
