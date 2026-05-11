# Org-Scoped Multitenancy Plan

## Why this is priority 1
Ask Thane must enforce strict organization data boundaries before production rollout. Workspace-scoped storage is not enough because one organization may connect multiple platforms/workspaces (Slack, Teams, Discord, etc.), and no user from Org A can ever read Org B data.

## Current state (as of 2026-05-09)
- Existing schema is in `infra/d1/schema.sql`.
- Core tables are workspace-scoped (`workspaces`, `users`, `tasks`, `task_events`, `reminders`).
- There is no first-class `organizations` table, no membership model, and no cross-platform identity linking table.

## Target tenancy model
1. `organization` is the primary security and billing boundary.
2. One organization has many workspaces/integrations.
3. One human can have many external identities across providers/workspaces.
4. Every task/event/reminder/user row includes `organization_id`.
5. Every read/write path enforces `organization_id` before business filtering.

## Datastore plan (2026-05-09)
1. Keep Cloudflare D1 as the default datastore for MVP and early production.
2. Enforce strict org isolation in schema, repositories, and handler authz now.
3. Keep `packages/data` as a hard storage boundary so a Postgres adapter can be added later.
4. Switch selected tenants or the full system to Postgres only when metrics justify it.

### Postgres migration triggers
1. Sustained write contention or webhook backlog driven by database limits.
2. Query latency for org dashboards/capacity views exceeds SLO despite indexing and query tuning.
3. Product requirements need features that are impractical on D1 (for example complex relational analytics at scale).

## Delivery plan

### Phase 1: Data model and repository hardening
1. Add `organizations` table.
2. Add `organization_id` to `workspaces`, `users`, `tasks`, `task_events`, `reminders`.
3. Add `memberships` table (`owner`, `admin`, `member`, `viewer`).
4. Add `external_identities` table to map people across providers/workspaces.
5. Update repository interfaces so methods require `organizationId`.
6. Add composite indexes that start with `organization_id` for all hot-path queries.

### Phase 2: Authz and API enforcement
1. Define request auth context (`organizationId`, `actorUserId`, roles).
2. Reject requests without valid org context.
3. Add policy checks for role-sensitive queries and cross-workspace visibility.
4. Ensure all bot/API handlers pass org scope into repo methods.
5. Adopt ReBAC authorization checks backed by source-conversation membership data.

### Phase 3: Ingestion and identity linking
1. Resolve incoming platform user/workspace to org-scoped identities.
2. Support multiple integrations under one org account.
3. Add idempotency keys per organization for webhook retry safety.

### Phase 4: Tests and security validation
1. Repository tests: Org A cannot read/write Org B rows.
2. Handler tests: missing org context returns authz failure.
3. Integration tests: multi-workspace same-org queries work as expected.
4. Regression tests for cross-org leakage on all status/capacity endpoints.
5. Declassification tests: private evidence can drive shared state changes without leaking private content.

## Immediate next implementation tasks
1. Land D1 migration `0001_org-multitenancy.sql`.
2. Update canonical `infra/d1/schema.sql` to org-first shape for new environments.
3. Update `@ask-thane/data` repository signatures to require `organizationId`.
4. Update `api-worker` open-task endpoint to require and enforce org scope.
5. Add a minimal auth-context adapter (temporary static mapping is acceptable in prototype stage).

## Open design decisions
1. Billing ownership relation:
   - Option A: one billing account per organization (recommended).
   - Option B: decoupled billing account object with many organizations.
2. Human identity model:
   - Option A: separate `people` table plus `external_identities`.
   - Option B: keep `users` and treat each provider account as a user row.
3. Role granularity:
   - Decide whether `viewer` can access private-thread reminder history.
