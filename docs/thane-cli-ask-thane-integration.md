# Thane CLI Ask Thane Integration

Thane CLI should integrate with Ask Thane as another messaging provider, not as a separate assistant account.

## Identity

The canonical identity is `people`.

Provider identities attach through `identity_accounts`:

- Slack: `provider = 'slack'`, `external_user_id = <slack user id>`, optional `email`
- Thane CLI: `provider = 'thane_cli'`, `external_user_id = <verified account email>`, `email = <verified account email>`

When Slack and Thane CLI identities share the same verified email, they should resolve to the same person. That lets person-scoped notes, task ownership patterns, and reminders work across both platforms.

## CLI Behavior

Ask Thane is optional per workspace.

```bash
thane ask-thane enable
thane ask-thane status --json
thane ask-thane disable
```

Enabling creates or reuses `@thane` as a workspace bot user. Messages that mention `@thane` are Ask Thane events. In the local MVP this produces a deterministic placeholder response. In hosted mode, those events should be sent to the bot worker and processed by the existing agent runtime.

## Backend Event Shape

Hosted Thane CLI events should normalize into the same conceptual shape as Slack messages:

```json
{
  "provider": "thane_cli",
  "organization_id": "org_...",
  "workspace_id": "wsp_...",
  "conversation_source_id": "conv_...",
  "message_id": "msg_...",
  "thread_id": "msg_root_or_null",
  "text": "@thane can you track this?",
  "author": {
    "provider": "thane_cli",
    "external_user_id": "garrett@example.com",
    "email": "garrett@example.com",
    "display_name": "Garrett"
  },
  "occurred_at": "2026-06-13T00:00:00.000Z"
}
```

The bot worker should call `resolveOrCreatePersonForIdentity` with:

```ts
{
  provider: "thane_cli",
  externalUserId: verifiedAccountEmail,
  email: verifiedAccountEmail,
  isVerified: true
}
```

## Compatibility Goal

A user can install Ask Thane in Slack and use Thane CLI in the same organization. If both identities have the same verified email, Ask Thane treats them as one person.
