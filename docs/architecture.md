# Ask Thane Architecture (Initial)

## Runtime shape
- Cloudflare Workers host all request-driven and scheduled workflows.
- D1 stores normalized tasks, users, and reminder event history.
- External LLM providers (OpenAI/Anthropic) are consumed through one shared adapter package.
- Slack is the first integration point; Teams is a follow-on adapter using the same domain contracts.

## Environment topology (staging vs production)
- Each Worker has explicit Wrangler environments:
  - `bot-worker`: `ask-thane-bot-staging` and `ask-thane-bot`
  - `api-worker`: `ask-thane-api-staging` and `ask-thane-api`
  - `payments-worker`: `ask-thane-payments-staging` and `ask-thane-payments`
- Bot routes/domains are split by environment:
  - staging: `bot-staging.askthane.com`
  - production: `bot.askthane.com`
- Slack OAuth redirect URIs are environment-specific in bot worker vars:
  - staging: `https://bot-staging.askthane.com/slack/oauth/callback`
  - production: `https://bot.askthane.com/slack/oauth/callback`
- D1 data-plane split:
  - staging bot/api bind to `ask-thane-staging` (`02db76d8-728f-40a4-84f8-f17779f8e8de`)
  - production bot/api bind to `ask-thane` (`186fcae1-759c-45df-a63a-2d68e53cac2d`)
- Deploy workflows:
  - Staging: auto-deploy on `master` push with path filtering (`deploy-workers-staging.yml`)
  - Production: manual deploy with explicit `git_ref` input (`deploy-workers-production.yml`)
- GitHub environments isolate deployment credentials and controls:
  - `staging` for continuous validation
  - `production` for approval-gated releases
- Every deploy stamps build metadata (`BUILD_ENV`, `BUILD_GIT_SHA`, `BUILD_DEPLOYED_AT`) for runtime traceability through `/build-info`.

## Datastore strategy
- Primary datastore is Cloudflare D1 (SQLite-compatible) for MVP and early production.
- Data access must remain behind `packages/data` repository interfaces so storage can be swapped without changing workflow/business logic.
- Tenant isolation is enforced at the application and query layer with mandatory `organization_id` scope on all reads/writes.
- Slack installs now map to org accounts through `organization_external_accounts`:
  - Workspace install: provider `slack`, `external_account_type=workspace`, `external_account_id=<team_id>`.
  - Enterprise install: provider `slack`, `external_account_type=enterprise`, `external_account_id=<enterprise_id>`.
  - This is the join point between Slack install identity and internal org billing/security boundary.
- Postgres migration is planned as a threshold-based move, not a default:
  - Trigger when sustained write concurrency, query latency, or analytics complexity exceeds D1 targets.
  - Build a Postgres adapter in parallel to D1, validate parity, then cut over by tenant placement.

## Worker boundaries
- `apps/bot-worker`: Ingests message events, infers task updates, persists tasks, runs periodic reminder jobs.
- `apps/api-worker`: Provides internal and executive APIs (status rollups, work-in-progress summaries).
- `apps/payments-worker`: Stripe webhook handling and subscription entitlement updates.
- `apps/landing`: Static marketing site plus lightweight edge endpoints.

## Billing scaffolding
- Billing is workspace-scoped and activity-based (not full Slack org headcount).
- `workspace_user_activity` stores first/last activity, deactivation state, and message provenance for billable user counting.
- Free tier enforcement is applied in agent task-write tools to cap tracked active users.
- `llm_usage_events` captures token counts and estimated USD costs per OpenAI call for overage-safe billing.
- `usage_daily_aggregates` now supports active-user counts from the activity ledger and LLM cost rollups for meter sync.
- Default tier catalog is code-defined (`free`, `team`, `growth`, `scale`, `scale_plus`) with included participants, per-user overage, included AI credit, and AI overage multiplier.
- Tier-aware model routing is configurable via worker vars (free tier on lower-cost model, paid tiers on stronger defaults with per-tier overrides).
- Reminder digest generation is tier-aware: free tier uses deterministic templates; paid tiers run digests through LLM with task + recent DM context.
- Daily reconciliation compares estimated LLM spend to OpenAI organization costs and stores variance in `openai_cost_reconciliation_daily`.

## Shared package boundaries
- `packages/domain`: Canonical business types (tasks, events, users).
- `packages/integrations`: Platform event normalization (Slack now, Teams next).
- `packages/ai`: LLM provider abstraction and orchestration interface.
- `packages/data`: Repository interfaces and D1-backed implementations.
- `packages/workflows`: Cross-app workflows that combine AI and data writes.

## Future Cloudflare primitives
- Durable Objects: workspace-level coordination, dedupe, and queueing locks.
- Queues: delayed reminder sends, burst smoothing for event ingestion.
- KV: fast config fetches per workspace.
- R2: optional archival for raw conversation snapshots and generated reports.

## Security posture targets
- Verify source signatures on Slack and Stripe webhooks.
- Store minimal message content required for extraction and auditing.
- Encrypt secrets in Cloudflare, avoid plaintext key exposure in logs.
- Preserve immutable task event logs for compliance and trust.
- Enforce ReBAC with source-conversation provenance and explicit declassification for cross-scope task state updates.
- Treat auth context as server-owned input to every tool call; models cannot choose or override authorization scope.
