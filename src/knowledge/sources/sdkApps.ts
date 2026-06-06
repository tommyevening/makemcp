/**
 * Make SDK Apps API client — enumerates every app, its modules and their
 * parameter schemas. Requires the `sdk-apps:read` token scope.
 *
 * Endpoints (region base, e.g. https://eu2.make.com/api/v2):
 *   GET /sdk/apps                                          -> list apps (paginated)
 *   GET /sdk/apps/{app}/{version}/modules                  -> modules of an app
 *   GET /sdk/apps/{app}/{version}/modules/{mod}/parameters -> static config schema
 *   GET /sdk/apps/{app}/{version}/modules/{mod}/expect     -> mappable data schema
 *
 * Response shapes vary slightly by deployment, so accessors are defensive.
 */

import type { ModuleSpec, ParamSpec, RawFieldSpec } from "../types.js";

export interface SdkApp {
  name: string;
  label?: string;
  version: number | string;
}

export interface SdkClientOptions {
  apiUrl: string; // e.g. https://eu2.make.com/api/v2
  apiKey: string;
  /** ms between requests to respect rate limits. */
  throttleMs?: number;
  /** include open-source/public apps available to all users. */
  openSource?: boolean;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SdkAppsClient {
  private readonly headers: Record<string, string>;
  private readonly throttleMs: number;
  constructor(private readonly opts: SdkClientOptions) {
    this.headers = { Authorization: `Token ${opts.apiKey}`, Accept: "application/json" };
    this.throttleMs = opts.throttleMs ?? 350;
  }

  private log(msg: string) {
    this.opts.log?.(msg);
  }

  private async get(path: string, query: Record<string, string | number | boolean | undefined> = {}, attempt = 0): Promise<any> {
    // Build the query string manually: Make's API only honors raw bracket keys
    // like `pg[offset]` — URLSearchParams would percent-encode the brackets and
    // the param would be ignored (causing pagination to repeat page 1).
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = this.opts.apiUrl + path + (qs ? `?${qs}` : "");
    const res = await fetch(url, { headers: this.headers });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 5) {
        const backoff = Math.min(8000, this.throttleMs * Math.pow(2, attempt));
        this.log(`  rate/again ${res.status} on ${path} — backoff ${backoff}ms`);
        await sleep(backoff);
        return this.get(path, query, attempt + 1);
      }
    }
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* keep raw */
    }
    if (!res.ok) {
      const err = new Error(`GET ${path} -> ${res.status}: ${typeof body === "object" ? JSON.stringify(body) : body}`);
      (err as any).status = res.status;
      throw err;
    }
    await sleep(this.throttleMs);
    return body;
  }

  /**
   * Iterate all apps via offset pagination. The API ignores pg[limit] (page is
   * ~10) and returns no pg.total, so we step by the actual page length and stop
   * on the first empty page. Guarded against loops via a dedupe set + hard cap.
   */
  async *listApps(): AsyncGenerator<SdkApp> {
    // NOTE: the API honors pg[offset] ONLY when pg[limit] is absent. Sending
    // pg[limit] makes it ignore the offset and repeat page 1. So we send offset
    // only, step by the actual page length, and stop on an empty page. A
    // no-progress guard prevents an infinite loop if offset is ever ignored.
    let offset = 0;
    const seen = new Set<string>();
    const HARD_CAP = 20000;
    for (;;) {
      const body = await this.get("/sdk/apps", {
        "pg[offset]": offset,
        ...(this.opts.openSource ? { opensource: true } : {}),
      });
      const apps: any[] = body?.apps ?? body?.data ?? (Array.isArray(body) ? body : []);
      if (!apps.length) return;
      let newOnes = 0;
      for (const a of apps) {
        const name = a.name ?? a.appName ?? a.id;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        newOnes++;
        yield { name, label: a.label ?? a.title, version: a.version ?? a.appVersion ?? a.latestVersion ?? 1 };
      }
      if (newOnes === 0 || seen.size >= HARD_CAP) return; // offset ignored or done
      offset += apps.length;
    }
  }

  async listModules(app: string, version: number | string): Promise<any[]> {
    const body = await this.get(`/sdk/apps/${app}/${version}/modules`);
    return body?.appModules ?? body?.modules ?? body?.data ?? (Array.isArray(body) ? body : []);
  }

  /** Fetch a module section (parameters | expect | interface) as a raw field array. */
  private async section(app: string, version: number | string, mod: string, section: string): Promise<RawFieldSpec[]> {
    try {
      const body = await this.get(`/sdk/apps/${app}/${version}/modules/${mod}/${section}`);
      const arr = body?.[section] ?? body?.appModuleSection ?? body?.data ?? body;
      return Array.isArray(arr) ? (arr as RawFieldSpec[]) : [];
    } catch (e) {
      if ((e as any).status === 404) return []; // some modules have no such section
      throw e;
    }
  }

  /** Shallow module metadata (no param sections) — one cheap call per app covers all its modules. */
  moduleMeta(app: SdkApp, mod: any): ModuleSpec {
    const moduleName: string = mod.name ?? mod.id;
    return {
      module: `${app.name}:${moduleName}`,
      app: app.name,
      action: moduleName,
      version: typeof app.version === "number" ? app.version : Number(app.version) || 1,
      label: mod.label ?? mod.title,
      description: typeof mod.description === "string" ? mod.description : undefined,
      kind: kindFromType(mod) ?? "other",
      connectionType: connectionFromAccounts(mod) ?? undefined,
      params: [],
      examples: [],
    };
  }

  /** Fetch just the parameter schema for one module (parameters + expect). For lazy loading. */
  async fetchModuleParams(appName: string, version: number | string, moduleName: string): Promise<ParamSpec[]> {
    const [paramFields, expectFields] = await Promise.all([
      this.section(appName, version, moduleName, "parameters"),
      this.section(appName, version, moduleName, "expect"),
    ]);
    return [...toParamSpecs(paramFields, "parameters"), ...toParamSpecs(expectFields, "mapper")];
  }

  /** Full module spec including parameter + expect schemas (2 extra calls). */
  async getModuleSpec(app: SdkApp, mod: any): Promise<ModuleSpec> {
    const moduleName: string = mod.name ?? mod.id;
    const [paramFields, expectFields] = await Promise.all([
      this.section(app.name, app.version, moduleName, "parameters"),
      this.section(app.name, app.version, moduleName, "expect"),
    ]);
    const params: ParamSpec[] = [
      ...toParamSpecs(paramFields, "parameters"),
      ...toParamSpecs(expectFields, "mapper"),
    ];
    return {
      ...this.moduleMeta(app, mod),
      connectionType: connectionFromAccounts(mod) ?? connectionFromParams(params),
      params,
    };
  }
}

function connectionFromAccounts(mod: any): string | undefined {
  const acc = mod.attachedAccounts ?? mod.connection;
  if (Array.isArray(acc) && acc.length) return acc.join(",");
  if (typeof acc === "string" && acc) return acc;
  return undefined;
}

function toParamSpecs(fields: RawFieldSpec[] | undefined, section: ParamSpec["section"]): ParamSpec[] {
  if (!Array.isArray(fields)) return [];
  const out: ParamSpec[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (!f || typeof f.name !== "string" || !f.name) continue;
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    const enumVals = Array.isArray(f.validate?.enum)
      ? f.validate!.enum.filter((v): v is string => typeof v === "string")
      : Array.isArray((f as any).options)
        ? ((f as any).options as any[]).map((o) => (typeof o === "string" ? o : o?.value ?? o?.label)).filter((v): v is string => typeof v === "string")
        : undefined;
    out.push({
      name: f.name,
      type: typeof f.type === "string" ? f.type : "text",
      label: typeof f.label === "string" ? f.label : undefined,
      required: Boolean(f.required),
      enum: enumVals && enumVals.length ? enumVals : undefined,
      section,
    });
  }
  return out;
}

function kindFromType(mod: any): ModuleSpec["kind"] | undefined {
  const t = mod.typeId ?? mod.type;
  const map: Record<number, ModuleSpec["kind"]> = { 1: "trigger", 4: "action", 9: "search", 10: "other" };
  if (typeof t === "number" && map[t]) return map[t];
  return undefined;
}

function connectionFromParams(params: ParamSpec[]): string | undefined {
  const c = params.find((p) => p.name === "__IMTCONN__" && p.type?.startsWith("account:"));
  return c ? c.type.slice("account:".length) : undefined;
}
