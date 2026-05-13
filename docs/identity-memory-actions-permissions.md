# Identity, Memory, Task Actions, and Permissions Model

This document defines the core backend primitives for Ask Thane's cross-platform agent behavior.

## 1) Cross-platform identity model

Goal: link one human across multiple messaging providers and workspaces.

Tables:
- `people`: canonical human entity scoped to one Ask Thane organization.
- `identity_accounts`: provider-specific account links to `people`.
- existing `users`: current workspace user projection used for access control and membership snapshots.

Rules:
- Identity uniqueness key: `(organization_id, provider, external_user_id, external_workspace_id)`.
- Multiple `identity_accounts` can map to one `person_id`.
- Link confidence (`0..1`) and `is_verified` allow probabilistic + explicit verification states.

Repository APIs:
- `resolveOrCreatePersonForIdentity(...)`
- `upsertIdentityAccount(...)`
- `listIdentityAccountsForPerson(...)`

## 2) Agent note-taking memory space

Goal: let the agent store durable, scoped memory beyond task rows.

Table:
- `agent_notes`

Scope model:
- `scope_type`: `organization | workspace | conversation | person | user | task`
- `scope_id`: id value for that scope

Visibility model:
- `private`: agent/system-only
- `organization`: readable at org level
- `conversation_acl`: readable only where ACL + source conversation allow

Repository APIs:
- `addAgentNote(...)`
- `listAgentNotes(...)`

Examples:
- Person note: "Bob prefers async check-ins in mornings."
- Conversation note: "Client channel avoids discussing pricing in-thread."
- Task note: "Ask for screenshots before marking complete next time."

## 3) Task action model

Goal: store immutable task-change history and support richer operations.

Table:
- `task_actions`

Supported action types:
- `create`
- `mark_done`
- `mark_cancelled`
- `mark_blocked`
- `reopen`
- `merge_into`
- `edit`

Behavior:
- `performTaskAction(...)` updates current `tasks` state where applicable.
- Every action writes an immutable row to `task_actions`.
- `merge_into` cancels the source task and stamps merge metadata.

## 4) Permissioning and waivers

Goal: support private confirmations plus explicit consent to widen visibility.

Table:
- `permission_waivers`

Lifecycle:
- `pending -> granted | denied -> revoked` (and optionally `expired`)

Repository APIs:
- `requestPermissionWaiver(...)`
- `decidePermissionWaiver(...)`
- `listPendingPermissionWaivers(...)`

Example flow (private completion -> team-visible update):
1. Bob DMs Thane: "I finished that task."
2. Thane updates task state privately and opens a waiver request to widen visibility.
3. Thane asks: "Should I share this completion with your team?"
4. If granted, publish completion event into team-visible channel + ACL context.
5. If denied, keep completion state private and retain waiver audit trail.

## D1 migration

Migration file:
- `infra/d1/migrations/0005-identity-notes-task-actions-and-waivers.sql`

This must be applied to each environment database before these features are used.
