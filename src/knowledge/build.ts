/**
 * Builds data/make.db from the blueprint corpus in data/corpus/.
 *
 * Run: `npm run build:db`
 *
 * Each *.json in data/corpus is treated as a Make blueprint: we mine module
 * schemas + examples from it and also index it as a reusable template.
 * Drop your own exported scenario blueprints into data/corpus/ to enrich the DB
 * (export via Make API: GET /api/v2/scenarios/{id}/blueprint).
 */

import { readFileSync, readdirSync, rmSync, existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { MakeKnowledgeDB } from "../db/database.js";
import { mineBlueprint, mergeSpecs, appsInBlueprint } from "./miner.js";
import type { Blueprint, ModuleSpec } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CORPUS_DIR = join(ROOT, "data", "corpus");
const DB_PATH = join(ROOT, "data", "make.db");

/** App display labels for the MVP set (extend as the corpus grows). */
const APP_LABELS: Record<string, string> = {
  http: "HTTP",
  json: "JSON",
  webhook: "Webhooks",
  gateway: "Webhooks",
  "google-sheets": "Google Sheets",
  "google-email": "Gmail",
  gmail: "Gmail",
  slack: "Slack",
  openai: "OpenAI",
  "openai-gpt-3": "OpenAI (ChatGPT)",
  asana: "Asana",
  airtable: "Airtable",
  builtin: "Flow control",
  util: "Tools",
  tools: "Tools",
  "google-drive": "Google Drive",
  stripe: "Stripe",
  telegram: "Telegram Bot",
  zoom: "Zoom",
  calendly: "Calendly",
  vapi: "Vapi",
  email: "Email (IMAP/SMTP)",
};

function findJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findJsonFiles(full));
    else if (entry.toLowerCase().endsWith(".json")) out.push(full);
  }
  return out;
}

function main(): void {
  if (!existsSync(join(ROOT, "data"))) mkdirSync(join(ROOT, "data"), { recursive: true });
  if (existsSync(DB_PATH)) rmSync(DB_PATH);

  const db = new MakeKnowledgeDB(DB_PATH, { readOnly: false, create: true });
  db.initSchema();

  const files = findJsonFiles(CORPUS_DIR);
  console.error(`Found ${files.length} blueprint file(s) in ${relative(ROOT, CORPUS_DIR)}`);

  const merged = new Map<string, ModuleSpec>();
  let templateCount = 0;

  for (const file of files) {
    const source = relative(ROOT, file).replace(/\\/g, "/");
    let bp: Blueprint;
    try {
      bp = JSON.parse(readFileSync(file, "utf8")) as Blueprint;
    } catch (e) {
      console.error(`  ! skip ${source}: invalid JSON (${(e as Error).message})`);
      continue;
    }
    if (!Array.isArray(bp.flow)) {
      console.error(`  ! skip ${source}: no flow[] array`);
      continue;
    }

    const specs = mineBlueprint(bp, source);
    for (const [mod, spec] of specs) {
      const existing = merged.get(mod);
      merged.set(mod, existing ? mergeSpecs(existing, spec) : spec);
    }

    // Index as a template.
    db.insertTemplate(bp.name ?? null, appsInBlueprint(bp), JSON.stringify(bp), source);
    templateCount++;
  }

  // Write modules + parameters + examples.
  const appModuleCounts = new Map<string, number>();
  for (const spec of merged.values()) {
    db.upsertModule(spec);
    appModuleCounts.set(spec.app, (appModuleCounts.get(spec.app) ?? 0) + 1);
  }
  for (const [app, count] of appModuleCounts) {
    db.upsertApp({ name: app, label: APP_LABELS[app] }, count);
  }

  const stats = db.stats();
  db.close();
  console.error(
    `Built ${relative(ROOT, DB_PATH)}: ${stats.apps} apps, ${stats.modules} modules, ` +
      `${stats.examples} examples, ${stats.templates} templates (${templateCount} blueprints indexed).`,
  );
}

main();
