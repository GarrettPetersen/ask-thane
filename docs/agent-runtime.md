# Thane Agent Runtime (Tool-Calling)

This runtime turns Slack message handling from single-shot parsing into a multi-step tool-using agent.

## Entry point
- Slack webhook route calls:
  - `runConversationalAgentForSlackMessage(...)`
  - File: `apps/bot-worker/src/services/agent-runtime.ts`
- No legacy extractor fallback on webhook path. If agent runtime fails, webhook returns error.

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
- `search_readable_conversations`
- `get_task_timeline`
- `search_workspace_people`
- `create_task`
- `update_task`
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
