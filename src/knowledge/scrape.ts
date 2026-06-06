/**
 * Scrapes the full Make app/module/parameter catalog from the SDK Apps API
 * into data/make.db. Resumable and throttled — safe to run in the background
 * and to re-run (skips apps already done).
 *
 * Run:  npx tsx src/knowledge/scrape.ts [maxApps] [--deep]
 *   maxApps  optional limit for testing (e.g. 5).
 *   --deep   also fetch full parameter+expect schemas per module (many more calls).
 *            Default is shallow: one call per app captures every module's
 *            name/label/description/type/connection. Schemas are then loaded
 *            lazily on demand by get_module.
 *
 * Env (from .env): MAKE_API_KEY, MAKE_ZONE (or MAKE_API_URL). Needs scope sdk-apps:read.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { MakeKnowledgeDB } from "../db/database.js";
import { SdkAppsClient } from "./sources/sdkApps.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "..", "data", "make.db");

const log = (m: string) => process.stderr.write(m + "\n");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const deep = args.includes("--deep");
  const maxArg = args.find((a) => /^\d+$/.test(a));
  const maxApps = maxArg ? Number(maxArg) : Infinity;
  const config = loadConfig();
  if (!config.apiKey || !config.apiUrl) {
    log("Missing MAKE_API_KEY / MAKE_ZONE. Set them in .env. Needs scope sdk-apps:read.");
    process.exit(1);
  }
  if (!existsSync(DB_PATH)) {
    log(`No DB at ${DB_PATH}. Run \`npm run build:db\` first to create it.`);
    process.exit(1);
  }

  const db = new MakeKnowledgeDB(DB_PATH, { readOnly: false });
  db.initSchema(); // ensure scrape_state + columns exist

  const client = new SdkAppsClient({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    openSource: true,
    throttleMs: 350,
    log,
  });

  let appsSeen = 0;
  let modulesAdded = 0;
  let errors = 0;

  for await (const app of client.listApps()) {
    if (appsSeen >= maxApps) break;
    appsSeen++;

    if (db.isAppScraped(app.name)) {
      log(`[${appsSeen}] skip ${app.name} (already done)`);
      continue;
    }

    try {
      const modules = await client.listModules(app.name, app.version);
      let count = 0;
      for (const mod of modules) {
        try {
          const spec = deep ? await client.getModuleSpec(app, mod) : client.moduleMeta(app, mod);
          if (!spec.action) continue;
          db.upsertModule(spec);
          count++;
          modulesAdded++;
        } catch (e) {
          log(`    ! module ${app.name}:${mod?.name} failed: ${(e as Error).message}`);
        }
      }
      db.upsertApp({ name: app.name, label: app.label }, count);
      db.markAppScraped(app.name, String(app.version), count);
      log(`[${appsSeen}] ${app.name} (${app.label ?? ""}) -> ${count} module(s)`);
    } catch (e) {
      errors++;
      db.markAppScraped(app.name, String(app.version), 0, (e as Error).message);
      log(`[${appsSeen}] ${app.name} FAILED: ${(e as Error).message}`);
    }
  }

  const stats = db.stats();
  const ss = db.scrapeStats();
  db.close();
  log(
    `\nDone. Apps seen this run: ${appsSeen}, modules added: ${modulesAdded}, app errors: ${errors}.\n` +
      `DB totals: ${stats.apps} apps, ${stats.modules} modules. Scrape state: ${ss.appsDone} done, ${ss.appsError} errored.`,
  );
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
