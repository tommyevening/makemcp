# Contributing to MakeMCP

Thanks for helping! The most valuable contribution is usually **more module coverage**, but code, docs and bug reports are all welcome.

## Add blueprints (highest impact 🎯)

MakeMCP learns native app schemas from real exported blueprints.

1. In Make, export a scenario's blueprint (**scenario → ⋯ → Export Blueprint**), or use the `make_get_scenario` tool.
2. **Sanitize it** — no tokens or private data in `mapper` values (connection ids are fine).
3. Save the JSON into `data/corpus/` with a descriptive name.
4. Run `npm run build:db` and verify your modules appear via `search_modules` / `get_module`.
5. Open a PR.

## Dev setup

```bash
npm install
npm run build:db     # build the knowledge DB from data/corpus/
npm run typecheck
npm run dev          # run the server over stdio
```

## Guidelines

- **Never commit secrets.** `.env` is git-ignored — keep it that way.
- Keep `npm run typecheck` green; match the existing style (TypeScript, ESM, small modules).
- Discovery/validation tools must keep working **offline** (no network/credentials); network is only for `make_*` tools and ingest scripts.
- Prefer Node built-ins (we use `node:sqlite`) over native dependencies.
- One logical change per PR; describe what and why.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, your Node version and OS, and relevant tool input/output (secrets removed).
