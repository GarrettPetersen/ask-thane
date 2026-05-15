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
- Uses AI-authored reminder digests for paid tiers (free tier stays deterministic).
- Supports direct conversational replies in DMs and channel mentions.
- Supports multi-workspace OAuth install and per-workspace bot tokens.
- Creates/links org-level accounts from Slack installs (workspace installs map to org accounts; Enterprise installs can map multiple workspaces into one org account).
- Tracks billable activity per workspace user (with active-user windows and free-tier seat caps).
- Records per-call OpenAI token usage and estimated USD cost for usage-based billing controls.
- Computes monthly-credit-aware `ai_overage_usd` usage for Stripe metered billing (instead of raw LLM cost billing).
- Reconciles estimated LLM cost with OpenAI organization costs daily and flags variance drift.
- Applies org-tier-aware runtime behavior (for example free-tier follow-up limits and tier-specific model selection).
- Enforces a free-tier monthly AI spend safety cap (`$10` by default): when exceeded, Thane posts an upgrade message and pauses task tracking until next month.

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
  - includes hosted pricing/checkout page at `/subscribe` and checkout session API at `/api/checkout/session`
- `apps/landing`: marketing site worker for `askthane.com`.
  - includes public legal pages: Privacy, Terms, Acceptable Use, Subprocessors

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
  - workspace billing settings + workspace user activity ledger

## Current Development Status (May 2026)
### Working now
- Slack app OAuth install flow (`/slack/install`, `/slack/oauth/callback`).
- Event ingestion + dedupe for Slack webhook traffic.
- Task inference agent with read/write tools over internal DB.
- Reactions for task events.
- Reminder digests and follow-up jobs.
- Multi-workspace token storage (`slack_workspace_installs`).
- Admin endpoints for poll/reminders/followups/ops/evals/usage.
- Build metadata endpoint (`/build-info`) on bot/api/payments workers.

### Prototype-grade / still evolving
- Mention-reply reliability and Slack event operational hardening.
- Evaluation coverage and regression suites.
- Billing tier/product packaging and invoice UX.
- API-worker and payments-worker feature depth.
- Staging/production promotion workflow and strict release gating.

### Not production-ready for external customers yet
- Full staging environment parity and release promotion controls.
- Broader test coverage and automated smoke tests post-deploy.
- Mature observability dashboards/alerts.
- Security review, tenant hardening, and incident runbooks.

## Environments
Ask Thane runs separate `staging` and `production` environments.

Why this exists:
- `staging` is where we validate behavior changes, Slack flows, and deployment health before release.
- `production` is the stable customer-facing environment with manual promotion controls.
- Environment separation reduces release risk and lets us test operational changes without directly impacting production usage.

What exists today:
- Separate Cloudflare Worker deployments for staging and production for `bot-worker`, `api-worker`, and `payments-worker`.
- Separate D1 databases for runtime environments:
  - `ask-thane-staging` is bound to staging bot/api workers
  - `ask-thane` is bound to production bot/api workers
- Separate GitHub deployment environments (`staging`, `production`) for secrets and approvals.
- Bot staging and production are exposed on distinct domains:
  - `bot-staging.askthane.com`
  - `bot.askthane.com`
- Build metadata (`BUILD_ENV`, `BUILD_GIT_SHA`, `BUILD_DEPLOYED_AT`) is injected per deploy and exposed via `/build-info`.

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
3. Bootstrap Stripe monthly price IDs (reuses existing prices by lookup key):
```bash
node scripts/setup-stripe-prices.mjs
```
4. Create/apply D1 schema:
```bash
cd apps/bot-worker
pnpm wrangler d1 create ask-thane
pnpm wrangler d1 execute ask-thane --file ../../infra/d1/schema.sql
```
5. Update `database_id` in relevant `wrangler.toml` files.
6. Run workers locally:
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

## Testing
- The repo includes a full automated test suite across workers and shared packages, including agent tool-call behavior, workflow logic, Slack payload normalization, and route-level worker behavior.
- Tests are deterministic and run with mocks/stubs where appropriate (for example no live OpenAI calls and no production D1 writes during unit tests).
- Billing scaffolding paths are covered in tests, including tool-level free-tier active-user gating and OpenAI usage cost estimation logic.

## Pricing Defaults
- Free: 10 active participants max (hard cap), no AI credit.
  - Free tier also enforces a monthly AI spend safety cap (`FREE_TIER_MONTHLY_AI_CAP_USD`, default `$10`).
- Team: `$99/mo`, includes 25 active participants, `+$3` per additional participant, `$20` included monthly AI cost credit, `1.35x` AI overage multiplier.
- Growth: `$299/mo`, includes 100 participants, `+$2` per additional participant, `$120` AI credit, `1.30x` AI overage multiplier.
- Scale: `$699/mo`, includes 300 participants, `+$1.25` per additional participant, `$400` AI credit, `1.25x` AI overage multiplier.
- Scale Plus: `$1499/mo`, includes 1000 participants, `+$1` per additional participant, `$1000` AI credit, `1.20x` AI overage multiplier.
- Plan tier aliases: legacy `starter -> team`, `pro -> growth`, `business/enterprise -> scale`.
- Model defaults are also tier-aware:
  - Free defaults to `FREE_TIER_LLM_MODEL` (default `gpt-4.1-mini`).
  - Paid runtime defaults to stronger models (`TEAM/GROWTH/SCALE/..._TIER_LLM_MODEL`, fallback `PAID_TIER_LLM_MODEL`).
  - Paid daily digests can use `PAID_TIER_DIGEST_LLM_MODEL` override.
- Run all tests:
  - `pnpm test`
- Run a single package test suite:
  - `pnpm --filter <package-name> test`
- Run live billing smoke test (opt-in, no charge completion; creates then expires a checkout session):
  - `BILLING_E2E_ENABLED=true pnpm test:billing:e2e`
  - GitHub Actions manual workflow: `.github/workflows/billing-e2e-smoke.yml` (uses environment secret `BILLING_E2E_STRIPE_SECRET_KEY`)

## Slack Install And Billing Linkage
- Public website onboarding entrypoint is `/install.html` on `askthane.com`, which splits free vs paid setup paths.
- Public installs should use `https://bot.askthane.com/slack/install` (not a raw hard-coded Slack OAuth URL), so state signing and configured scopes are enforced by your bot runtime.
- A new workspace install creates/links:
  - an internal `organization` and `workspace` (via Slack IDs),
  - plus a `organization_external_accounts` mapping row for Slack identity.
- New installs default to free tier.
- Paid upgrade flow:
  - checkout session carries `organization_id`, `workspace_id`, and `plan_tier` metadata,
  - Stripe webhook `checkout.session.completed` updates `organizations.plan_tier` and `workspaces.plan_tier`,
  - Stripe customer/subscription IDs are mapped into `organization_external_accounts` with provider `stripe`.

## Deploy Flow
- Staging and production deploy workflows run a non-destructive migration validator, then apply D1 migrations before bot/api deploys (`wrangler d1 migrations apply ...`), so schema rollout is coupled to release.
- Staging deploys are test-gated: the workflow runs `pnpm test`, and deploy jobs do not run if tests fail.
- `master` pushes auto-deploy changed worker apps to staging via `.github/workflows/deploy-workers-staging.yml` (path-filtered by app).
- Production deploys are manual (`workflow_dispatch`) via `.github/workflows/deploy-workers-production.yml`, including a selectable `git_ref`.
- Production deploys are also gated on:
  - passing `pnpm test` in the production workflow, and
  - a successful staging deploy workflow run for the exact commit SHA being promoted.
- Configure GitHub Environments:
  - `staging` with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
  - `production` with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Add required reviewers on the `production` environment for approval gating.

## Quiet Launch Checklist
Use the detailed checklist here:
- [docs/quiet-launch-checklist.md](/Users/garrettpetersen/ask-thane/docs/quiet-launch-checklist.md)

At a minimum before a quiet launch:
- Confirm Slack OAuth install works in staging and creates both a `workspaces` row and an `organization_external_accounts` row.
- Confirm staging bot can ingest, infer, and send reminder digests for at least one real workspace.
- Confirm production deploy gate enforces passing tests and successful staging deploy for the same commit SHA.
- Keep Slack app unlisted/public-off until these checks are stable for multiple days.

## Key Docs
- Architecture overview and environment topology:
  [docs/architecture.md](/Users/garrettpetersen/ask-thane/docs/architecture.md)
- Setup/env/Cloudflare checklist:
  [docs/integration-env-cloudflare-checklist.md](/Users/garrettpetersen/ask-thane/docs/integration-env-cloudflare-checklist.md)
- Identity/notes/actions/permissions model:
  [docs/identity-memory-actions-permissions.md](/Users/garrettpetersen/ask-thane/docs/identity-memory-actions-permissions.md)
- Agent runtime/tooling model:
  [docs/agent-runtime.md](/Users/garrettpetersen/ask-thane/docs/agent-runtime.md)
