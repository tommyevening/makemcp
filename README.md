# MakeMCP

> An MCP server that lets **Claude build working [Make](https://www.make.com) (make.com) scenarios** for you — discover modules, assemble a blueprint, validate it, and deploy it live to your Make account.

- 🧠 Knows **~3,260 Make apps** + real module schemas
- 🛠️ Assembles & **validates** blueprints (required fields, IML references, auto-fixes)
- 🚀 **Deploys** scenarios straight to your Make account
- 📴 Discovery & validation work **offline**; only deploy needs credentials
- 🧩 17 MCP tools, TypeScript, no native build deps (uses Node's built-in `node:sqlite`)

> **Status:** community project, MVP-quality. Solid for common scenarios on core apps (Webhooks, HTTP, Google Sheets, Slack, OpenAI, Gmail/email, Drive, routers/iterators). Module-schema depth for the long tail of native apps grows via the blueprint corpus — see [Coverage](#coverage). PRs welcome!

## How it works

A Make scenario is a **blueprint**: `{ name, flow: [ ...modules ], metadata }`. Each module is `{ id, module: "app:action", version, parameters, mapper, metadata }`, where `mapper` fields accept **IML** like `{{1.email}}` referencing earlier modules. Branching uses a `builtin:BasicRouter` with `routes[]`.

Make doesn't expose native app schemas over a public API, so MakeMCP builds knowledge in three layers: an **app catalog** (~3,260 apps), **module schemas** (mined from real blueprints, scraped for open-source apps, and lazily fetched on demand), and keyword-rich **usage docs**. The flow Claude follows: **discover → build → validate → deploy**.

## Requirements

- **Node.js ≥ 22.5** (for built-in `node:sqlite`; tested on 24)
- A **Make account with API access** (paid plan) for deploy tools. Discovery/validation need no credentials.

## Install

```bash
git clone https://github.com/tommyevening/makemcp.git
cd makemcp
npm install
npm run build        # compile to dist/  (data/make.db is committed, works out of the box)
```

## Configure

1. **Create a Make API token** (Make → Profile → API/SDK → Add token). Recommended scopes:
   ```
   scenarios:read scenarios:write scenarios:run user:read connections:read hooks:read hooks:write teams:read sdk-apps:read
   ```
2. **Set env vars** — copy `.env.example` to `.env`:
   ```ini
   MAKE_API_KEY=your-make-api-token
   MAKE_TEAM_ID=123456        # your team id (number)
   MAKE_ZONE=eu2              # your region: eu1, eu2, us1, us2 ...
   ```
   `.env` is loaded automatically and is **git-ignored** — never commit it.

## Add to Claude

Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json` / `~/Library/Application Support/Claude/claude_desktop_config.json`) or Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "makemcp": {
      "command": "node",
      "args": ["/absolute/path/to/makemcp/dist/index.js"]
    }
  }
}
```

Credentials come from `.env`, so no `env` block is needed. Restart Claude fully afterwards. On Windows, if `node` isn't found, use the full path (e.g. `C:/Program Files/nodejs/node.exe`).

## Usage

Ask Claude things like:

- *“Check my Make connection.”* → `make_health_check`
- *“What Make apps are there for CRM?”* → `list_apps`
- *“Build a Make scenario: on a webhook, add a row to Google Sheets with the name and email, then post to Slack.”* → discover → build → `validate_scenario` → `make_create_scenario`

## Tools

| Tool | Needs API | Purpose |
|---|---|---|
| `tools_documentation` | no | Overview + per-tool docs. Start here. |
| `search_modules` | no | Ranked search across modules. |
| `get_module` | no | Full schema + usage + examples for a module. |
| `list_apps` | no | Search the ~3,260-app catalog. |
| `search_templates` / `get_template` | no | Find & fetch reusable blueprints. |
| `validate_scenario` | no | Validate + autofix + enrich a blueprint. |
| `make_health_check` | yes | Verify API connectivity / credentials. |
| `make_create_scenario` | yes | Deploy a new scenario (validates first; reports Make's validity verdict). |
| `make_get_scenario` | yes | Fetch an existing scenario's blueprint. |
| `make_update_scenario` | yes | Replace a scenario's blueprint. |
| `make_verify_scenario` | yes | Closed-loop check: Make's `isinvalid` flag + local re-validation, for autofix. |
| `make_run_scenario` | yes | Trigger a manual run (needs `scenarios:run` scope). |
| `make_list_scenarios` | yes | List scenarios in a team. |
| `make_list_connections` | yes | List connections; pick an id for a module's `__IMTCONN__`. |
| `make_list_hooks` | yes | List webhooks; pick a free hook id for `gateway:CustomWebHook`. |
| `make_create_hook` | yes | Create a webhook and get its id + URL. |

## Coverage

- **Apps known:** ~3,260 (full catalog) — great for routing.
- **Apps with module schemas (buildable today):** ~25, concentrated on the core + open-source apps, with real schemas, example values and usage docs.
- **Long-tail native apps** (Notion, Airtable, HubSpot, …): known but lack schemas to build with yet — fixed by adding blueprints (below). This is the best place to contribute.

## Growing the knowledge base

```bash
npm run build:db                 # rebuild data/make.db from data/corpus/
npm run scrape [N] [--deep]      # scrape open-source SDK app schemas
npm run catalog <sitemap.xml>    # ingest the app catalog
npm run applyUsage <file.json>   # apply usage docs to modules
```

To deepen coverage: export a scenario's blueprint from Make (or use `make_get_scenario`), drop the JSON into `data/corpus/`, and run `npm run build:db`.

## Project structure

```
src/
  index.ts            entrypoint (stdio)
  server.ts           registers all tools
  config.ts           env config (+ auto .env loading)
  context.ts          shared ctx (lazy DB + API + SDK clients)
  make/client.ts      Make REST API client
  db/database.ts      node:sqlite knowledge store + schema
  knowledge/          ingest pipeline (miner, build, scrape, catalog, applyUsage)
  blueprint/          validator.ts (validate + autofix + enrich)
  tools/              documentation, discovery, validate, manage
data/
  corpus/             real blueprints (input to build:db)
  usage/              usage docs
  make.db             prebuilt knowledge DB (shipped)
```

## Contributing

Forks and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The highest-impact contribution is adding blueprints to `data/corpus/`.

## Security

Never commit your `.env`/token (git-ignored by default). `scenarios:write` also permits delete (MakeMCP never deletes). Review generated blueprints before deploying to production.

## License

[MIT](LICENSE) © 2026 Tomek Wieczorek
