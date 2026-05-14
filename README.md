# Ask Thane Monorepo

Ask Thane is an AI-native conversational task tracker for teams.  
Instead of asking people to maintain Jira/Linear-style tickets manually, Thane listens to normal Slack conversation, infers task state, tracks progress in its own backend, and proactively follows up with people.

## What The Bot Does
- Listens to Slack messages (channels + DMs, based on scopes and app membership).
- Infers task events from natural language:
  - create task
  - mark done / cancel / block / reopen
  - edit / merge
- Maintains auditable task history (`task_actions`) and visibility controls (ACL + waiver requests).
- Maintains cross-message context with agent notes (org/workspace/channel/person/user/task scopes).
- Sends proactive reminders and follow-ups on user cadence.
- Supports direct conversational replies in DMs and channel mentions.
- Supports multi-workspace OAuth install and per-workspace bot tokens.

## Architecture
### Runtime surfaces
- `apps/bot-worker`: Core product runtime.
  - Slack Events API webhook ingress
  - scheduled Slack polling
  - LLM tool-calling agent runtime
  - reminders/follow-ups
  - admin/ops/eval endpoints
- `apps/api-worker`: API surface for task/analytics read endpoints (early-stage).
- `apps/payments-worker`: Stripe webhook and billing hooks (early-stage).
- `apps/landing`: marketing site worker for `askthane.com`.

### Shared packages
- `@ask-thane/domain`: entity and enum types.
- `@ask-thane/integrations`: Slack payload normalization.
- `@ask-thane/ai`: LLM provider abstraction.
- `@ask-thane/data`: D1 repository implementation.
- `@ask-thane/workflows`: message-to-task workflow composition.

### Data layer
- Cloudflare D1 (SQLite) for:
  - organizations/workspaces/users
  - identities + people linking
  - tasks + task actions
  - conversation sources + memberships
  - note memory
  - notification cadences + digest deliveries
  - follow-up jobs
  - feedback and LLM/usage telemetry

## Current Development Status (May 2026)
### Working now
- Slack app OAuth install flow (`/slack/install`, `/slack/oauth/callback`).
- Event ingestion + dedupe for Slack webhook traffic.
- Task inference agent with read/write tools over internal DB.
- Reactions for task events.
- Reminder digests and follow-up jobs.
- Multi-workspace token storage (`slack_workspace_installs`).
- Admin endpoints for poll/reminders/followups/ops/evals/usage.

### Prototype-grade / still evolving
- Mention-reply reliability and Slack event operational hardening.
- Evaluation coverage and regression suites.
- Billing metering productionization.
- API-worker and payments-worker feature depth.
- Staging/production promotion workflow and strict release gating.

### Not production-ready for external customers yet
- Full staging environment parity and release promotion controls.
- Broader test coverage and automated smoke tests post-deploy.
- Mature observability dashboards/alerts.
- Security review, tenant hardening, and incident runbooks.

## Repo Layout
```text
.
├── apps
│   ├── api-worker
│   ├── bot-worker
│   ├── landing
│   └── payments-worker
├── docs
├── infra
│   └── d1
└── packages
    ├── ai
    ├── data
    ├── domain
    ├── integrations
    └── workflows
```

## Local Setup
1. Install dependencies:
```bash
pnpm install
```
2. Copy env template:
```bash
cp .env.example .env
```
3. Create/apply D1 schema:
```bash
cd apps/bot-worker
pnpm wrangler d1 create ask-thane
pnpm wrangler d1 execute ask-thane --file ../../infra/d1/schema.sql
```
4. Update `database_id` in relevant `wrangler.toml` files.
5. Run workers locally:
```bash
pnpm dev:bot
pnpm dev:api
pnpm dev:payments
pnpm dev:landing
```

## Build Commands
- `pnpm build`
- `pnpm build:all`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Key Docs
- Setup/env/Cloudflare checklist:
  [docs/integration-env-cloudflare-checklist.md](/Users/garrettpetersen/ask-thane/docs/integration-env-cloudflare-checklist.md)
- Identity/notes/actions/permissions model:
  [docs/identity-memory-actions-permissions.md](/Users/garrettpetersen/ask-thane/docs/identity-memory-actions-permissions.md)
- Agent runtime/tooling model:
  [docs/agent-runtime.md](/Users/garrettpetersen/ask-thane/docs/agent-runtime.md)
