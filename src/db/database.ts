/**
 * SQLite knowledge store using the built-in `node:sqlite` module (Node >= 22.5).
 * No native compilation needed (avoids better-sqlite3 build pain on Windows).
 *
 * The DB is built offline by `npm run build:db` and shipped in data/make.db.
 * At runtime the discovery tools open it read-only.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AppSpec, ModuleExample, ModuleSpec, ParamSpec } from "../knowledge/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location of the shipped DB: <packageRoot>/data/make.db */
export function defaultDbPath(): string {
  // dist/db/database.js -> ../../data/make.db ; src/db/database.ts -> ../../data/make.db
  return join(__dirname, "..", "..", "data", "make.db");
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS apps (
  name        TEXT PRIMARY KEY,   -- app slug, e.g. "google-sheets"
  label       TEXT,
  module_count INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  category    TEXT,
  in_catalog  INTEGER NOT NULL DEFAULT 0  -- 1 = present in Make's public integrations catalog
);

CREATE TABLE IF NOT EXISTS modules (
  module          TEXT PRIMARY KEY,   -- "slack:CreateMessage"
  app             TEXT NOT NULL,
  action          TEXT NOT NULL,
  version         INTEGER,
  label           TEXT,
  kind            TEXT,               -- trigger | action | search | other
  connection_type TEXT,
  example_count   INTEGER NOT NULL DEFAULT 0,
  keywords        TEXT,               -- space-separated search keywords
  usage           TEXT,               -- keyword-rich "how to use" doc (markdown)
  usage_enriched  INTEGER NOT NULL DEFAULT 0  -- 1 = LLM-written rich doc, 0 = baseline/none
);
CREATE INDEX IF NOT EXISTS idx_modules_app ON modules(app);

CREATE TABLE IF NOT EXISTS parameters (
  module    TEXT NOT NULL,
  name      TEXT NOT NULL,
  type      TEXT,
  label     TEXT,
  required  INTEGER NOT NULL DEFAULT 0,
  enum_json TEXT,                      -- JSON array of allowed values, or NULL
  section   TEXT NOT NULL,             -- parameters | mapper
  PRIMARY KEY (module, name, section)
);

CREATE TABLE IF NOT EXISTS examples (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  module         TEXT NOT NULL,
  parameters_json TEXT,
  mapper_json    TEXT,
  source         TEXT
);
CREATE INDEX IF NOT EXISTS idx_examples_module ON examples(module);

CREATE TABLE IF NOT EXISTS templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT,
  apps_json      TEXT,                 -- JSON array of app names used
  blueprint_json TEXT,
  source         TEXT
);

-- Tracks scraper progress so the SDK-apps ingest is resumable across runs.
CREATE TABLE IF NOT EXISTS scrape_state (
  app      TEXT PRIMARY KEY,
  version  TEXT,
  modules  INTEGER NOT NULL DEFAULT 0,
  done     INTEGER NOT NULL DEFAULT 0,
  error    TEXT,
  updated  TEXT
);
`;

export interface ModuleSearchRow {
  module: string;
  app: string;
  action: string;
  version: number | null;
  label: string | null;
  kind: string | null;
  connection_type: string | null;
  example_count: number;
  keywords?: string | null;
  usage?: string | null;
}

/** Split a camelCase / snake / kebab identifier into lowercase word tokens. */
function tokenizeIdentifier(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-:]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Build a deduped space-separated keyword string from a module's identifiers + schema. */
export function computeKeywords(spec: ModuleSpec): string {
  const words = new Set<string>();
  const add = (s?: string) => {
    if (s) for (const w of tokenizeIdentifier(s)) words.add(w);
  };
  add(spec.module);
  add(spec.app);
  add(spec.action);
  add(spec.label);
  add(spec.kind);
  add(spec.description);
  for (const p of spec.params) {
    add(p.name);
    add(p.label);
    if (p.enum) for (const e of p.enum) add(e);
  }
  return [...words].join(" ");
}

export interface TemplateRow {
  id: number;
  name: string | null;
  apps: string[];
  source: string | null;
}

export class MakeKnowledgeDB {
  readonly db: DatabaseSync;

  constructor(path: string, opts: { readOnly?: boolean; create?: boolean } = {}) {
    this.db = new DatabaseSync(path, {
      open: true,
      readOnly: opts.readOnly ?? false,
      // `create` only matters for writable opens.
      ...(opts.create !== undefined ? { create: opts.create } : {}),
    } as any);
  }

  static openReadOnly(path = defaultDbPath()): MakeKnowledgeDB {
    if (!existsSync(path)) {
      throw new Error(
        `Knowledge DB not found at ${path}. Run \`npm run build:db\` to build it from data/corpus/.`,
      );
    }
    return new MakeKnowledgeDB(path, { readOnly: true });
  }

  initSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  /** Add columns introduced after a DB was first built (idempotent). */
  private migrate(): void {
    const modCols = (this.db.prepare(`PRAGMA table_info(modules)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!modCols.includes("usage_enriched")) {
      this.db.exec(`ALTER TABLE modules ADD COLUMN usage_enriched INTEGER NOT NULL DEFAULT 0`);
    }
    const appCols = (this.db.prepare(`PRAGMA table_info(apps)`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const [col, ddl] of [
      ["description", `ALTER TABLE apps ADD COLUMN description TEXT`],
      ["category", `ALTER TABLE apps ADD COLUMN category TEXT`],
      ["in_catalog", `ALTER TABLE apps ADD COLUMN in_catalog INTEGER NOT NULL DEFAULT 0`],
    ] as const) {
      if (!appCols.includes(col)) this.db.exec(ddl);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- write side (used by build.ts) ----

  upsertModule(spec: ModuleSpec): void {
    const keywords = computeKeywords(spec);
    // Baseline usage = official description; preserved if a richer usage doc exists.
    const baselineUsage = spec.description?.trim() || null;
    this.db
      .prepare(
        `INSERT INTO modules (module, app, action, version, label, kind, connection_type, example_count, keywords, usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(module) DO UPDATE SET
           version=excluded.version, label=COALESCE(excluded.label, modules.label),
           kind=excluded.kind, connection_type=COALESCE(excluded.connection_type, modules.connection_type),
           example_count=modules.example_count + excluded.example_count,
           keywords=excluded.keywords,
           usage=COALESCE(modules.usage, excluded.usage)`,
      )
      .run(
        spec.module,
        spec.app,
        spec.action,
        spec.version ?? null,
        spec.label ?? null,
        spec.kind,
        spec.connectionType ?? null,
        spec.examples.length,
        keywords,
        baselineUsage,
      );

    const insParam = this.db.prepare(
      `INSERT INTO parameters (module, name, type, label, required, enum_json, section)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(module, name, section) DO UPDATE SET
         type=COALESCE(excluded.type, parameters.type),
         label=COALESCE(excluded.label, parameters.label),
         required=MAX(parameters.required, excluded.required),
         enum_json=COALESCE(excluded.enum_json, parameters.enum_json)`,
    );
    for (const p of spec.params) {
      insParam.run(
        spec.module,
        p.name,
        p.type ?? null,
        p.label ?? null,
        p.required ? 1 : 0,
        p.enum ? JSON.stringify(p.enum) : null,
        p.section,
      );
    }

    const insEx = this.db.prepare(
      `INSERT INTO examples (module, parameters_json, mapper_json, source) VALUES (?, ?, ?, ?)`,
    );
    for (const ex of spec.examples) {
      insEx.run(spec.module, JSON.stringify(ex.parameters), JSON.stringify(ex.mapper), ex.source);
    }
  }

  upsertApp(app: AppSpec, moduleCount: number): void {
    this.db
      .prepare(
        `INSERT INTO apps (name, label, module_count) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET label=COALESCE(excluded.label, apps.label), module_count=excluded.module_count`,
      )
      .run(app.name, app.label ?? null, moduleCount);
  }

  /** Insert/refresh a catalog app (from Make's public integrations directory) without clobbering scraped data. */
  upsertCatalogApp(slug: string, label?: string, description?: string, category?: string): void {
    this.db
      .prepare(
        `INSERT INTO apps (name, label, module_count, description, category, in_catalog)
         VALUES (?, ?, 0, ?, ?, 1)
         ON CONFLICT(name) DO UPDATE SET
           label=COALESCE(apps.label, excluded.label),
           description=COALESCE(excluded.description, apps.description),
           category=COALESCE(excluded.category, apps.category),
           in_catalog=1`,
      )
      .run(slug, label ?? null, description ?? null, category ?? null);
  }

  catalogCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM apps WHERE in_catalog = 1`).get() as { c: number }).c;
  }

  insertTemplate(name: string | null, apps: string[], blueprintJson: string, source: string): void {
    this.db
      .prepare(`INSERT INTO templates (name, apps_json, blueprint_json, source) VALUES (?, ?, ?, ?)`)
      .run(name, JSON.stringify(apps), blueprintJson, source);
  }

  // ---- read side (used by discovery tools) ----

  searchModules(query: string, limit = 25): ModuleSearchRow[] {
    // Tokenize on whitespace/hyphens; every token must match the normalized
    // haystack (module+app+action+label, hyphens treated as spaces). This makes
    // "google sheets" match "google-sheets:addRow".
    // Rank by how many query tokens match (OR with scoring), so natural-language
    // queries with filler words ("loop over array items") still find the best
    // modules. Stopwords are dropped; results need at least one token match.
    const STOP = new Set(["the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "with", "over", "into", "by", "from", "as", "is", "be"]);
    const tokens = query
      .toLowerCase()
      .split(/[\s\-:]+/)
      .filter((t) => t && !STOP.has(t));
    if (tokens.length === 0) return [];
    const haystack = `replace(lower(module || ' ' || app || ' ' || action || ' ' || COALESCE(label,'') || ' ' || COALESCE(keywords,'') || ' ' || COALESCE(usage,'')), '-', ' ')`;
    const score = tokens.map(() => `(CASE WHEN ${haystack} LIKE ? THEN 1 ELSE 0 END)`).join(" + ");
    const args = tokens.map((t) => `%${t}%`);
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT module, app, action, version, label, kind, connection_type, example_count, keywords, usage,
                  (${score}) AS score
           FROM modules
         )
         WHERE score > 0
         ORDER BY score DESC, example_count DESC, module ASC
         LIMIT ?`,
      )
      .all(...args, limit) as unknown as ModuleSearchRow[];
  }

  getModule(module: string): ModuleSearchRow | undefined {
    return this.db
      .prepare(
        `SELECT module, app, action, version, label, kind, connection_type, example_count, keywords, usage FROM modules WHERE module = ?`,
      )
      .get(module) as unknown as ModuleSearchRow | undefined;
  }

  /** Set the keyword-rich usage doc for a module (written by the doc-generation loop). Marks it enriched. */
  setUsage(module: string, usage: string, extraKeywords?: string): void {
    const info = this.db
      .prepare(
        `UPDATE modules SET usage = ?, usage_enriched = 1,
           keywords = TRIM(COALESCE(keywords,'') || ' ' || COALESCE(?, '')) WHERE module = ?`,
      )
      .run(usage, extraKeywords ?? null, module);
    if (info.changes === 0) throw new Error(`setUsage: module not found: ${module}`);
  }

  /** Modules that still lack a usage doc (for resumable doc generation). */
  modulesMissingUsage(limit = 50): string[] {
    return (
      this.db
        .prepare(`SELECT module FROM modules WHERE usage IS NULL OR usage = '' ORDER BY example_count DESC, module ASC LIMIT ?`)
        .all(limit) as unknown as Array<{ module: string }>
    ).map((r) => r.module);
  }

  hasParameters(module: string): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) c FROM parameters WHERE module = ?`).get(module) as { c: number };
    return row.c > 0;
  }

  getParameters(module: string): ParamSpec[] {
    const rows = this.db
      .prepare(`SELECT name, type, label, required, enum_json, section FROM parameters WHERE module = ? ORDER BY section, name`)
      .all(module) as unknown as Array<{
      name: string;
      type: string | null;
      label: string | null;
      required: number;
      enum_json: string | null;
      section: "parameters" | "mapper";
    }>;
    return rows.map((r) => ({
      name: r.name,
      type: r.type ?? "text",
      label: r.label ?? undefined,
      required: r.required === 1,
      enum: r.enum_json ? (JSON.parse(r.enum_json) as string[]) : undefined,
      section: r.section,
    }));
  }

  getExamples(module: string, limit = 3): ModuleExample[] {
    const rows = this.db
      .prepare(`SELECT parameters_json, mapper_json, source FROM examples WHERE module = ? LIMIT ?`)
      .all(module, limit) as unknown as Array<{ parameters_json: string; mapper_json: string; source: string }>;
    return rows.map((r) => ({
      parameters: JSON.parse(r.parameters_json),
      mapper: JSON.parse(r.mapper_json),
      source: r.source,
    }));
  }

  listApps(opts: { query?: string; limit?: number } = {}): Array<{
    name: string;
    label: string | null;
    module_count: number;
    description: string | null;
    category: string | null;
  }> {
    const limit = opts.limit ?? 50;
    const tokens = (opts.query ?? "").toLowerCase().split(/[\s\-:]+/).filter(Boolean);
    const haystack = `replace(lower(name || ' ' || COALESCE(label,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(category,'')), '-', ' ')`;
    const where = tokens.length ? "WHERE " + tokens.map(() => `${haystack} LIKE ?`).join(" AND ") : "";
    const args = tokens.map((t) => `%${t}%`);
    return this.db
      .prepare(
        `SELECT name, label, module_count, description, category FROM apps ${where}
         ORDER BY module_count DESC, name ASC LIMIT ?`,
      )
      .all(...args, limit) as unknown as Array<{
      name: string;
      label: string | null;
      module_count: number;
      description: string | null;
      category: string | null;
    }>;
  }

  searchTemplates(query: string, limit = 15): TemplateRow[] {
    const tokens = query.toLowerCase().split(/[\s\-:]+/).filter(Boolean);
    const haystack = `replace(lower(COALESCE(name,'') || ' ' || COALESCE(apps_json,'') || ' ' || COALESCE(source,'')), '-', ' ')`;
    const where = tokens.length ? tokens.map(() => `${haystack} LIKE ?`).join(" AND ") : "1=1";
    const args = tokens.map((t) => `%${t}%`);
    const rows = this.db
      .prepare(`SELECT id, name, apps_json, source FROM templates WHERE ${where} ORDER BY id ASC LIMIT ?`)
      .all(...args, limit) as unknown as Array<{ id: number; name: string | null; apps_json: string; source: string | null }>;
    return rows.map((r) => ({ id: r.id, name: r.name, apps: JSON.parse(r.apps_json || "[]"), source: r.source }));
  }

  getTemplate(id: number): { id: number; name: string | null; blueprint: unknown } | undefined {
    const row = this.db
      .prepare(`SELECT id, name, blueprint_json FROM templates WHERE id = ?`)
      .get(id) as unknown as { id: number; name: string | null; blueprint_json: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, blueprint: JSON.parse(row.blueprint_json) };
  }

  // ---- scrape progress (used by the SDK-apps scraper) ----

  isAppScraped(app: string): boolean {
    const row = this.db.prepare(`SELECT done FROM scrape_state WHERE app = ?`).get(app) as { done: number } | undefined;
    return row?.done === 1;
  }

  markAppScraped(app: string, version: string, modules: number, error?: string): void {
    this.db
      .prepare(
        `INSERT INTO scrape_state (app, version, modules, done, error, updated)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(app) DO UPDATE SET version=excluded.version, modules=excluded.modules, done=excluded.done, error=excluded.error, updated=excluded.updated`,
      )
      .run(app, version, modules, error ? 0 : 1, error ?? null);
  }

  scrapeStats(): { appsDone: number; appsError: number } {
    const done = (this.db.prepare(`SELECT COUNT(*) c FROM scrape_state WHERE done = 1`).get() as { c: number }).c;
    const err = (this.db.prepare(`SELECT COUNT(*) c FROM scrape_state WHERE done = 0`).get() as { c: number }).c;
    return { appsDone: done, appsError: err };
  }

  stats(): { apps: number; modules: number; examples: number; templates: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      apps: one("SELECT COUNT(*) c FROM apps"),
      modules: one("SELECT COUNT(*) c FROM modules"),
      examples: one("SELECT COUNT(*) c FROM examples"),
      templates: one("SELECT COUNT(*) c FROM templates"),
    };
  }
}
