# Ask Thane Build Roadmap

## Phase 0: Foundation (current)
- Monorepo + Worker skeleton
- Core data model and initial D1 schema
- Slack ingestion endpoint and scheduled job loop stubs

## Phase 1: End-to-end Slack MVP
- Slack signature verification + retries + idempotency
- LLM task extraction prompt + structured parser
- Task state transitions from conversational updates (`done`, `blocked`, reprioritized)
- Reminder DM flow and response interpretation

## Phase 2: Productization
- Billing enforcement and trial lifecycle
- Workspace settings, reminder cadence, role-based access
- Executive status endpoints and summaries

## Phase 3: Multi-platform
- Teams adapter
- Optional email channel and calendar context
- Cross-workspace consultant/client tenancy controls
