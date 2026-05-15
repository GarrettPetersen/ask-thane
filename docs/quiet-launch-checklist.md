# Quiet Launch Checklist

This checklist is for launching with real teams while keeping distribution controlled and risk low.

## 1) Product/account boundaries
- [ ] Slack OAuth install creates an org account boundary automatically:
  - `organizations` row exists.
  - `organization_external_accounts` row exists for provider `slack`.
  - `workspaces` row points at that org.
- [ ] For Slack Enterprise installs, verify all installed workspaces map to the same org account when `enterprise_id` is present.
- [ ] Free-tier seat cap behavior is validated (11th active participant is not tracked on free).

## 2) Environment and deployment safety
- [ ] Staging and production use separate D1 databases.
- [ ] Staging and production use separate bot domains and Slack redirect URIs.
- [ ] Staging deploy pipeline applies non-destructive migrations before worker deploy.
- [ ] Production deploy pipeline is manual and blocks unless tests pass and staging succeeded for the same SHA.

## 3) Slack integration readiness
- [ ] App scopes and events are configured and reinstalled after scope changes.
- [ ] `/slack/install` and `/slack/oauth/callback` complete successfully.
- [ ] `slack_workspace_installs` has valid bot tokens for installed workspaces.
- [ ] Bot is added to at least one pilot channel and one DM flow is validated.

## 4) Billing and metering readiness
- [ ] `llm_usage_events` records token/cost telemetry.
- [ ] Daily usage aggregation (`/admin/usage/aggregate`) runs successfully.
- [ ] Stripe meter sync (`/admin/usage/sync-stripe`) is configured for `ai_overage_usd` (not raw `llm_cost_usd`).
- [ ] Workspace pricing/tier defaults are validated against current catalog.

## 5) Compliance and trust basics
- [ ] Public legal pages are live and linked (Privacy, Terms, Acceptable Use, Subprocessors).
- [ ] Slack app listing remains private/unlisted during quiet launch.
- [ ] Internal incident response contact path is documented.

## 6) Pilot operations
- [ ] Pick 2-5 pilot workspaces with known admins.
- [ ] Establish a support DM/channel for pilot feedback.
- [ ] Run daily checks on ingestion, task accuracy, reminder behavior, and billing metrics.
- [ ] Keep a rollback plan: revert worker deploy + pause cron triggers if needed.

## 7) Exit criteria for broader launch
- [ ] No cross-org data leak incidents.
- [ ] Reminder and follow-up jobs remain stable for at least 7 consecutive days.
- [ ] Billing meters and invoice previews match expected usage for pilot orgs.
- [ ] Top recurring user-reported errors have fixes or mitigations documented.
