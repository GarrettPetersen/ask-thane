# Ask Thane Monorepo

Ask Thane is a conversational task-tracking system that listens to team communication (starting with Slack), infers work items, tracks execution status, and proactively follows up. The goal is to replace manual ticketing workflows with passive, AI-backed task capture and accountability.

## What this repo includes right now
- Cloudflare-first monorepo skeleton for product surfaces (landing, bot, API, billing).
- Shared TypeScript packages for domain types, integrations, AI adapters, data repositories, and workflows.
- Initial D1 SQL schema for workspaces, users, tasks, task events, and reminders.
- Starter Slack webhook route + scheduled reminder hook in the bot Worker.
- Foundational docs for architecture and roadmap.

## High-level architecture
1. Users talk naturally in Slack channels or DMs.
2. `bot-worker` receives platform events and normalizes them into a shared message event shape.
3. `workflows` calls AI adapters to infer task create/update intents.
4. `data` persists task state and immutable task events in D1.
5. `bot-worker` scheduled jobs send follow-up reminders and ingest responses.
6. `api-worker` serves rollups for leadership/status views.
7. `payments-worker` tracks subscription state via Stripe webhooks.

## Repo layout
```text
.
├── apps
│   ├── api-worker
│   ├── bot-worker
│   ├── landing
│   └── payments-worker
├── docs
│   ├── architecture.md
│   └── roadmap.md
├── infra
│   └── d1
│       └── schema.sql
└── packages
    ├── ai
    ├── data
    ├── domain
    ├── integrations
    └── workflows
```

## Application surfaces
- `apps/bot-worker`: Slack ingress, task inference orchestration, scheduled reminder loop.
- `apps/api-worker`: Internal REST endpoints for task status queries and future analytics.
- `apps/payments-worker`: Stripe webhook ingestion and entitlement state hooks.
- `apps/landing`: Cloudflare Worker serving static marketing assets from `public/`.

## Shared packages
- `@ask-thane/domain`: Core entities and enums.
- `@ask-thane/integrations`: Platform-specific payload normalization.
- `@ask-thane/ai`: LLM provider abstraction boundary.
- `@ask-thane/data`: Repository interfaces + D1 implementation.
- `@ask-thane/workflows`: Task ingestion flows composing AI + data.

## Local setup
1. Install dependencies:
```bash
pnpm install
```
2. Copy environment variables:
```bash
cp .env.example .env
```
   - For internal testing, keep `DEFAULT_ORGANIZATION_ID=org_0`. The bot bootstrap flow will auto-create `org_0` with a `free_forever` plan tier and attach newly seen Slack workspaces to it.
3. Create a D1 database and apply schema (after Cloudflare auth is configured):
```bash
cd apps/bot-worker
pnpm wrangler d1 create ask-thane
pnpm wrangler d1 execute ask-thane --file ../../infra/d1/schema.sql
```
4. Replace `database_id` in each Worker `wrangler.toml` file.
5. Run apps locally as needed:
```bash
pnpm dev:bot
pnpm dev:api
pnpm dev:payments
pnpm dev:landing
```

## Cloudflare Worker setup for `askthane.com`
1. In Cloudflare, create a **Worker** project connected to this GitHub repo.
2. Set the project root directory to `apps/landing`.
3. Build command: leave empty.
4. Deploy command: `npx wrangler deploy`.
5. Ensure the Worker uses [apps/landing/wrangler.toml](/Users/garrettpetersen/ask-thane/apps/landing/wrangler.toml), which defines both `main` and `[assets]`.
6. Add custom domain `askthane.com` to the Worker route/custom-domain settings.
7. Add `www.askthane.com` and configure redirect behavior as desired.

### Monorepo Wrangler command fix
If you run Wrangler from repo root and hit workspace auto-detection errors, use:
```bash
npm run landing:dev
npm run landing:deploy
```

## Build/test commands
- `pnpm build`: landing-only build.
- `pnpm build:all`: runs all package/app build scripts via Turbo.
- `pnpm typecheck`: TypeScript checks across the monorepo.
- `pnpm lint`: placeholder lint tasks (to be replaced with ESLint config).
- `pnpm test`: placeholder test tasks (to be replaced with Vitest/Miniflare tests).

## Immediate next implementation priorities
1. Add signature verification and replay protection for Slack + Stripe webhooks.
2. Implement real AI extraction prompts and deterministic JSON output parsing.
3. Add idempotency keys and message de-duplication for webhook retries.
4. Implement reminder delivery + response parsing loop (`done`, `blocked`, `not priority`).
5. Add tenancy isolation and workspace-level configuration.
6. Add dashboard/auth layer for executive summaries and admin controls.

## Product principles for upcoming implementation
- Passive by default: users should not be forced into manual task systems.
- Traceable decisions: every inferred task change should have auditable provenance.
- Safe automation: use confidence thresholds and human override paths.
- Multi-tenant isolation: strict workspace data boundaries from day one.

## Notes
- This is intentionally a skeleton; many routes contain stubs and no external API calls yet.
- The repo is designed to evolve into production-ready Cloudflare Workers with D1, Queues, and Durable Objects.
