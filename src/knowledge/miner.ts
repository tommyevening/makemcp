/**
 * Mines module schemas + examples out of real Make blueprints.
 *
 * For each module instance we read:
 *   - module / version
 *   - metadata.parameters -> ParamSpec[] (section "parameters")  + values from `parameters`
 *   - metadata.expect     -> ParamSpec[] (section "mapper")      + values from `mapper`
 *   - the __IMTCONN__ param's `account:<type>` -> connection requirement
 *
 * Specs for the same module across blueprints are merged by `mergeSpecs`.
 */

import type {
  Blueprint,
  BlueprintModule,
  ModuleSpec,
  ParamSpec,
  RawFieldSpec,
} from "./types.js";

function guessKind(action: string): ModuleSpec["kind"] {
  const a = action.toLowerCase();
  if (a.startsWith("watch") || a.startsWith("trigger")) return "trigger";
  if (a.startsWith("search") || a.startsWith("list") || a.startsWith("get") || a.startsWith("find")) return "search";
  if (
    a.startsWith("create") ||
    a.startsWith("add") ||
    a.startsWith("update") ||
    a.startsWith("delete") ||
    a.startsWith("send") ||
    a.startsWith("make")
  )
    return "action";
  return "other";
}

function toParamSpecs(fields: RawFieldSpec[] | undefined, section: ParamSpec["section"]): ParamSpec[] {
  if (!Array.isArray(fields)) return [];
  const out: ParamSpec[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    // Some nested/collection fields can lack a usable name — skip those.
    if (!f || typeof f.name !== "string" || f.name.length === 0) continue;
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    const enumVals = Array.isArray(f.validate?.enum)
      ? f.validate!.enum.filter((v): v is string => typeof v === "string")
      : undefined;
    out.push({
      name: f.name,
      type: typeof f.type === "string" ? f.type : "text",
      label: typeof f.label === "string" ? f.label : undefined,
      required: Boolean(f.required),
      enum: enumVals && enumVals.length > 0 ? enumVals : undefined,
      section,
    });
  }
  return out;
}

function connectionTypeFrom(params: ParamSpec[]): string | undefined {
  const conn = params.find((p) => p.name === "__IMTCONN__" && p.type?.startsWith("account:"));
  return conn ? conn.type.slice("account:".length) : undefined;
}

/** Flatten a blueprint flow, descending into router routes. */
export function flattenModules(flow: BlueprintModule[] | undefined): BlueprintModule[] {
  const out: BlueprintModule[] = [];
  const walk = (mods: BlueprintModule[] | undefined) => {
    if (!Array.isArray(mods)) return;
    for (const m of mods) {
      out.push(m);
      if (Array.isArray(m.routes)) for (const r of m.routes) walk(r.flow);
    }
  };
  walk(flow);
  return out;
}

export function mineModule(m: BlueprintModule, source: string): ModuleSpec | undefined {
  if (!m.module || typeof m.module !== "string") return undefined;
  const [app, ...rest] = m.module.split(":");
  const action = rest.join(":") || m.module;

  const params = [
    ...toParamSpecs(m.metadata?.parameters, "parameters"),
    ...toParamSpecs(m.metadata?.expect, "mapper"),
  ];

  return {
    module: m.module,
    app,
    action,
    version: typeof m.version === "number" ? m.version : 1,
    kind: guessKind(action),
    connectionType: connectionTypeFrom(params),
    params,
    examples: [
      {
        parameters: m.parameters ?? {},
        mapper: m.mapper ?? {},
        source,
      },
    ],
  };
}

/** Merge two specs for the same module: union params (by name+section), concat examples. */
export function mergeSpecs(a: ModuleSpec, b: ModuleSpec): ModuleSpec {
  const byKey = new Map<string, ParamSpec>();
  for (const p of [...a.params, ...b.params]) {
    const key = `${p.section}:${p.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...p });
    } else {
      byKey.set(key, {
        ...existing,
        required: existing.required || p.required,
        label: existing.label ?? p.label,
        type: existing.type ?? p.type,
        enum: existing.enum ?? p.enum,
      });
    }
  }
  return {
    ...a,
    version: Math.max(a.version, b.version),
    label: a.label ?? b.label,
    connectionType: a.connectionType ?? b.connectionType,
    params: [...byKey.values()],
    examples: [...a.examples, ...b.examples],
  };
}

/** Mine all module specs from one blueprint, keyed by module id. */
export function mineBlueprint(bp: Blueprint, source: string): Map<string, ModuleSpec> {
  const specs = new Map<string, ModuleSpec>();
  for (const m of flattenModules(bp.flow)) {
    const spec = mineModule(m, source);
    if (!spec) continue;
    const existing = specs.get(spec.module);
    specs.set(spec.module, existing ? mergeSpecs(existing, spec) : spec);
  }
  return specs;
}

/** App names referenced by a blueprint (for template indexing). */
export function appsInBlueprint(bp: Blueprint): string[] {
  const apps = new Set<string>();
  for (const m of flattenModules(bp.flow)) {
    if (typeof m.module === "string") apps.add(m.module.split(":")[0]);
  }
  return [...apps];
}
