# Working Test Build Plan

## Objective
Ship a usable internal test build where Thane can ingest Slack messages, infer/update tasks, enforce conversation-derived visibility, and run reminder loops under a real organization model.

## Tenancy baseline (implemented)
1. `organization` is the top-level account boundary.
2. `workspace` is a provider integration (Slack/Teams/Telegram/Discord), many per org.
3. Current test default is `org_0`.
4. New Slack workspaces auto-provision into `org_0` in webhook flow for bootstrap speed.
5. `org_0` is marked `plan_tier = 'free_forever'` as a billing bypass for internal development.

## Build checklist

### A) Platform and schema
1. Apply base schema + migrations to D1.
2. Ensure webhook flow resolves external Slack workspace id -> internal workspace id -> organization id.
3. Ensure `ingest_events` idempotency is org-scoped.

Status:
- A1 done (schema + migrations present in repo)
- A2 done (bot webhook uses org/workspace registry)
- A3 done (ingest dedupe keyed by org/provider/event)

### B) Access control and membership
1. Capture conversation metadata (`conversation_sources`) on ingress.
2. Process membership changes into `conversation_memberships`.
3. Reconcile membership periodically against provider API.
4. Enforce current-membership semantics (including retroactive access for newly added members).

Status:
- B1 done
- B2 done
- B3 done for Slack channels using configured bot token
- B4 done in policy and resolver behavior

### C) Conversational task operations
1. Task creation from channel/DM messages.
2. Task status updates from conversational replies (`done`, `blocked`, etc.).
3. Shared-state update with private evidence declassification pattern.
4. ACL-scoped task retrieval tools for user/team questions.

Status:
- C1 partial (skeleton extraction exists; LLM extraction is still stubbed)
- C2 not done
- C3 not done
- C4 partial (`/v1/tasks/open-visible` exists, tool runtime not yet wired)

### D) Security hardening
1. Slack signature verification and replay protection.
2. Tool auth invariant enforcement (server-owned auth context, fail closed).
3. Denial/no-leak response behavior for unauthorized reads.

Status:
- D1 not done
- D2 documented; runtime tool gateway not yet complete
- D3 partial in ACL design, not complete in all handlers

### E) Reliability and observability
1. Structured logs for ingest, dedupe, auth decisions, reminders.
2. Retry-safe processing + dead-letter strategy for failed events.
3. Basic metrics (ingest rate, dedupe rate, auth-deny count, reminder success).

Status:
- E1 not done
- E2 partial
- E3 not done

## Known gaps before external MVP
1. Multi-workspace Slack OAuth install flow exists, but production hardening still needed (request signature verification, encrypted token storage, uninstall handling).
2. LLM extraction is stubbed and requires production prompt + structured parsing.
3. Billing UX/enforcement is not implemented (only placeholder webhook surface).
4. End-to-end tool runtime for conversational query/command dispatch is not finished.

## Next implementation sequence
1. Implement Slack signature verification + replay protection.
2. Implement workspace install credential storage (per-workspace bot token) and use it for reconciliation.
3. Replace stub extraction with structured task intent parser + evented state transitions.
4. Add server-owned tool execution gateway with ACL-first data access.
5. Run end-to-end scenario tests for org/workspace/channel scoping.
