# Agent Guidance

Thane is an agent-first chat application. Treat chat as a product that must work for people and their coding agents across the same hosted data, not as separate local experiments.

## Core Principles

- Thane Chat has three first-class surfaces: the web app, the CLI command set, and the terminal chat client.
- Feature parity across those three surfaces is a product requirement. If users can do something in one chat surface, they should be able to do it in the other two unless there is a clear platform limitation.
- Hosted mode is canonical. Do not add local-only messaging behavior. Local files are client state, cache, or configuration around hosted workspaces.
- Keep Ask Thane endpoint-neutral in shared code. Slack-specific names belong only at Slack transport edges; Thane Chat-specific names belong only at Thane Chat transport edges.
- The web app should feel like the CLI translated to the browser: compact, text-first, direct, and calm. Avoid decorative emoji or extra explanatory copy unless the CLI also uses it.
- Workspace and channel navigation should stay tucked into menus or collapsed controls on the web app, especially on mobile.
- Settings and administrative actions should live behind menus or explicit controls, not as long always-visible panels below chat.

## Chat Surface Map

- Web app: `apps/landing/public/chat-app.html`
- CLI commands: `apps/thane-cli/src/index.ts`
- Hosted CLI API helpers: `apps/thane-cli/src/hosted.ts`
- Terminal chat client: `apps/thane-cli/src/chat.ts`
- Terminal slash command registry: `apps/thane-cli/src/slash-commands.ts`
- Command/help registry: `apps/thane-cli/src/commands.ts`
- Hosted API: `apps/api-worker/src/index.ts`
- D1 migrations: `infra/d1/migrations/`

## Parity Checklist

When adding or changing chat functionality, check each layer:

- API endpoint, validation, permission checks, and hosted sync behavior.
- Shared hosted helper in the CLI package when the CLI or terminal needs to call the API.
- CLI command, command help text, and useful error output.
- Terminal slash command or menu action.
- Web app control, mobile affordance, loading state, and error handling.
- Tests or typechecks for every package touched.
- Documentation or in-app help where users discover the feature.

For membership and admin features, apply the same permission model everywhere. Admin-only actions must be admin-only in web, CLI, and terminal. Do not allow removing, demoting, leaving, or banning the last workspace owner.

## Design Standards

- Prefer one clear way to do each primary action in a surface. For example, chat input should not appear in two competing places.
- Keep message views as consecutive lines of text, matching the terminal feel.
- Use subtle hover or long-press affordances for secondary message actions like reactions.
- Use menus for workspace switching, channel switching, settings, invites, billing, and install guidance.
- Avoid marketing copy inside the chat app. Users came to chat.
- The public website can be concise and promotional; the chat app should be functional first.

## Billing And Ask Thane

- Ask Thane should be optional in Thane Chat, like the Slack integration.
- Ask Thane should behave as an external app/user in Thane Chat. Thane Chat should not run Ask Thane logic inside its core message creation path.
- External apps should use the generic Thane Chat webhook surface: `thane webhooks docs`, `thane webhooks create ... --json`, and `POST /v1/thane-cli/webhooks/messages`.
- Billing gates should be enforced consistently across Slack and Thane Chat workspaces.
- Match users across endpoints by email when sharing billing accounts or entitlements.
- Keep scheduled DMs, task logging, and message-reading behavior endpoint-neutral where possible.

## Webhook Surface

- Admins create workspace webhooks with `thane webhooks create <name> <https-url> --json`.
- Webhooks receive signed `message.created` events. Verify `x-thane-signature`, which signs `<x-thane-timestamp>.<raw body>` with the returned signing secret.
- Webhook tokens are shown once. Use them only as bearer tokens for `POST /v1/thane-cli/webhooks/messages`.
- Webhook apps post as their own workspace member identity. They are not special-cased by the chat message endpoint.
- Treat message `source` as the public origin: `chat` for live UI messages, `terminal` for signed-in user commands/scripts, and `webhook` for external app identities.
- Receiver URLs must be HTTPS except localhost. Token creation/list/disable is admin-only. Private-channel delivery must respect app channel access.
- Agents should discover the exact current protocol with `thane webhooks docs` or `thane commands --json`.

## Data And Schema

- Use D1 migrations for schema changes.
- Prefer additive migrations. Run the non-destructive migration check before shipping.
- Hosted sync responses should filter data by workspace membership, channel membership, bans, and permissions.
- Invite links must route cleanly through the web experience and remain usable by CLI and terminal users.

## Verification

Use the smallest useful verification for tiny changes, and broaden it when touching shared chat behavior.

Common commands:

```sh
pnpm --filter @ask-thane/api-worker typecheck
pnpm --filter @ask-thane/thane-cli typecheck
pnpm --filter @ask-thane/landing test
pnpm --filter @ask-thane/api-worker test
pnpm --filter @ask-thane/thane-cli test
node scripts/check-d1-migrations-nondestructive.mjs
pnpm test
git diff --check
```

Wrangler local build or deploy commands may print permission warnings about writing logs under the user's Library preferences directory. Treat those as informational only when the command exits successfully.

Do not claim a change is deployed or published to npm unless the relevant GitHub Actions, deploy run, or npm package version has been checked.
