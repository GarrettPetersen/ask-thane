# Ask Thane Architecture (Initial)

## Runtime shape
- Cloudflare Workers host all request-driven and scheduled workflows.
- D1 stores normalized tasks, users, and reminder event history.
- External LLM providers (OpenAI/Anthropic) are consumed through one shared adapter package.
- Slack is the first integration point; Teams is a follow-on adapter using the same domain contracts.

## Worker boundaries
- `apps/bot-worker`: Ingests message events, infers task updates, persists tasks, runs periodic reminder jobs.
- `apps/api-worker`: Provides internal and executive APIs (status rollups, work-in-progress summaries).
- `apps/payments-worker`: Stripe webhook handling and subscription entitlement updates.
- `apps/landing`: Static marketing site plus lightweight edge endpoints.

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
