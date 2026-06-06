/**
 * Blueprint validation, autofix and enrichment.
 *
 * Claude authors a Make blueprint flow[] using the module schemas from get_module.
 * Before deploying we:
 *   - validate structure, unique ids, module ids, required params, IML references
 *   - autofix what's safe (assign ids, default versions, designer layout, metadata)
 *   - enrich each module with metadata.parameters/expect from the knowledge DB so
 *     the scenario renders correctly when imported into Make.
 */

import type { MakeKnowledgeDB } from "../db/database.js";
import { flattenModules } from "../knowledge/miner.js";
import type { Blueprint, BlueprintModule, ParamSpec, RawFieldSpec } from "../knowledge/types.js";

export interface ValidationIssue {
  level: "error" | "warning";
  module?: string;
  moduleId?: number;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  fixes: string[];
  /** The autofixed + enriched blueprint (safe to deploy if valid). */
  blueprint: Blueprint;
}

const IML_MODULE_REF = /\{\{[^}]*?\b(\d+)\.[a-zA-Z_]/g;

function collectIds(modules: BlueprintModule[]): Set<number> {
  const ids = new Set<number>();
  for (const m of modules) if (typeof m.id === "number") ids.add(m.id);
  return ids;
}

function extractRefs(value: unknown, out: Set<number>): void {
  if (typeof value === "string") {
    let match: RegExpExecArray | null;
    IML_MODULE_REF.lastIndex = 0;
    while ((match = IML_MODULE_REF.exec(value)) !== null) out.add(Number(match[1]));
  } else if (Array.isArray(value)) {
    for (const v of value) extractRefs(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) extractRefs(v, out);
  }
}

/** Resolves a module's param schema; lets callers inject a session cache on top of the DB. */
export type ParamResolver = (module: string) => ParamSpec[];

/** Build schema lookup for a module, separated by section. */
function schemaFor(db: MakeKnowledgeDB, module: string, resolve: ParamResolver): { params: ParamSpec[]; known: boolean } {
  const mod = db.getModule(module);
  if (!mod) return { params: [], known: false };
  return { params: resolve(module), known: true };
}

export function validateBlueprint(db: MakeKnowledgeDB, input: Blueprint, resolveParams?: ParamResolver): ValidationResult {
  const resolve: ParamResolver = resolveParams ?? ((m) => db.getParameters(m));
  const issues: ValidationIssue[] = [];
  const fixes: string[] = [];

  // Work on a deep copy so we can autofix without mutating the caller's object.
  const bp: Blueprint = JSON.parse(JSON.stringify(input ?? {}));

  if (!Array.isArray(bp.flow)) {
    issues.push({ level: "error", message: "Blueprint has no `flow` array." });
    return { valid: false, issues, fixes, blueprint: bp };
  }

  if (!bp.name) {
    bp.name = "Untitled scenario";
    fixes.push('Added default name "Untitled scenario".');
  }

  // Top-level metadata defaults (Make expects these).
  const defaultMeta = {
    instant: false,
    version: 1,
    scenario: { roundtrips: 1, maxErrors: 3, autoCommit: true, sequential: false, confidential: false },
    designer: { orphans: [] },
  };
  bp.metadata = { ...defaultMeta, ...(bp.metadata ?? {}) } as Record<string, unknown>;

  const allModules = flattenModules(bp.flow);
  const definedIds = collectIds(allModules);

  // Assign missing/duplicate ids.
  const usedIds = new Set<number>();
  let nextId = (definedIds.size ? Math.max(...definedIds) : 0) + 1;
  const assignIds = (mods: BlueprintModule[]) => {
    for (const m of mods) {
      if (typeof m.id !== "number" || usedIds.has(m.id)) {
        const newId = nextId++;
        if (typeof m.id === "number" && usedIds.has(m.id))
          fixes.push(`Reassigned duplicate module id ${m.id} -> ${newId} (${m.module}).`);
        else fixes.push(`Assigned missing id ${newId} to module ${m.module}.`);
        m.id = newId;
      }
      usedIds.add(m.id);
      if (Array.isArray(m.routes)) for (const r of m.routes) if (Array.isArray(r.flow)) assignIds(r.flow);
    }
  };
  assignIds(bp.flow);

  const refExists = collectIds(flattenModules(bp.flow));

  // Per-module checks + enrichment + designer layout.
  let x = 0;
  const enrich = (mods: BlueprintModule[]) => {
    for (const m of mods) {
      if (!m.module || typeof m.module !== "string" || !m.module.includes(":")) {
        issues.push({
          level: "error",
          moduleId: m.id,
          message: `Module id ${m.id} has invalid \`module\` (expected "app:action", got ${JSON.stringify(m.module)}).`,
        });
      } else {
        const { params, known } = schemaFor(db, m.module, resolve);
        if (!known) {
          issues.push({
            level: "warning",
            module: m.module,
            moduleId: m.id,
            message: `Module "${m.module}" is not in the knowledge DB — cannot verify its parameters. Verify manually or add an example to data/corpus.`,
          });
        } else {
          // Default version from DB if missing.
          if (typeof m.version !== "number") {
            const dbMod = db.getModule(m.module);
            m.version = dbMod?.version ?? 1;
            fixes.push(`Set version ${m.version} for ${m.module} (id ${m.id}).`);
          }
          // Required params present?
          m.parameters ??= {};
          m.mapper ??= {};
          for (const p of params) {
            if (!p.required) continue;
            const bag = p.section === "parameters" ? m.parameters : m.mapper;
            const present = bag && Object.prototype.hasOwnProperty.call(bag, p.name) && bag[p.name] != null && bag[p.name] !== "";
            if (!present) {
              if (p.name === "__IMTCONN__") {
                issues.push({
                  level: "warning",
                  module: m.module,
                  moduleId: m.id,
                  message: `Requires a connection (account:${p.type.slice("account:".length)}). Set parameters.__IMTCONN__ to a connection id from your Make account (list via the Make UI or API).`,
                });
              } else {
                issues.push({
                  level: "error",
                  module: m.module,
                  moduleId: m.id,
                  message: `Missing required ${p.section} field "${p.name}"${p.label ? ` (${p.label})` : ""}${p.enum ? ` — one of: ${p.enum.join(", ")}` : ""}.`,
                });
              }
            }
          }
          // Enrich metadata so it renders in Make.
          m.metadata ??= {};
          const configSchema = params.filter((p) => p.section === "parameters");
          const mapperSchema = params.filter((p) => p.section === "mapper");
          if (configSchema.length && !m.metadata.parameters) {
            m.metadata.parameters = configSchema.map(toRawField);
          }
          if (mapperSchema.length && !m.metadata.expect) {
            m.metadata.expect = mapperSchema.map(toRawField);
          }
        }
      }

      // Designer layout (left to right).
      m.metadata ??= {};
      if (!m.metadata.designer || typeof m.metadata.designer.x !== "number") {
        m.metadata.designer = { x, y: 0 };
      }
      x += 300;

      if (Array.isArray(m.routes)) for (const r of m.routes) if (Array.isArray(r.flow)) enrich(r.flow);
    }
  };
  enrich(bp.flow);

  // IML reference validation.
  const refs = new Set<number>();
  for (const m of flattenModules(bp.flow)) {
    extractRefs(m.mapper, refs);
    extractRefs(m.parameters, refs);
    extractRefs(m.filter, refs);
  }
  for (const ref of refs) {
    if (!refExists.has(ref)) {
      issues.push({
        level: "error",
        message: `IML expression references module {{${ref}.…}} but no module has id ${ref}.`,
      });
    }
  }

  const valid = issues.every((i) => i.level !== "error");
  return { valid, issues, fixes, blueprint: bp };
}

function toRawField(p: ParamSpec): RawFieldSpec {
  const f: RawFieldSpec = { name: p.name, type: p.type };
  if (p.label) f.label = p.label;
  if (p.required) f.required = true;
  if (p.enum) f.validate = { enum: p.enum };
  return f;
}
