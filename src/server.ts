/**
 * Builds the MakeMCP server and registers all available tools.
 *
 * Tools are grouped by purpose:
 *   - documentation:  tools_documentation
 *   - discovery:      search_modules, get_module, list_apps, search_templates, get_template   (Phase 2)
 *   - validate/build: validate_module, validate_scenario                                       (Phase 3)
 *   - manage:         make_health_check, make_create_scenario, ...                             (Phase 4)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createContext } from "./context.js";
import { registerDocumentation } from "./tools/documentation.js";
import { registerDiscovery } from "./tools/discovery/index.js";
import { registerValidate } from "./tools/validate/index.js";
import { registerHealthCheck } from "./tools/manage/healthCheck.js";
import { registerScenarioTools } from "./tools/manage/scenarios.js";
import { registerResourceTools } from "./tools/manage/resources.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "makemcp",
    version: "0.1.0",
  });

  const ctx = createContext();

  // Phase 0
  registerDocumentation(server, ctx);
  registerHealthCheck(server, ctx);

  // Phase 2 — discovery
  registerDiscovery(server, ctx);

  // Phase 3 — validation / build
  registerValidate(server, ctx);

  // Phase 4 — management / deploy (write)
  registerScenarioTools(server, ctx);
  registerResourceTools(server, ctx);

  return server;
}
