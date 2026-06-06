/**
 * Discovery tools — read-only access to the Make knowledge DB:
 * search/get modules, list apps, search/get templates.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../../context.js";
import type { ParamSpec } from "../../knowledge/types.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function formatParams(params: ParamSpec[]): string {
  const config = params.filter((p) => p.section === "parameters");
  const mapper = params.filter((p) => p.section === "mapper");
  const fmt = (p: ParamSpec) =>
    `  - ${p.name} (${p.type})${p.required ? " [required]" : ""}` +
    (p.enum ? ` enum: ${p.enum.join(" | ")}` : "") +
    (p.label ? `  // ${p.label}` : "");
  const out: string[] = [];
  if (config.length) out.push("parameters (static config — connection, modes):", ...config.map(fmt));
  if (mapper.length) out.push("mapper (mappable data fields — accept IML {{id.field}}):", ...mapper.map(fmt));
  return out.join("\n") || "  (no parameter schema mined yet)";
}

export function registerDiscovery(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "search_modules",
    {
      title: "Search Make modules",
      description:
        "Full-text search across known Make modules (by module id, app, action or label). Returns module ids like 'slack:CreateMessage' to use in a blueprint.",
      inputSchema: {
        query: z.string().describe("Search text, e.g. 'slack message', 'google sheets add row', 'webhook'."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 25)."),
      },
    },
    async ({ query, limit }) => {
      const rows = ctx.getDb().searchModules(query, limit ?? 25);
      if (rows.length === 0) {
        return text(
          `No modules found for "${query}". The knowledge DB currently covers a curated set of apps; ` +
            `enrich it by exporting more scenarios into data/corpus and running build:db.`,
        );
      }
      const lines = rows.map(
        (r) =>
          `- ${r.module}  [${r.kind}]` +
          (r.connection_type ? ` conn:${r.connection_type}` : "") +
          (r.label ? `  ${r.label}` : "") +
          `  (examples: ${r.example_count})`,
      );
      return text(`Found ${rows.length} module(s):\n${lines.join("\n")}\n\nUse get_module to see full parameter schema.`);
    },
  );

  server.registerTool(
    "get_module",
    {
      title: "Get Make module details",
      description:
        "Get the full schema for a Make module: its parameters (static config) and mapper fields (mappable data), connection requirement, and real example configurations mined from blueprints.",
      inputSchema: {
        module: z.string().describe("Module id, e.g. 'slack:CreateMessage' or 'google-sheets:addRow'."),
        includeExamples: z.boolean().optional().describe("Include example configs (default true)."),
      },
    },
    async ({ module, includeExamples }) => {
      const db = ctx.getDb();
      const mod = db.getModule(module);
      if (!mod) {
        const suggestions = db.searchModules(module.split(":")[0] ?? module, 8);
        return text(
          `Module "${module}" not found.` +
            (suggestions.length ? `\nDid you mean:\n${suggestions.map((s) => `  - ${s.module}`).join("\n")}` : ""),
        );
      }
      let params = db.getParameters(module);
      // Lazy deep-load: if the schema wasn't pre-scraped, fetch it live from the SDK API.
      if (params.length === 0) {
        if (ctx.paramCache.has(module)) {
          params = ctx.paramCache.get(module)!;
        } else {
          const sdk = ctx.getSdkClient();
          if (sdk && mod.version != null) {
            try {
              params = await sdk.fetchModuleParams(mod.app, mod.version, mod.action);
              ctx.paramCache.set(module, params);
            } catch {
              /* fall through with empty params */
            }
          }
        }
      }
      let out =
        `# ${mod.module}\n` +
        `app: ${mod.app}   action: ${mod.action}   version: ${mod.version ?? "?"}   kind: ${mod.kind}\n` +
        (mod.connection_type ? `connection required: account:${mod.connection_type}\n` : "no connection required\n");

      if (mod.usage) out += `\n## How to use\n${mod.usage}\n`;

      out += `\n## Schema\n${formatParams(params)}\n`;

      if (includeExamples !== false) {
        const examples = db.getExamples(module, 2);
        if (examples.length) {
          out += `\n## Examples (real configs from blueprints)\n`;
          examples.forEach((ex, i) => {
            out += `\n### Example ${i + 1} (${ex.source})\n` +
              "```json\n" +
              JSON.stringify({ parameters: ex.parameters, mapper: ex.mapper }, null, 2) +
              "\n```\n";
          });
        }
      }
      return text(out);
    },
  );

  server.registerTool(
    "list_apps",
    {
      title: "List / search Make apps",
      description:
        "List or search Make apps from the full integrations catalog (~3000+ apps). Pass a query to filter by name/description/category. Apps with module_count>0 have detailed schemas available; others resolve module schemas on demand via get_module.",
      inputSchema: {
        query: z.string().optional().describe("Filter apps by name/description/category, e.g. 'crm', 'google', 'sms'."),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)."),
      },
    },
    async ({ query, limit }) => {
      const db = ctx.getDb();
      const apps = db.listApps({ query, limit });
      const total = db.catalogCount();
      if (apps.length === 0) return text(`No apps found for "${query ?? ""}". Catalog has ${total} apps total.`);
      const lines = apps.map(
        (a) =>
          `- ${a.name}${a.label && a.label !== a.name ? ` (${a.label})` : ""}` +
          (a.module_count ? ` — ${a.module_count} module(s) with schemas` : "") +
          (a.category ? `  [${a.category}]` : "") +
          (a.description ? `\n    ${a.description}` : ""),
      );
      return text(
        `${query ? `Apps matching "${query}"` : "Apps"} (showing ${apps.length} of ${total} in catalog):\n${lines.join("\n")}`,
      );
    },
  );

  server.registerTool(
    "search_templates",
    {
      title: "Search scenario templates",
      description:
        "Search reusable Make scenario blueprints (templates) by name or by app used. Returns template ids to fetch with get_template.",
      inputSchema: {
        query: z.string().describe("Search text, e.g. 'slack', 'webhook openai', an app name or scenario topic."),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, limit }) => {
      const rows = ctx.getDb().searchTemplates(query, limit ?? 15);
      if (rows.length === 0) return text(`No templates found for "${query}".`);
      const lines = rows.map((r) => `- [#${r.id}] ${r.name ?? "(unnamed)"}  apps: ${r.apps.join(", ")}  (${r.source})`);
      return text(`Found ${rows.length} template(s):\n${lines.join("\n")}\n\nUse get_template with an id to get the full blueprint.`);
    },
  );

  server.registerTool(
    "get_template",
    {
      title: "Get scenario template blueprint",
      description: "Get the full blueprint JSON of a template by id. Use it as a starting point to adapt and deploy.",
      inputSchema: {
        id: z.number().int().describe("Template id from search_templates."),
      },
    },
    async ({ id }) => {
      const tpl = ctx.getDb().getTemplate(id);
      if (!tpl) return text(`Template #${id} not found.`);
      return text(
        `# Template #${tpl.id}: ${tpl.name ?? "(unnamed)"}\n\n` +
          "```json\n" +
          JSON.stringify(tpl.blueprint, null, 2) +
          "\n```",
      );
    },
  );
}
