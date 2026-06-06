/**
 * Normalized knowledge model, derived from real Make blueprints.
 *
 * In a Make blueprint, every module carries its own schema inline:
 *   - metadata.parameters  -> schema for the `parameters` object (static config:
 *                             connection, mode selectors, etc.)
 *   - metadata.expect      -> schema for the `mapper` object (the mappable data
 *                             fields that accept IML expressions like {{1.field}})
 * We aggregate these across many blueprint instances to reconstruct each
 * module's parameter schema, plus collect example values.
 */

/** A single Make module field definition (from metadata.parameters or metadata.expect). */
export interface ParamSpec {
  name: string;
  /** Make field type: text, number, uinteger, select, boolean, date, url, collection, array, account:<app>, ... */
  type: string;
  label?: string;
  required: boolean;
  /** Allowed values for select fields (from validate.enum). */
  enum?: string[];
  /** "parameters" = static config object; "mapper" = mappable data object. */
  section: "parameters" | "mapper";
}

export interface ModuleExample {
  parameters: Record<string, unknown>;
  mapper: Record<string, unknown>;
  source: string;
}

export interface ModuleSpec {
  /** Full module id, e.g. "slack:CreateMessage". */
  module: string;
  app: string;
  action: string;
  version: number;
  label?: string;
  /** Official module description from the SDK API (baseline for usage docs). */
  description?: string;
  /** Best-guess kind from the action name. */
  kind: "trigger" | "action" | "search" | "other";
  /** Connection type required, e.g. "slack2,slack3" (from __IMTCONN__ account:...). */
  connectionType?: string;
  params: ParamSpec[];
  examples: ModuleExample[];
}

export interface AppSpec {
  name: string;
  label?: string;
}

/** A raw Make blueprint (only the fields we read). */
export interface Blueprint {
  name?: string;
  flow?: BlueprintModule[];
  metadata?: Record<string, unknown>;
}

export interface BlueprintModule {
  id: number;
  module: string;
  version?: number;
  parameters?: Record<string, unknown>;
  mapper?: Record<string, unknown>;
  metadata?: {
    parameters?: RawFieldSpec[];
    expect?: RawFieldSpec[];
    designer?: { x?: number; y?: number };
    [k: string]: unknown;
  };
  /** Router modules carry routes, each with its own flow. */
  routes?: { flow?: BlueprintModule[] }[];
  filter?: unknown;
  [k: string]: unknown;
}

export interface RawFieldSpec {
  name: string;
  type?: string;
  label?: string;
  required?: boolean;
  validate?: { enum?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}
