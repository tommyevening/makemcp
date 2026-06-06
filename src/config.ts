/**
 * Runtime configuration, read from environment variables.
 *
 * Make credentials are optional at startup: discovery tools work fully offline
 * against the prebuilt SQLite knowledge DB. Only the write/management tools
 * (make_create_scenario, make_run_scenario, ...) require a configured API key.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface MakeConfig {
  apiKey?: string;
  teamId?: number;
  /** Resolved API base URL, e.g. https://eu2.make.com/api/v2 */
  apiUrl?: string;
}

/**
 * Load .env from the package root if present, so credentials work without
 * passing --env-file. Uses Node's built-in loader (no dependency).
 * Real env vars (e.g. from the Claude Desktop config) still take precedence
 * because loadEnvFile does not overwrite already-set variables.
 */
function loadDotEnv(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/config.js or src/config.ts -> ../.env
    const envPath = join(here, "..", ".env");
    if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
      process.loadEnvFile(envPath);
    }
  } catch {
    /* ignore: env may be provided directly */
  }
}
loadDotEnv();

function resolveApiUrl(): string | undefined {
  const explicit = process.env.MAKE_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const zone = process.env.MAKE_ZONE?.trim();
  if (zone) return `https://${zone}.make.com/api/v2`;

  return undefined;
}

export function loadConfig(): MakeConfig {
  const teamIdRaw = process.env.MAKE_TEAM_ID?.trim();
  const teamId = teamIdRaw ? Number(teamIdRaw) : undefined;

  return {
    apiKey: process.env.MAKE_API_KEY?.trim() || undefined,
    teamId: Number.isFinite(teamId) ? teamId : undefined,
    apiUrl: resolveApiUrl(),
  };
}

/**
 * Throws a descriptive error if the config is missing anything required for
 * live Make API calls. Used by management tools, not by discovery tools.
 */
export function assertApiConfigured(config: MakeConfig): asserts config is Required<Pick<MakeConfig, "apiKey" | "apiUrl">> & MakeConfig {
  const missing: string[] = [];
  if (!config.apiKey) missing.push("MAKE_API_KEY");
  if (!config.apiUrl) missing.push("MAKE_ZONE (or MAKE_API_URL)");
  if (missing.length > 0) {
    throw new Error(
      `Make API is not configured. Missing: ${missing.join(", ")}. ` +
        `Set these env vars to enable scenario management tools. ` +
        `See .env.example for details.`,
    );
  }
}
