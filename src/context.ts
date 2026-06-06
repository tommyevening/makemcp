/**
 * Shared context passed to every tool registration.
 *
 * The MakeClient is created lazily so discovery tools work without credentials,
 * and management tools fail with a clear message only when actually invoked.
 */

import { loadConfig, type MakeConfig } from "./config.js";
import { MakeClient } from "./make/client.js";
import { MakeKnowledgeDB } from "./db/database.js";
import { SdkAppsClient } from "./knowledge/sources/sdkApps.js";
import type { ParamSpec } from "./knowledge/types.js";

export interface ServerContext {
  config: MakeConfig;
  /** Returns a configured client or throws a descriptive error if creds are missing. */
  getClient(): MakeClient;
  /** Opens the prebuilt knowledge DB read-only (lazy). Throws if not built. */
  getDb(): MakeKnowledgeDB;
  /** SDK Apps client for lazy schema loading, or undefined if no credentials. */
  getSdkClient(): SdkAppsClient | undefined;
  /** Session cache of lazily-loaded module param schemas (module id -> params). */
  paramCache: Map<string, ParamSpec[]>;
}

export function createContext(): ServerContext {
  const config = loadConfig();
  let client: MakeClient | undefined;
  let db: MakeKnowledgeDB | undefined;
  let sdk: SdkAppsClient | undefined;
  let sdkResolved = false;
  return {
    config,
    paramCache: new Map(),
    getClient() {
      if (!client) client = new MakeClient(config);
      return client;
    },
    getDb() {
      if (!db) db = MakeKnowledgeDB.openReadOnly();
      return db;
    },
    getSdkClient() {
      if (!sdkResolved) {
        sdkResolved = true;
        if (config.apiKey && config.apiUrl) {
          sdk = new SdkAppsClient({ apiUrl: config.apiUrl, apiKey: config.apiKey, openSource: true });
        }
      }
      return sdk;
    },
  };
}
