# AGENTS.md

## Cursor Cloud specific instructions

This repo is the **Big 5 Matrix / HDV Foundation** — an offline-first TypeScript agent-orchestration engine (HOPE/DREAM/VISION/KNOLL/APEX). It runs fully in-memory with a deterministic stub LLM provider; **no external services are required** to build, test, or run it.

The update script already runs `npm ci` + `npm run db:generate` on startup, so dependencies and the Prisma client are ready. All commands run from the repo root.

### Standard commands (see `package.json` scripts)
- Lint / static check: `npm run typecheck` (there is no ESLint/Prettier; `tsc --noEmit` is the gate).
- Tests: `npm test` (Node's built-in runner via `tsx`). ~404 pass; ~5 skip by design (they need Postgres/Kafka — see below).
- Run the main service: `npm run gateway` (HOPE HTTP gateway on `PORT`, default `8787`). Long-running — start it in a background/tmux session, not a blocking foreground call.
- MCP tool provider: `npm run mcp` (stdio). Python twin CI: `npm run ci:python` (stdlib only, no pip install).

### Non-obvious gotchas
- `POST /v1/intent` requires a JSON body `{ "utterance": "..." }` (the key is `utterance`, NOT `intent`). To make an intent actually dispatch (not just ask for clarification), include an action verb: SIMULATE-type words (`simulate`, `forecast`, `scenario`, `imagine`) route to DREAM; EXECUTE-type words (`run`, `build`, `deploy`, `process`) route to VISION. Vague text returns `clarificationNeeded: true` without dispatching.
- `GET /v1/health` is always public (auth/rate-limit exempt). Other routes are rate-limited to 60/min per IP; auth is disabled in dev unless `HDV_API_KEY` is set.
- The static **HOPE web app** in `hope/app/` has no build step. Serve it and point it at the gateway, e.g. `python3 -m http.server 8080 --directory hope/app` then open `http://localhost:8080/?api=http://localhost:8787`. It talks to the gateway only over `/v1` HTTP.
- Optional durable paths (Postgres via Prisma `DATABASE_URL`, Redis `REDIS_URL`, Kafka `HDV_QUEUE=kafka`) are off by default; `docker compose up -d` starts them. The ~5 skipped tests only run when those env vars are set.
- Known issue (unrelated to setup): `deploy/Dockerfile` contains unresolved git merge-conflict markers, so `docker build -f deploy/Dockerfile` will fail. The dev `docker-compose.yml` (Postgres/Redis/Kafka images) is unaffected. Local dev does not need Docker.
