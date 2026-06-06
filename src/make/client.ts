/**
 * Thin REST client for the Make API (https://developers.make.com/api-documentation).
 *
 * Auth is a personal API token sent as `Authorization: Token <key>`.
 * The base URL is region-specific, e.g. https://eu2.make.com/api/v2.
 */

import { assertApiConfigured, type MakeConfig } from "../config.js";

export class MakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "MakeApiError";
  }
}

export interface CreateScenarioInput {
  teamId: number;
  /** Blueprint as a JSON string (Make requires it serialized, not an object). */
  blueprint: string;
  /** Scheduling as a JSON string, e.g. '{"type":"on-demand"}'. */
  scheduling: string;
}

export class MakeClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  readonly teamId?: number;

  constructor(config: MakeConfig) {
    assertApiConfigured(config);
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl;
    this.teamId = config.teamId;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(this.apiUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Token ${this.apiKey}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* keep raw text */
    }

    if (!res.ok) {
      throw new MakeApiError(
        `Make API ${method} ${path} failed with ${res.status} ${res.statusText}`,
        res.status,
        parsed,
      );
    }
    return parsed as T;
  }

  /** Lightweight connectivity/credential check. Lists teams we can reach. */
  async healthCheck(): Promise<{ ok: boolean; apiUrl: string; teamId?: number; detail: unknown }> {
    // GET /users/me is cheap and confirms the token is valid.
    const detail = await this.request("GET", "/users/me");
    return { ok: true, apiUrl: this.apiUrl, teamId: this.teamId, detail };
  }

  async createScenario(input: CreateScenarioInput): Promise<unknown> {
    return this.request("POST", "/scenarios", { body: input });
  }

  async getScenarioBlueprint(scenarioId: number): Promise<unknown> {
    return this.request("GET", `/scenarios/${scenarioId}/blueprint`);
  }

  /** Scenario detail incl. Make's own `isinvalid` validity flag. */
  async getScenario(scenarioId: number): Promise<{ scenario?: MakeScenario }> {
    return this.request("GET", `/scenarios/${scenarioId}`);
  }

  async updateScenarioBlueprint(scenarioId: number, blueprint: string, scheduling?: string): Promise<unknown> {
    const body: Record<string, string> = { blueprint };
    if (scheduling) body.scheduling = scheduling;
    return this.request("PATCH", `/scenarios/${scenarioId}/blueprint`, { body });
  }

  async runScenario(scenarioId: number): Promise<unknown> {
    return this.request("POST", `/scenarios/${scenarioId}/run`);
  }

  async listScenarios(teamId?: number): Promise<unknown> {
    return this.request("GET", "/scenarios", { query: { teamId: teamId ?? this.teamId } });
  }

  async listConnections(teamId?: number): Promise<{ connections: MakeConnection[] }> {
    return this.request("GET", "/connections", { query: { teamId: teamId ?? this.teamId } });
  }

  async listHooks(teamId?: number): Promise<{ hooks: MakeHook[] }> {
    return this.request("GET", "/hooks", { query: { teamId: teamId ?? this.teamId } });
  }

  /** Create a webhook (default a generic custom/gateway webhook). Returns the new hook (with id + url). */
  async createHook(input: { name: string; teamId?: number; typeName?: string }): Promise<unknown> {
    return this.request("POST", "/hooks", {
      body: {
        name: input.name,
        teamId: input.teamId ?? this.teamId,
        typeName: input.typeName ?? "gateway-webhook",
      },
    });
  }
}

export interface MakeScenario {
  id: number;
  name?: string;
  /** Make's own validity flag — true means the deployed scenario is invalid. */
  isinvalid?: boolean;
  isActive?: boolean;
  usedPackages?: string[];
  scheduling?: unknown;
}

export interface MakeConnection {
  id: number;
  name: string;
  /** Connection type, e.g. "google-restricted", "slack" — matches a module's required account type. */
  accountName: string;
  accountLabel?: string;
  accountType?: string;
  scoped?: boolean;
}

export interface MakeHook {
  id: number;
  name: string;
  typeName?: string;
  url?: string;
  enabled?: boolean;
  gone?: boolean;
  scenarioName?: string | null;
}
