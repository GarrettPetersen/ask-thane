# Ask Thane Notification Routing

Ask Thane should route proactive pings by person, not by platform identity.

## Preference

Each person can choose a preferred ping location:

- `origin`: ping where the task/reminder originated
- `thane_cli`: ping in Thane CLI
- `slack`: ping in Slack
- `both`: ping in both Slack and Thane CLI

The hosted schema is `person_notification_preferences`. The local Thane CLI MVP stores the same setting per account.

## CLI Commands

```bash
thane notify location
thane notify location origin
thane notify location thane_cli
thane notify location slack
thane notify location both
```

## Conversational Setting

Ask Thane should update this preference when the user asks in natural language, similar to notification cadence:

```text
@thane ping me here
@thane send reminders in Slack
@thane notify me in both places
@thane use the original place for pings
```

The hosted agent runtime should expose tools analogous to cadence tools:

- `get_ping_location`
- `set_ping_location`

Both tools should operate on the actor person's `person_id`, resolved through `identity_accounts`.

## Delivery Behavior

When Ask Thane creates a reminder/follow-up:

1. Resolve the assignee to `person_id`.
2. Load `person_notification_preferences`.
3. Resolve available delivery destinations from `identity_accounts`.
4. Deliver according to preference:
   - `origin`: original provider if available, otherwise best available destination
   - `thane_cli`: Thane CLI if linked, otherwise fallback
   - `slack`: Slack if linked, otherwise fallback
   - `both`: all linked enabled destinations

Do not blindly ping both by default. Default is `origin`.
