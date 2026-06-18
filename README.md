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
- `apps/payments-worker`: Stripe webhook and billing hooks.
  - includes hosted pricing/checkout page at `/subscribe` and checkout session API at `/api/checkout/session`
- `apps/landing`: marketing site worker for `askthane.com`.
  - includes public legal pages: Privacy, Terms, Acceptable Use, Subprocessors
- `apps/thane-cli`: local-first MVP for Thane Chat, a Slack-like terminal chat surface with matching scriptable commands for humans and agents.

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

## Current Product Status (May 2026)
### Live now
- Public Slack app distribution is enabled.
- Users can install Thane into a workspace through the website install flow.
- Paid plans can be selected on `askthane.com` and completed through Stripe checkout.
- New installs default to free tier, and paid checkout upgrades plan tier at the org/workspace level.
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
│   ├── payments-worker
│   └── thane-cli
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

## Thane CLI MVP
Thane CLI is a separate local-first chat MVP. It provides a Slack-like terminal command surface now, with stable JSON output for agents and a storage boundary that can later move to the Cloudflare backend.

Build it:
```bash
pnpm thane:build
```

Run interactive chat:
```bash
pnpm thane chat engineering
```

Navigate inside chat:
```text
/commands          show all slash commands
/menu              open an arrow-key command menu
/inbox              show unread conversation summaries in the active workspace
/inbox all          show unread summaries across all workspaces
/workspaces         list workspaces and mark the active one
/workspace acme     switch workspace and focus #general
/channels           list channels in the active workspace
/join engineering   switch to a channel
/leave              leave the focused channel
/members            list focused channel members/subscribers
/dm alex            switch to a DM
```

While chat is open, Thane keeps the current channel/DM focused. New messages in the current conversation are shown inline; unread activity elsewhere is surfaced as compact conversation summaries instead of dumping every message into the active view. Slash commands support Tab completion from the command registry.

Create and switch workspaces:
```bash
pnpm thane workspaces
pnpm thane workspace create acme --name "Acme Inc"
pnpm thane workspace use acme
pnpm thane workspace current --json
```

Create and use accounts:
```bash
pnpm thane init
pnpm thane whoami --json
pnpm thane logout
```

The local MVP prints verification codes instead of sending email. The command contract is ready for a backend email-code flow.

Manage workspace members:
```bash
pnpm thane members --json
pnpm thane invite alex@example.com --role admin --handle alex
pnpm thane member role alex member
```

Workspace owners and admins can add people to a workspace. Members can create channels.

Import a one-time Slack export ZIP:
```bash
pnpm thane workspace create-from-slack ./slack-export.zip --slug acme --apply
pnpm thane import slack-export ./slack-export.zip --preview
pnpm thane import slack-export ./slack-export.zip --apply
pnpm thane import slack-export ./slack-export.zip --preview --json
```

The most natural migration path is `workspace create-from-slack`: it creates or reuses a Thane workspace, switches to it, then imports the ZIP. The lower-level `import slack-export` command imports into the active workspace. The importer reads Slack's official export archive shape: `users.json`, `channels.json`, optional `groups.json`/`dms.json`/`mpims.json`, and per-conversation daily JSON message files. It preserves authors, timestamps, basic reactions, file links, mentions, and Slack thread roots. Imports are idempotent, so rerunning the same ZIP skips already-imported messages. Applying an export requires the current user to be a workspace owner/admin, and free workspaces must stay within the 10-member/3-private-channel limits.

Create public and private channels:
```bash
pnpm thane channel create design --topic "Product design"
pnpm thane channel create leadership --private
pnpm thane channel invite leadership alex
pnpm thane channel join design
pnpm thane channel leave design
pnpm thane channel members design --json
```

Public channel membership means subscription: any workspace member can discover/read a public channel, but only joined public channels feed normal inbox/unread activity. Direct `@you` mentions in readable public channels still surface. Posting in a public channel auto-joins it.

Private channel membership means access: only members can discover, read, search, post, or receive notifications from private channels. Existing private-channel members can invite other workspace members.

Check or upgrade billing:
```bash
pnpm thane billing status
THANE_PAYMENTS_BASE_URL=https://pay.askthane.com \
  THANE_BILLING_LINK_SIGNING_SECRET=<secret> \
  pnpm thane billing checkout
```

Free Thane CLI workspaces are intentionally useful: up to 100 members, 10 private channels, public channels, DMs, threads, mentions, inbox/search, and JSON-friendly commands. Thane CLI Team is `$8/member/mo` and removes the member/private-channel limits for larger hosted teams.

Use scriptable commands:
```bash
pnpm thane commands
pnpm thane commands --json
pnpm thane inbox --json
pnpm thane inbox --all-workspaces --json
pnpm thane channels --json
pnpm thane send engineering "Shipping the patch now"
pnpm thane recent engineering --json
pnpm thane mentions --since yesterday --json
pnpm thane reply <message-id> "I can review this afternoon"
```

Manage users, mentions, and DMs:
```bash
pnpm thane users --json
pnpm thane user add alex --name "Alex"
pnpm thane send engineering "@alex can you review this?"
pnpm thane dm alex
pnpm thane dm-send alex "This is private"
pnpm thane dm-recent alex --json
```

Enable the optional Ask Thane integration:
```bash
pnpm thane init
pnpm thane ask-thane enable
pnpm thane notify location thane_cli
pnpm thane send engineering "@thane can you track this review?"
pnpm thane thread <message-id> --json
```

Ask Thane is disabled by default. When enabled, `@thane` is added as a workspace bot identity and `@thane` mentions are handled as Ask Thane events. In the local MVP, the bot returns a bridge placeholder. In the hosted backend, these events should call the same Ask Thane agent runtime used for Slack.

Cross-platform identity is email-based: a Thane CLI account with `garrett@example.com` should resolve to the same `person` as a Slack identity with that email through the existing `identity_accounts` table. The CLI provider key is `thane_cli`, with `external_user_id` set to the verified account email.

Ask Thane ping location is account/person-level:
```bash
pnpm thane notify location
pnpm thane notify location origin
pnpm thane notify location thane_cli
pnpm thane notify location slack
pnpm thane notify location both
```

You can also ask `@thane` conversationally:
```bash
pnpm thane send engineering "@thane ping me here"
pnpm thane send engineering "@thane send reminders in Slack"
pnpm thane send engineering "@thane notify me in both places"
```

For clean JSON in scripts or agents, build once and call the compiled CLI directly:
```bash
pnpm thane:build
node apps/thane-cli/dist/index.js recent engineering --json
```

By default, MVP data is stored at `.thane/store.json` in the current working directory. Override it for tests or alternate workspaces:
```bash
THANE_STORE_PATH=/tmp/thane-store.json pnpm thane recent --json
```

The CLI always scopes channels, messages, threads, unread state, mentions, and search to the active workspace. That keeps `#engineering` in one workspace separate from `#engineering` in another.

## Testing
- The repo includes a full automated test suite across workers and shared packages, including agent tool-call behavior, workflow logic, Slack payload normalization, and route-level worker behavior.
- Tests are deterministic and run with mocks/stubs where appropriate (for example no live OpenAI calls and no production D1 writes during unit tests).
- Billing scaffolding paths are covered in tests, including tool-level free-tier active-user gating and OpenAI usage cost estimation logic.
- Push/PR CI (`.github/workflows/ci.yml`) also runs `pnpm test`.

## Pricing Defaults
- Thane CLI Free: CLI-first team chat for up to 100 workspace members, 10 private channels, public channels, DMs, threads, mentions, inbox/search, JSON-friendly commands, and optional local Ask Thane integration.
- Thane CLI Team: `$8/member/mo`, unlocks larger workspaces, unlimited private channels, long-lived hosted history, and org-scale admin controls. Configure with `STRIPE_PRICE_CLI_TEAM_MONTHLY`.
- Ask Thane Free: 10 active participants max (hard cap), no AI credit.
  - Free tier also enforces a monthly AI spend safety cap (`FREE_TIER_MONTHLY_AI_CAP_USD`, default `$10`).
- Ask Thane Team: `$99/mo`, includes 25 active participants, `+$3` per additional participant, `$20` included monthly AI cost credit, `1.35x` AI overage multiplier.
- Ask Thane Growth: `$299/mo`, includes 100 participants, `+$2` per additional participant, `$120` AI credit, `1.30x` AI overage multiplier.
- Ask Thane Scale: `$699/mo`, includes 300 participants, `+$1.25` per additional participant, `$400` AI credit, `1.25x` AI overage multiplier.
- Ask Thane Scale Plus: `$1499/mo`, includes 1000 participants, `+$1` per additional participant, `$1000` AI credit, `1.20x` AI overage multiplier.
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
  - bot-generated billing links carry a short-lived signed `billing_token` (HMAC + expiry) instead of raw org/workspace query IDs,
  - checkout and billing-portal APIs require a valid `billing_token` and derive tenant scope from that verified payload,
  - checkout session metadata carries `organization_id`, `workspace_id`, and `plan_tier` for webhook reconciliation,
  - Stripe webhook `checkout.session.completed` activates initial entitlements, and `customer.subscription.updated` / `customer.subscription.deleted` keep plan state in sync,
  - upgrades apply immediately via Stripe proration (billing cycle anchor unchanged), while downgrade/cancel remains effective at period end,
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

## Internal API Security
- `/v1/tasks/open` and `/v1/tasks/open-visible` are internal-only API routes and require `Authorization: Bearer <INTERNAL_API_BEARER_TOKEN>`.
- Task API requests must also include `x-organization-id`, and server-side enforcement rejects mismatched `organization_id` scope.
- Bot-to-API calls should use `TASKS_API_BASE_URL` and the shared `INTERNAL_API_BEARER_TOKEN` secret for the same environment.

## Billing Secrets
- Set `BILLING_LINK_SIGNING_SECRET` as a secret in both `bot-worker` and `payments-worker` for each environment.
- Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `payments-worker`, and configure Stripe Billing Portal in your Stripe account.

## Post-Launch Ops Checks
- Keep production deploy gate requirements enabled: passing `pnpm test` and successful staging run for the same commit SHA.
- Verify Stripe webhook processing after billing changes (`checkout.session.completed` -> plan tier + external account mapping).
- Periodically run billing smoke validation (`pnpm test:billing:e2e` or the manual workflow) before pricing/billing rollout changes.
- Monitor free-tier AI spend cap enforcement and upgrade prompts in production.

## Key Docs
- Architecture overview and environment topology:
  [docs/architecture.md](/Users/garrettpetersen/ask-thane/docs/architecture.md)
- Setup/env/Cloudflare checklist:
  [docs/integration-env-cloudflare-checklist.md](/Users/garrettpetersen/ask-thane/docs/integration-env-cloudflare-checklist.md)
- Identity/notes/actions/permissions model:
  [docs/identity-memory-actions-permissions.md](/Users/garrettpetersen/ask-thane/docs/identity-memory-actions-permissions.md)
- Agent runtime/tooling model:
  [docs/agent-runtime.md](/Users/garrettpetersen/ask-thane/docs/agent-runtime.md)
