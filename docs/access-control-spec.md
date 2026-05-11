# Access Control Spec (Source-Derived Permissions)

## Purpose
Define a general authorization model where Thane inherits visibility from the source messaging platform (Slack/Teams/Discord/etc.) so data access tracks real conversation permissions.

## Core principle
A user can only access Thane data derived from conversations they can access in the source platform.

## Standard model choice
Thane uses a relationship-based access control (ReBAC) model with event-level provenance and explicit declassification for cross-scope state sharing.

## Security boundaries
1. Organization boundary (hard): no cross-org access, ever.
2. Conversation boundary (hard): within an org, access is constrained by source conversation visibility.
3. Derived-resource boundary (hard): tasks/events/memories inferred from messages must retain compatible visibility.

## Terms
1. Conversation: channel, group DM, or direct message thread in a provider.
2. Source item: raw inbound message/event linked to provider conversation metadata.
3. Derived resource: task, task event, reminder, memory item, summary, or answer evidence.
4. Effective ACL: computed permissions attached to a derived resource.

## Authorization model

### 1) Ingest-time capture
For every source message/event, store:
1. `organization_id`
2. `workspace_id`
3. `provider` (`slack`, `teams`, etc.)
4. `provider_conversation_id`
5. `provider_message_id`
6. `conversation_kind` (`public_channel`, `private_channel`, `group_dm`, `dm`)
7. `is_public`
8. `visibility_version` (monotonic integer or timestamp)
9. `captured_at`

### 2) Membership graph
Maintain a cached membership graph for private scopes:
1. conversation -> allowed users/groups
2. last synced timestamp
3. source-of-truth provider cursor/version where available

### 3) Query-time enforcement
All reads must run this sequence:
1. Resolve caller identity to internal user + org.
2. Build caller's allowed conversation set (public + private memberships).
3. Restrict candidate resources by org and ACL mapping.
4. Only then run semantic/ranking/filter logic.

No endpoint/tool may do semantic search across unrestricted org data.

### 4) ReBAC policy engine contract
1. Store and evaluate access as relationships between principal -> relation -> resource.
2. Channel/provider membership is the source of truth for base visibility.
3. Authorization checks must be deny-by-default and fail-closed when relationship state is unavailable.
4. Support principal sets (user, team, role-derived userset) to avoid hardcoding org structures.

### 5) Tool auth invariants (required)
1. Every tool call must execute with server-constructed `AuthContext` and conversation context.
2. Models may request business parameters, but may not set, widen, or override auth scope.
3. Tool handlers must enforce org and ACL filters in data access before returning results.
4. Missing or invalid auth context must fail closed.
5. No tool may expose unscoped raw SQL execution to models.

## Derived resource ACL rules

### Single-source derivation
If a resource comes from one message/conversation, inherit that conversation ACL directly.

### Multi-source derivation
If a resource is derived from multiple conversations:
1. Default: effective ACL is the intersection (most restrictive safe behavior).
2. If intersection is empty and resource must exist, mark resource `restricted` and block broad retrieval.
3. Never auto-widen to union unless explicitly approved by policy and user action.

### Event-level provenance (required)
1. Every task event must link to exactly one source conversation/message (or an explicit system actor event).
2. No task mutation is accepted without provenance metadata.
3. Authorization decisions must be explainable from stored provenance.

### Declassification rule (required)
1. Private content does not become visible outside its source ACL by default.
2. Shared task state may be updated from private inputs by emitting a separate canonical task-state event.
3. Canonical state events must contain minimal detail and no raw private message content.
4. Any broader disclosure of private content requires explicit user action (promotion/share).

### Audience-specific projections
1. Task/event projections are computed per viewer from only readable events plus declassified state events.
2. Different viewers may see different detail levels for the same task.
3. Existence of restricted events must not be leaked in responses to unauthorized users.

### User-promotion rule
Private-to-broader sharing requires explicit action (for example, "share with #eng").

## Time semantics
Decide one policy and document it globally:
1. Current-membership policy (recommended for v1): access is based on current conversation membership.
2. Historical-membership policy: access is based on membership at message time.

Recommendation: start with current-membership policy and audit all access decisions.

## Data minimization and auditability
1. Keep structured facts for fast retrieval; store raw message text only when required.
2. Log auth decisions with decision reason, principal, resource id, and policy version.
3. Provide compliance export path per org.

## Failure behavior
1. If membership resolver is stale or unavailable for a private scope, fail closed.
2. Public scope can continue with cached metadata.
3. Denied queries should return neutral responses without leaking existence of restricted items.

## Membership change handling
1. Ingest provider membership events (`member_joined_channel`, `member_left_channel`, invite/remove equivalents) and upsert `conversation_memberships` immediately.
2. Run periodic reconciliation against provider APIs to repair drift from missed webhooks/events.
3. Keep `synced_at` and `version` on membership rows; treat private-scope membership as stale after a short TTL.
4. If membership for a private scope is stale at read time, fail closed for that scope until refreshed.
5. Use current-membership semantics in v1: access is determined by current channel membership, not membership at message time.
6. Adding a user to a channel grants that user access to historical Thane resources derived from that channel.

## Guardrails for complexity
1. Default to one source conversation per event.
2. If related work appears in multiple private scopes, default to separate linked tasks unless an explicit merge operation is performed.
3. Merges must create an auditable policy/declassification trail.
4. Retrieval paths must enforce auth before ranking, aggregation, and summarization.

## Schema impact (proposed additions)
Current schema has org scoping but not conversation-derived ACL tables. Add:

1. `conversation_sources`
   - `id` (pk)
   - `organization_id` (fk)
   - `workspace_id` (fk)
   - `provider`
   - `provider_conversation_id`
   - `conversation_kind`
   - `is_public`
   - `visibility_version`
   - `created_at`
   - `updated_at`
   - Unique: (`organization_id`, `provider`, `provider_conversation_id`)

2. `conversation_memberships`
   - `id` (pk)
   - `organization_id` (fk)
   - `workspace_id` (fk)
   - `conversation_source_id` (fk)
   - `user_id` (fk)
   - `role` (nullable)
   - `is_active`
   - `version`
   - `synced_at`
   - Unique: (`conversation_source_id`, `user_id`)

3. `resource_acl`
   - `id` (pk)
   - `organization_id` (fk)
   - `resource_type` (`task`, `task_event`, `memory`, `summary`)
   - `resource_id`
   - `conversation_source_id` (fk)
   - `acl_mode` (`inherit`, `intersection`, `restricted`)
   - `created_at`
   - Indexes for (`organization_id`, `resource_type`, `resource_id`) and (`organization_id`, `conversation_source_id`)

4. `ingest_events` (idempotency + provenance)
   - `id` (pk)
   - `organization_id` (fk)
   - `provider`
   - `provider_event_id`
   - `provider_message_id`
   - `conversation_source_id` (fk)
   - `received_at`
   - `processed_at`
   - Unique: (`organization_id`, `provider`, `provider_event_id`)

## Existing-table updates (proposed)
1. `tasks`: add `primary_conversation_source_id` (fk).
2. `task_events`: add `conversation_source_id` (fk).
3. `reminders`: add `source_task_event_id` (fk, optional) for traceability.

## API/tool contract requirements
1. Every handler receives `AuthContext { organizationId, userId, roles }`.
2. Every repository method takes `organizationId` and a resolved access filter.
3. Every retrieval endpoint/tool enforces ACL before full-text/semantic ranking.
4. Auth scoping is hardcoded server behavior and is not model-configurable.

## Rollout plan
1. Add new ACL tables and write path for new events.
2. Backfill `conversation_sources` from existing `tasks.channel_id` where possible.
3. Attach `resource_acl` entries for existing tasks/events.
4. Gate all read paths behind ACL filter.
5. Add denial and cross-scope leakage tests before enabling advanced query intents.

## Non-goals (v1)
1. Cross-org sharing.
2. Policy exceptions that widen private visibility automatically.
3. Provider-agnostic identity merging beyond documented `external_identities` mapping.
