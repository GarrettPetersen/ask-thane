# Thane Agent Runtime (Tool-Calling)

This runtime turns Slack message handling from single-shot parsing into a multi-step tool-using agent.

## Entry point
- Slack webhook route calls:
  - `runConversationalAgentForSlackMessage(...)`
  - File: `apps/bot-worker/src/services/agent-runtime.ts`
- No legacy extractor fallback on webhook path. If agent runtime fails, webhook returns error.

## Environment behavior
- The same runtime codepath is used in both staging and production.
- Environment differences come from deployment config and secrets, not runtime branching logic.
- Staging and production now use separate D1 databases via per-environment worker bindings.
- Deploy pipelines inject build metadata per environment (`BUILD_ENV`, `BUILD_GIT_SHA`, `BUILD_DEPLOYED_AT`) so agent behavior can be correlated to a specific release via `/build-info`.
- Slack install and OAuth flow are environment-scoped at deployment/domain level (staging bot domain vs production bot domain), while the tool loop and permission model remain identical.
- Slack OAuth installs also resolve to an internal org account via `organization_external_accounts`, so runtime authorization/billing scope uses org identity derived from install metadata rather than a shared default org.

## Runtime loop
1. Build initial context from DB + Slack.
2. Send context and system instructions to OpenAI with function tools.
3. Execute returned tool calls in-process.
4. Feed tool results back to model.
5. Repeat for configurable turns (`AGENT_MAX_TOOL_TURNS`, default 8) with retry/timeout controls.

## Tool capabilities
Current tool set:
- `search_tasks`
- `get_notes`
- `write_note`
- `get_conversation_context`
- `search_conversation_messages`
- `search_readable_conversations`
- `get_task_timeline`
- `search_workspace_people`
- `create_task`
- `update_task`
- `add_task_details`
- `request_permission_waiver`
- `get_notification_cadence`
- `set_notification_cadence`
- `schedule_follow_up`

## Permission model
All tool reads/writes are constrained by actor scope:
- Actor resolved from Slack author -> internal `users` row.
- Readable conversations computed from `conversation_sources` + `conversation_memberships`.
- Task reads use ACL-filtered repository queries.
- Conversation note reads/writes require readable conversation scope.
- User/person note writes are limited to actor-owned scopes.

## Context retrieval
Initial context bundle includes:
- Current message
- Recent channel history
- Recent thread history when applicable
- Readable conversation list
- ACL-visible task seed search
- Notes at org/workspace/conversation/user/person scopes

## Memory behavior
The model can write durable notes via `write_note` for:
- org/workspace/conversation
- user/person
- task

This supports facts like:
- "Chris usually handles website outages."

## Task behavior
The agent can:
- Create tasks
- Mark done/cancelled/blocked/reopen
- Merge tasks
- Edit title/description/due date

All changes are recorded through `task_actions`.

Free-tier billing guardrails are also enforced during task writes:
- Task write tools (`create_task`, `update_task`, `add_task_details`) check active-user seat limits.
- If the free tier active-user cap is reached, new over-cap users are skipped/blocked for task writes.
- Successful task writes record activity in `workspace_user_activity` for billing-cycle usage.
- Free-tier runtime also applies conservative cost behavior:
  - lower max tool-turn budget per run
  - optional dedicated lower-cost model via `FREE_TIER_LLM_MODEL`
  - `schedule_follow_up` tool is paid-tier-only
- Paid tiers can be pinned to stronger models via `PAID_TIER_LLM_MODEL` and per-tier overrides (`TEAM_TIER_LLM_MODEL`, `GROWTH_TIER_LLM_MODEL`, `SCALE_TIER_LLM_MODEL`, `SCALE_PLUS_TIER_LLM_MODEL`).

## LLM usage cost telemetry
- Each OpenAI agent call records token usage in `llm_usage_events`.
- Runtime now also stores estimated per-call USD cost fields (`prompt_cost_usd`, `completion_cost_usd`, `total_cost_usd`) when pricing env vars are configured.
- This supports usage-based overage billing rather than flat-rate unlimited LLM consumption.

## Identity behavior
Runtime ensures identity linkage for actor using:
- `users`
- `people`
- `identity_accounts`

Polling path also links identities for authors, mentions, and reactors.

## Fallback and coexistence
- Scheduled Slack poller now also invokes the same tool-calling agent runtime per ingested message.
- Webhook and polling paths share one reasoning layer and one command surface.

## DM mode
- In Slack `dm` conversations, runtime switches to conversational reply mode.
- The model can answer task questions, update tasks through tools, and change reminder cadence through cadence tools.
- Bot replies are posted back into the DM thread.

## Proactive follow-up mode
- Scheduled jobs can trigger proactive DM follow-ups.
- Follow-up runs use the same tool-loop runtime in read-only mode for background context gathering.
- Jobs and outcomes are persisted in `follow_up_jobs`.

## Reminder digest behavior
- Free tier reminder digests use deterministic templated messaging.
- Paid tiers run reminder digests through the LLM with task list context and recent DM context so check-ins are customized.
- Digest LLM usage is recorded in `llm_usage_events` with `request_type = reminder_digest` for billing visibility.
- External/foreign-workspace Slack assignees are tracked in tasks but treated as non-remindable for direct DM delivery.
