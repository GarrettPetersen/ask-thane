# Ask Thane Setup Checklist (Env, Keys, Cloudflare Workers)

This checklist is for standing up a working dev/test backend for the current codebase.

## 0) Current state and expectations
- Landing page is already a Cloudflare Worker (`apps/landing`).
- You still need to provision three additional Workers:
  - `apps/bot-worker`
  - `apps/api-worker`
  - `apps/payments-worker`
- Slack request signature verification is implemented in the bot worker.
- Bot worker now supports scheduled Slack polling that can run the same tool-calling agent runtime used by webhook ingestion.

## 1) One-time accounts and access
- [ ] Cloudflare account with Workers + D1 enabled
- [ ] Slack app in your test workspace
- [ ] OpenAI API account (recommended first)
- [ ] Anthropic API account (optional for now)
- [ ] Stripe account (optional until billing work starts)

## 2) Local env file (`.env`)
Use `.env.example` as the template:

```bash
cp .env.example .env
```

Fill these values:
- [ ] `CLOUDFLARE_ACCOUNT_ID`
- [ ] `CLOUDFLARE_API_TOKEN`
- [ ] `OPENAI_API_KEY`
- [ ] `ANTHROPIC_API_KEY` (optional if not using Anthropic yet)
- [ ] `SLACK_SIGNING_SECRET`
- [ ] `SLACK_BOT_TOKEN` (legacy fallback; optional once OAuth installs are live)
- [ ] `SLACK_CLIENT_ID`
- [ ] `SLACK_CLIENT_SECRET`
- [ ] `SLACK_OAUTH_STATE_SECRET`
- [ ] `SLACK_REDIRECT_URI` (recommended explicit callback URL)
- [ ] `SLACK_BOT_SCOPES` (optional override; defaults exist in worker config)
- [ ] `STRIPE_SECRET_KEY` (optional currently)
- [ ] `STRIPE_WEBHOOK_SECRET` (optional currently)
- [ ] `DEFAULT_LLM_PROVIDER` (default `openai`)
- [ ] `DEFAULT_LLM_MODEL` (default `gpt-4.1-mini`)
- [ ] `DEFAULT_ORGANIZATION_ID` (default `org_0`)
- [ ] `ADMIN_TRIGGER_TOKEN` (for protected manual poll/status endpoints)

Notes:
- `.env` is for local workflows and your own reference.
- Cloudflare Workers do not automatically consume your local `.env` in production; set secrets/vars in Cloudflare too.

## 3) Create and migrate D1
From `apps/bot-worker`:

```bash
cd apps/bot-worker
npx wrangler d1 create ask-thane
```

After creation:
- [ ] Copy the returned `database_id`.
- [ ] Replace `database_id` in:
  - `apps/bot-worker/wrangler.toml`
  - `apps/api-worker/wrangler.toml`

Apply schema and migrations (remote):

```bash
npx wrangler d1 execute ask-thane --remote --file ../../infra/d1/schema.sql
npx wrangler d1 execute ask-thane --remote --file ../../infra/d1/migrations/0001_org-multitenancy.sql
npx wrangler d1 execute ask-thane --remote --file ../../infra/d1/migrations/0002_access-control-foundations.sql
npx wrangler d1 execute ask-thane --remote --file ../../infra/d1/migrations/0003_slack-workspace-installs.sql
npx wrangler d1 execute ask-thane --remote --file ../../infra/d1/migrations/0004_waitlist-signups.sql
npx wrangler d1 execute ask-thane --remote --file ../../infra/d1/migrations/0005-identity-notes-task-actions-and-waivers.sql
npx wrangler d1 execute ask-thane --remote --file ../../infra/d1/migrations/0006-workspace-poll-cursors.sql
```

## 4) Configure bot Worker (`ask-thane-bot`)
Deploy once to create/update the Worker:

```bash
cd apps/bot-worker
npx wrangler deploy
```

Set secrets (recommended now):

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_CLIENT_ID
npx wrangler secret put SLACK_CLIENT_SECRET
npx wrangler secret put SLACK_OAUTH_STATE_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ADMIN_TRIGGER_TOKEN
```

Set non-secret vars in `apps/bot-worker/wrangler.toml`:
- [ ] `DEFAULT_LLM_PROVIDER`
- [ ] `DEFAULT_LLM_MODEL`
- [ ] `DEFAULT_ORGANIZATION_ID`

Verify endpoint:
- [ ] `GET /health` returns 200 on bot Worker URL
- [ ] `POST /webhooks/slack/events` is reachable
- [ ] `POST /admin/poll/run` works with `Authorization: Bearer <ADMIN_TRIGGER_TOKEN>`
- [ ] `GET /admin/poll/status` works with `Authorization: Bearer <ADMIN_TRIGGER_TOKEN>`

## 5) Configure API Worker (`ask-thane-api`)

```bash
cd apps/api-worker
npx wrangler deploy
```

Checklist:
- [ ] D1 binding points at same `ask-thane` database as bot worker
- [ ] `GET /health` returns 200
- [ ] `GET /v1/tasks/open-visible?...` returns JSON

## 6) Configure payments Worker (`ask-thane-payments`)

```bash
cd apps/payments-worker
npx wrangler deploy
```

Set Stripe secret(s):

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_SECRET_KEY
```

Checklist:
- [ ] `GET /health` returns 200
- [ ] `POST /webhooks/stripe` endpoint exists

## 7) Slack app configuration
In Slack app settings:
- [ ] Upload app icon in `Basic Information` -> `Display Information`:
  - Use `apps/bot-worker/assets/slack-bot-profile-512.png` (white mark on dark gray square) for the bot profile image.
  - Editable source: `apps/bot-worker/assets/slack-bot-profile-source-dark.svg`.

### Event request URL
- [ ] Set Events API Request URL to:
  - `https://<your-bot-worker-domain>/webhooks/slack/events`
- [ ] Confirm URL verification succeeds.

### OAuth install flow (required for multi-workspace)
- [ ] Add Redirect URL in Slack app OAuth settings:
  - `https://<your-bot-worker-domain>/slack/oauth/callback`
- [ ] Open install URL and complete install:
  - `https://<your-bot-worker-domain>/slack/install`
- [ ] Confirm install record exists in D1 table `slack_workspace_installs`.

### Bot token scopes (for current code path)
- [ ] `channels:read`
- [ ] `groups:read`
- [ ] `im:read`
- [ ] `mpim:read`
- [ ] `channels:history`
- [ ] `groups:history`
- [ ] `im:history`
- [ ] `mpim:history`
- [ ] `chat:write`
- [ ] `reactions:write`

### Event subscriptions (bot events)
Minimum useful starting set:
- [ ] `message.channels`
- [ ] `message.groups`
- [ ] `message.im`
- [ ] `member_joined_channel`
- [ ] `member_left_channel`

Then:
- [ ] Install/reinstall app to your test Slack workspace.
- [ ] Copy signing secret into Worker secrets.
- [ ] Keep bot token secret as fallback, but expect per-workspace tokens to come from OAuth installs.

## 8) OpenAI / Anthropic setup
- [ ] Create API key in OpenAI dashboard.
- [ ] Store as `OPENAI_API_KEY` in bot Worker secrets.
- [ ] Optional: create Anthropic key and store `ANTHROPIC_API_KEY`.
- [ ] Keep provider/model defaults in bot `wrangler.toml` aligned with your preference.

Reality check:
- Webhook path uses OpenAI for the tool-calling agent runtime when `DEFAULT_LLM_PROVIDER=openai` and `OPENAI_API_KEY` is set.
- Scheduled polling can also invoke that runtime for context-driven interpretation.

## 9) Cloudflare routing and domains
- [ ] Keep landing Worker on `askthane.com` (already done).
- [ ] Put bot/api/payments Workers on non-conflicting subdomains, for example:
  - `bot.askthane.com`
  - `api.askthane.com`
  - `payments.askthane.com`
- [ ] Update Slack/Stripe webhook URLs to those final domains.

## 10) Final smoke test
- [ ] Hit all three `/health` endpoints.
- [ ] Send a message in a subscribed Slack channel and confirm bot webhook returns `{ ok: true, ... }`.
- [ ] Wait for next cron window and confirm poll ingestion writes rows without webhook traffic.
- [ ] Query API worker for open tasks.
- [ ] Confirm D1 rows are being written (`tasks`, `task_actions`, `ingest_events`, `conversation_sources`, `identity_accounts`, `workspace_poll_cursors`).

## 11) Recommended order from where you are now
1. [ ] Set Cloudflare + D1 first.
2. [ ] Deploy bot/api workers.
3. [ ] Configure Slack app and events URL.
4. [ ] Add OpenAI key (and Anthropic optionally).
5. [ ] Deploy payments worker + Stripe webhook only when you start billing flows.
6. [ ] Add bot to test Slack org after the above is stable.

## Reference docs
- Slack `conversations.members` scopes: https://api.slack.com/methods/conversations.members/test
- Slack `member_joined_channel` event and required scopes: https://api.slack.com/events/member_joined_channel
- Slack URL verification event: https://api.slack.com/events/url_verification
- Slack request signing: https://api.slack.com/docs/verifying-requests-from-slack
- Cloudflare Wrangler config (`[[d1_databases]]`): https://developers.cloudflare.com/workers/wrangler/configuration/
- Cloudflare D1 getting started: https://developers.cloudflare.com/d1/get-started/
