/**
 * validate_scenario — validate + autofix + enrich a Make blueprint before deploy.
 * Validate + autofix + enrich a Make blueprint before deploy.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../../context.js";
import { validateBlueprint, type ParamResolver } from "../../blueprint/validator.js";
import type { Blueprint } from "../../knowledge/types.js";

/** Accept a blueprint as a JSON string or an object. */
export function coerceBlueprint(input: unknown): Blueprint {
  if (typeof input === "string") return JSON.parse(input) as Blueprint;
  return input as Blueprint;
}

/** Param resolver preferring the DB, falling back to the session cache of lazily-loaded schemas. */
export function makeResolver(ctx: ServerContext): ParamResolver {
  const db = ctx.getDb();
  return (module: string) => {
    const fromDb = db.getParameters(module);
    if (fromDb.length) return fromDb;
    return ctx.paramCache.get(module) ?? fromDb;
  };
}

export function registerValidate(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "validate_scenario",
    {
      title: "Validate Make scenario blueprint",
      description:
        "Validate a Make blueprint and return errors, warnings, applied autofixes, and a corrected+enriched blueprint ready to deploy. " +
        "Checks: flow structure, unique module ids, required parameters/mapper fields (from the knowledge DB), IML {{id.field}} references, and fills metadata + designer layout. " +
        "Always run this before make_create_scenario.",
      inputSchema: {
        blueprint: z
          .union([z.string(), z.record(z.any())])
          .describe("The Make blueprint as a JSON object or JSON string: { name, flow: [...modules], metadata }."),
      },
    },
    async ({ blueprint }) => {
      let bp: Blueprint;
      try {
        bp = coerceBlueprint(blueprint);
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: `Could not parse blueprint JSON: ${(e as Error).message}` }],
        };
      }

      const result = validateBlueprint(ctx.getDb(), bp, makeResolver(ctx));
      const errors = result.issues.filter((i) => i.level === "error");
      const warnings = result.issues.filter((i) => i.level === "warning");

      const fmtIssue = (i: { moduleId?: number; module?: string; message: string }) =>
        `  - ${i.module ? `[${i.module}${i.moduleId != null ? ` #${i.moduleId}` : ""}] ` : i.moduleId != null ? `[#${i.moduleId}] ` : ""}${i.message}`;

      let out = result.valid
        ? `✅ Blueprint is VALID${warnings.length ? ` (with ${warnings.length} warning(s))` : ""}.\n`
        : `❌ Blueprint is INVALID — ${errors.length} error(s) must be fixed.\n`;

      if (errors.length) out += `\nErrors:\n${errors.map(fmtIssue).join("\n")}\n`;
      if (warnings.length) out += `\nWarnings:\n${warnings.map(fmtIssue).join("\n")}\n`;
      if (result.fixes.length) out += `\nAutofixes applied:\n${result.fixes.map((f) => `  - ${f}`).join("\n")}\n`;

      out +=
        `\nCorrected + enriched blueprint${result.valid ? " (deploy this)" : " (fix errors, then re-validate)"}:\n` +
        "```json\n" +
        JSON.stringify(result.blueprint, null, 2) +
        "\n```";

      return { content: [{ type: "text", text: out }] };
    },
  );
}
