/**
 * Applies keyword-rich usage docs to modules from a JSON file.
 * This is the write step of the doc-enrichment loop.
 *
 * Run:  npx tsx src/knowledge/applyUsage.ts <file.json>
 * File format: [{ "module": "app:action", "usage": "markdown...", "keywords": "extra kw" }, ...]
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { MakeKnowledgeDB } from "../db/database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DB_PATH = join(ROOT, "data", "make.db");
const log = (m: string) => process.stderr.write(m + "\n");

interface UsageEntry {
  module: string;
  usage: string;
  keywords?: string;
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    log("Usage: tsx src/knowledge/applyUsage.ts <file.json>");
    process.exit(1);
  }
  const path = isAbsolute(arg) ? arg : join(ROOT, arg);
  if (!existsSync(path)) {
    log(`File not found: ${path}`);
    process.exit(1);
  }
  if (!existsSync(DB_PATH)) {
    log(`No DB at ${DB_PATH}. Run \`npm run build:db\` first.`);
    process.exit(1);
  }

  const entries = JSON.parse(readFileSync(path, "utf8")) as UsageEntry[];
  const db = new MakeKnowledgeDB(DB_PATH, { readOnly: false });
  db.initSchema();
  let ok = 0;
  const missing: string[] = [];
  for (const e of entries) {
    try {
      db.setUsage(e.module, e.usage, e.keywords);
      ok++;
    } catch {
      missing.push(e.module);
    }
  }
  db.close();
  log(`Applied ${ok}/${entries.length} usage docs.${missing.length ? ` Missing modules: ${missing.join(", ")}` : ""}`);
}

main();
