#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { runChat } from "./chat.js";
import { cliCommands, renderCliCommands } from "./commands.js";
import {
  addHostedChannelMember,
  banHostedWorkspaceMember,
  createHostedBillingLink,
  createHostedChannel,
  createHostedWorkspace,
  ensureHostedWorkspace,
  hasHostedChat,
  joinHostedChannel,
  leaveHostedChannel,
  leaveHostedWorkspace,
  reactHostedMessage,
  removeHostedChannelMember,
  removeHostedWorkspaceMember,
  sendHostedMessage,
  setHostedWorkspaceMemberRole,
  syncHostedStore,
  unbanHostedWorkspaceMember
} from "./hosted.js";
import { renderChannels, renderDms, renderInbox, renderMembers, renderMessages, printJson, renderUsers, renderWorkspaces } from "./render.js";
import { parseSlackExportZip } from "./slack-import.js";
import { resolveStorePath, ThaneStore } from "./store.js";
import { parseSince } from "./time.js";
import { checkForUpdate, renderUpdateStatus } from "./update.js";
import { CLI_PACKAGE_NAME, CLI_VERSION } from "./version.js";
import type { SlackImportPreview } from "./slack-import.js";
import type { SlackImportResult } from "./store.js";
import type { NotificationPreference, PingLocation, ThaneAccount, WorkspaceRole } from "./model.js";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

interface HostedAccountState {
  isNewAccount?: boolean;
  hasProfile?: boolean;
  workspaceCount?: number;
  verifiedLoginCount?: number;
  mfaEnabled?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function flagNumber(args: ParsedArgs, key: string, fallback: number): number {
  const value = flagString(args, key);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive number.`);
  }
  return parsed;
}

function wantsJson(args: ParsedArgs): boolean {
  return args.flags.has("json");
}

function applyGlobalFlags(args: ParsedArgs): void {
  const storePath = flagString(args, "store");
  if (storePath) {
    process.env.THANE_STORE_PATH = storePath;
  }
}

function flagRole(args: ParsedArgs, fallback: WorkspaceRole): WorkspaceRole {
  const value = flagString(args, "role") ?? fallback;
  if (value !== "owner" && value !== "admin" && value !== "member") {
    throw new Error("--role must be owner, admin, or member.");
  }
  return value;
}

function parsePingLocation(value: string | undefined): PingLocation {
  if (value === "origin" || value === "thane_cli" || value === "slack" || value === "both") {
    return value;
  }
  throw new Error("Ping location must be origin, thane_cli, slack, or both.");
}

function readMessageText(args: ParsedArgs, startAt: number): string {
  if (args.flags.has("stdin")) {
    return readFileSync(0, "utf8").trim();
  }
  return args.positionals.slice(startAt).join(" ").trim();
}

async function readWorkspaceArtInput(args: ParsedArgs, startAt: number): Promise<string> {
  const file = flagString(args, "file");
  if (file) {
    return readFile(file, "utf8");
  }
  if (args.flags.has("stdin")) {
    return readFileSync(0, "utf8");
  }
  return args.positionals.slice(startAt).join(" ");
}

function createPrompter(): { ask(label: string): Promise<string>; close(): void } {
  const terminal = createInterface({ input: stdin, output: stdout });
  return {
    ask(label: string): Promise<string> {
      return new Promise((resolve) => {
        terminal.question(label, (answer) => {
          resolve(answer.trim());
        });
      });
    },
    close(): void {
      terminal.close();
    }
  };
}

function thaneApiBaseUrl(): string | undefined {
  const value = process.env.THANE_API_BASE_URL?.trim();
  if (value === "local" || value === "none") {
    return undefined;
  }
  return (value || "https://api.askthane.com").replace(/\/+$/g, "");
}

function thaneApiError(payload: { error?: string; retryAfterSeconds?: number }, status: number): string {
  if (payload.error === "rate_limited" && payload.retryAfterSeconds) {
    return `rate_limited: try again in ${payload.retryAfterSeconds}s`;
  }
  return payload.error ?? `Thane API request failed with status ${status}`;
}

async function postThaneApi<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const baseUrl = thaneApiBaseUrl();
  if (!baseUrl) {
    throw new Error("Set THANE_API_BASE_URL to use hosted Thane auth.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string; retryAfterSeconds?: number } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(thaneApiError(payload, response.status));
  }
  return payload;
}

async function getThaneApi<T>(path: string, authToken: string): Promise<T> {
  const baseUrl = thaneApiBaseUrl();
  if (!baseUrl) {
    throw new Error("Set THANE_API_BASE_URL to use hosted Thane auth.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${authToken}` }
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string; retryAfterSeconds?: number } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(thaneApiError(payload, response.status));
  }
  return payload;
}

async function postThaneApiWithAuth<T>(path: string, authToken: string, body: Record<string, unknown> = {}): Promise<T> {
  const baseUrl = thaneApiBaseUrl();
  if (!baseUrl) {
    throw new Error("Set THANE_API_BASE_URL to use hosted Thane auth.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string; retryAfterSeconds?: number } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(thaneApiError(payload, response.status));
  }
  return payload;
}

async function startHostedAuth(email: string, displayName?: string): Promise<{
  email: string;
  delivery: "email" | "dev_code";
  expiresAt: string;
  verificationCode?: string;
}> {
  return postThaneApi("/v1/thane-cli/auth/start", {
    email,
    ...(displayName ? { displayName } : {})
  });
}

async function setHostedWorkspaceHandle(store: ThaneStore, handle: string): Promise<string> {
  const cleaned = handle.trim().replace(/^@/, "");
  if (!cleaned) {
    throw new Error("Handle must contain at least one character.");
  }
  const token = requireHostedAuthToken(store);
  const response = await postThaneApiWithAuth<{ handle: string; workspaceHandle?: string }>("/v1/thane-cli/profile", token, {
    handle: cleaned,
    workspaceId: store.activeWorkspace.id,
    scope: "workspace"
  });
  const workspaceHandle = response.workspaceHandle ?? response.handle;
  await store.setWorkspaceHandle(workspaceHandle);
  await syncHostedStore(store, { workspaceId: store.activeWorkspace.id });
  return workspaceHandle;
}

async function setHostedAccountDisplayName(store: ThaneStore, displayName: string): Promise<string> {
  const cleaned = displayName.trim();
  if (!cleaned) {
    throw new Error("Display name must contain at least one character.");
  }
  const token = requireHostedAuthToken(store);
  const response = await postThaneApiWithAuth<{ account: ThaneAccount; displayName: string; accountDisplayName?: string }>("/v1/thane-cli/profile", token, {
    displayName: cleaned,
    scope: "account"
  });
  const accountDisplayName = response.accountDisplayName ?? response.displayName;
  await store.setAccountDisplayName(accountDisplayName);
  await syncHostedStore(store);
  return accountDisplayName;
}

async function verifyHostedAuth(email: string, code: string): Promise<
  | { account: ThaneAccount; accountState?: HostedAccountState; mfaRequired?: false }
  | { email: string; accountState?: HostedAccountState; mfaRequired: true; mfaChallengeToken: string }
> {
  return postThaneApi("/v1/thane-cli/auth/verify", { email, code });
}

async function verifyHostedMfa(challengeToken: string, code: string): Promise<{ account: ThaneAccount; accountState?: HostedAccountState }> {
  return postThaneApi<{ account: ThaneAccount; accountState?: HostedAccountState }>("/v1/thane-cli/auth/mfa-verify", { challengeToken, code });
}

async function finishHostedAuth(input: {
  store: ThaneStore;
  email: string;
  code: string;
  prompts?: { ask(label: string): Promise<string>; close(): void } | undefined;
}): Promise<{ account: ThaneAccount; accountState?: HostedAccountState }> {
  const verified = await verifyHostedAuth(input.email, input.code);
  let account: ThaneAccount;
  let accountState = verified.accountState;
  if ("mfaRequired" in verified && verified.mfaRequired) {
    const mfaCode = await input.prompts?.ask("Authenticator code: ");
    const mfaVerified = await verifyHostedMfa(verified.mfaChallengeToken, mfaCode ?? "");
    account = mfaVerified.account;
    accountState = mfaVerified.accountState ?? accountState;
  } else {
    account = verified.account;
  }
  const stored = await input.store.acceptVerifiedAccount(account);
  await syncHostedStore(input.store);
  return {
    account: stored,
    ...(accountState ? { accountState } : {})
  };
}

function renderHostedAuthStart(response: { email: string; delivery: "email" | "dev_code"; verificationCode?: string }): string {
  if (response.delivery === "dev_code" && response.verificationCode) {
    return `verification code for ${response.email}: ${response.verificationCode}\n`;
  }
  return `sent a verification code to ${response.email}\n`;
}

async function handleUpdateCommand(args: ParsedArgs): Promise<void> {
  const status = await checkForUpdate({ force: args.flags.has("force") });
  if (wantsJson(args)) {
    printJson(status);
    return;
  }
  process.stdout.write(`${renderUpdateStatus(status)}\n`);
  if (status.state !== "available") {
    return;
  }
  if (!stdin.isTTY) {
    return;
  }
  const prompts = createPrompter();
  try {
    const answer = await prompts.ask("Update now? [y/N] ");
    if (!/^y(es)?$/i.test(answer)) {
      return;
    }
  } finally {
    prompts.close();
  }
  const result = spawnSync("npm", ["install", "-g", `${CLI_PACKAGE_NAME}@latest`], { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm install exited with status ${result.status ?? "unknown"}`);
  }
}

function requireHostedAuthToken(store: ThaneStore): string {
  const token = store.currentAccount?.authToken;
  if (!token) {
    throw new Error("Run `thane init` with hosted Thane Chat auth before using this command.");
  }
  return token;
}

function parseExpiresInHours(value: string | undefined): number {
  if (!value) {
    return 24 * 7;
  }
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+)(h|d)?$/.exec(trimmed);
  if (!match) {
    throw new Error("--expires must be a duration like 24h or 7d.");
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "h";
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("--expires must be positive.");
  }
  return unit === "d" ? amount * 24 : amount;
}

function flagMemberRole(args: ParsedArgs, fallback: "admin" | "member"): "admin" | "member" {
  const value = flagString(args, "role") ?? fallback;
  if (value !== "admin" && value !== "member") {
    throw new Error("--role must be admin or member.");
  }
  return value;
}

function slugFromSlackExportPath(path: string): string {
  const base = basename(path).replace(/\.zip$/i, "").replace(/slack[-_ ]?export/gi, "slack").replace(/[^a-z0-9._-]+/gi, "-");
  return base.toLowerCase().replace(/^-+|-+$/g, "") || "slack-import";
}

function hostedWorkspaceId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `wsp_${Date.now().toString(36)}${random}`;
}

function renderSlackImportSummary(summary: SlackImportPreview | SlackImportResult, mode: "preview" | "apply"): string {
  const lines = [
    mode === "preview" ? "Slack export preview" : "Slack export imported",
    `users: ${summary.users}`,
    `accounts with email: ${summary.accountsWithEmail}`,
    `public channels: ${summary.publicChannels}`,
    `private channels: ${summary.privateChannels}`,
    `DMs/group DMs: ${summary.dms}`,
    `messages: ${summary.messages}`,
    `threaded replies: ${summary.threadedReplies}`,
    `reactions: ${summary.reactions}`,
    `file links: ${summary.files}`
  ];
  if ("importedMessages" in summary) {
    lines.push(
      `new users: ${summary.importedUsers}`,
      `new conversations: ${summary.importedChannels}`,
      `new messages: ${summary.importedMessages}`,
      `duplicate messages skipped: ${summary.skippedDuplicateMessages}`
    );
  } else {
    lines.push(summary.requiresTeamPlan ? "requires: Thane Chat Team for apply" : "requires: free tier is enough");
    lines.push("apply with: thane import slack-export <zip> --apply");
  }
  return `${lines.join("\n")}\n`;
}

function help(): string {
  return `Thane Chat CLI

Command discovery:
  thane --version
  thane update [--json] [--force]
  thane commands [--json]
  thane help
  thane doctor [--json]

Agent helpers:
  thane agent context [--json]
  thane agent install-instructions
  thane export messages [--all] [--channel general] [--since "7 days ago"] [--jsonl]

Interactive:
  thane chat [channel]
  thane dm <handle>

Accounts:
  thane init [--email <email>] [--name "..."] [--handle <handle>]
  thane signup <email> [--name "..."]
  thane login <email>
  thane verify <email> <code>
  thane whoami [--json]
  thane profile name <display-name> [--json]
  thane profile handle <handle> [--json]
  thane profile account-name <display-name> [--json]
  thane logout

Security:
  thane mfa status [--json]
  thane mfa setup
  thane mfa disable <code>

Ask Thane:
  thane ask-thane status [--json]
  thane ask-thane enable [--json]
  thane ask-thane disable

Integrations:
  thane webhooks list [--json]
  thane webhooks create <name> <https-url> [--event message.created] [--json]
  thane webhooks disable <id-or-name> [--json]
  thane webhooks docs

Notifications:
  thane notify location [--json]
  thane notify location <origin|thane_cli|slack|both> [--json]

Billing:
  thane billing status [--json]
  thane billing checkout
  thane billing portal
  thane billing activate-team-dev

Imports:
  thane import slack-export <export.zip> [--preview] [--json]
  thane import slack-export <export.zip> --apply [--json]

Channels:
  thane channels [--json]
  thane channel create <name> [--topic "..."] [--private]
  thane channel join <channel>
  thane channel leave <channel>
  thane channel invite <channel> <handle-or-email>
  thane channel remove <channel> <handle-or-email>
  thane channel members <channel> [--json]

Members, users, and DMs:
  thane members [--json]
  thane invite <email> [--role admin|member] [--expires 7d] [--handle "..."]
  thane invite-link create [--role admin|member] [--expires 7d] [--max-uses 10] [--json]
  thane invite-link accept <link-or-token> [--json]
  thane member role <handle-or-email> <admin|member>
  thane member remove <handle-or-email>
  thane member ban <handle-or-email> [--reason "..."]
  thane member unban <email>
  thane users [--json]
  thane user add <handle> [--name "..."]
  thane dms [--json]
  thane dm <handle>
  thane dm-recent <handle> [--limit 20] [--json]
  thane dm-send <handle> <message>
  thane dm-send <handle> --stdin

Teams:
  thane teams [--json]
  thane team current [--json]
  thane team create <name> [--slug "..."]
  thane team use <slug>
  thane team leave
  thane team art show [--json]
  thane team art set [--file <path>|--stdin|<text>]
  thane team art reset
  thane team create-from-slack <export.zip> [--slug "..."] [--name "..."] [--apply] [--json]

Messages:
  thane inbox [--all-teams] [--json]
  thane send <channel> <message>
  thane send <channel> --stdin
  thane recent [channel] [--limit 20] [--since today] [--json]
  thane see-recent [channel] [--since "2 days ago"] [--json]
  thane unread [--json]
  thane mentions [--limit 20] [--since yesterday] [--json]
  thane search <query> [--json]
  thane thread <message-id> [--json]
  thane reply <message-id> <message>
  thane reply <message-id> --stdin
  thane react <message-id> <emoji>
  thane mark-read <channel>

Environment:
  THANE_STORE_PATH=/path/to/store.json
  thane --store /path/to/store.json recent --json

The store is a hosted Thane Chat cache. All channels, messages, mentions, unread state, and search results are scoped to the active team.`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function renderDoctor(args: ParsedArgs): Promise<void> {
  const storePath = resolveStorePath();
  const storeExists = await fileExists(storePath);
  if (!storeExists) {
    const response = {
      version: CLI_VERSION,
      resolvedStorePath: storePath,
      storeExists,
      hint: "Run `thane init` to sign in to hosted Thane Chat."
    };
    wantsJson(args) ? printJson(response) : process.stdout.write(`${renderDoctorText(response)}\n`);
    return;
  }
  const store = await ThaneStore.open();
  const stats = store.stats();
  const response = {
    version: CLI_VERSION,
    resolvedStorePath: storePath,
    storeExists,
    account: store.currentAccount?.email ?? null,
    activeWorkspace: store.hasActiveWorkspace() ? store.activeWorkspace.slug : null,
    ...stats,
    hint: "The store is a hosted Thane Chat cache. Run `thane init` to sign in or refresh auth."
  };
  wantsJson(args) ? printJson(response) : process.stdout.write(`${renderDoctorText(response)}\n`);
}

function renderDoctorText(input: Record<string, unknown>): string {
  return [
    `version: ${input.version}`,
    `store: ${input.resolvedStorePath}`,
    `store exists: ${input.storeExists}`,
    input.account ? `account: ${input.account}` : undefined,
    input.activeWorkspace ? `team: ${input.activeWorkspace}` : undefined,
    typeof input.messageCount === "number" ? `messages: ${input.messageCount}` : undefined,
    typeof input.unreadCount === "number" ? `unread: ${input.unreadCount}` : undefined,
    `hint: ${input.hint}`
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function agentInstructions(): string {
  return `# Thane Chat agent instructions

- Read from the user store by default: \`thane see-recent --json\`.
- Check store/account/team first: \`thane doctor --json\`.
- Get compact context: \`thane agent context --json\`.
- List channels: \`thane channels --json\`.
- Read recent messages from the server-backed cache: \`thane see-recent --json\`.
- Read a thread: \`thane thread <message-id> --json\`.
- Search messages: \`thane search <query> --json\`.
- Do not send, reply, react, invite, or mark messages read unless explicitly asked.
- For fixture cache files, use \`thane --store ./fixture-store.json ...\` or \`THANE_STORE_PATH=./.thane/store.json thane ...\`.
`;
}

function webhookDocs(): string {
  return `# Thane Chat webhooks

Use webhooks to build external Thane Chat apps. Admins create an app identity for a team, your app receives signed events, and the app token can post messages or reactions back as that app.

Create a team webhook:

thane webhooks create my-app https://example.com/thane/events --json

The create response includes:

{
  "webhook": { "id": "twh_...", "name": "my-app", "status": "active" },
  "token": "twk_...",
  "signingSecret": "whsec_...",
  "postMessageEndpoint": "https://api.askthane.com/v1/thane-cli/webhooks/messages",
  "postReactionEndpoint": "https://api.askthane.com/v1/thane-cli/webhooks/reactions"
}

Outbound event:

POST <your https-url>
x-thane-event: message.created
x-thane-delivery-id: <delivery-id>
x-thane-webhook-id: <webhook-id>
x-thane-timestamp: <ISO timestamp>
x-thane-signature: v1=<hex hmac sha256>

The signature signs this exact string with the returned signingSecret:

<x-thane-timestamp>.<raw request body>

Message event body:

{
  "id": "tdlv_...",
  "type": "message.created",
  "workspaceId": "wsp_...",
  "channelId": "tcc_...",
  "message": {
    "id": "tmsg_...",
    "authorHandle": "garrett",
    "text": "hello",
    "source": "chat",
    "createdAt": "2026-06-19T00:00:00.000Z"
  }
}

Message source values:

- chat: sent from the web or terminal chat UI
- terminal: sent through a command/script acting as a signed-in user
- webhook: sent by an external app identity

Post back as the app:

curl -X POST https://api.askthane.com/v1/thane-cli/webhooks/messages \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"channelName":"general","text":"Message from my app"}'

Send a DM as the app:

curl -X POST https://api.askthane.com/v1/thane-cli/webhooks/messages \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"dmTarget":"garrett@example.com","text":"Private message from my app"}'

Read recent app-accessible messages:

curl "https://api.askthane.com/v1/thane-cli/webhooks/messages?channelId=tcc_...&limit=50" \\
  -H "Authorization: Bearer <token>"

Read a thread:

curl "https://api.askthane.com/v1/thane-cli/webhooks/messages?channelId=tcc_...&threadRootId=tmsg_...&limit=50" \\
  -H "Authorization: Bearer <token>"

React as the app:

curl -X POST https://api.askthane.com/v1/thane-cli/webhooks/reactions \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"messageId":"tmsg_...","emoji":"📝"}'

Security notes:

- Webhook create/list/disable is admin-only.
- Receiver URLs must be https, except localhost for local development.
- App tokens are shown once and are stored hashed by Thane.
- Verify signatures using the raw request body and reject stale timestamps.
- Private-channel events are delivered only when the app identity can access that channel.
- Webhook reads, messages, and reactions are permission-checked and rate-limited per app identity and team.

Webhook tokens are shown once. Use \`thane webhooks list --json\` for IDs and status.
`;
}

function jsonl(messages: unknown[]): string {
  return messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length ? "\n" : "");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  applyGlobalFlags(args);
  const [command, second] = args.positionals;

  if (args.flags.has("version") || command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${help()}\n`);
    return;
  }

  if (command === "commands") {
    wantsJson(args) ? printJson({ commands: cliCommands }) : process.stdout.write(`${renderCliCommands()}\n`);
    return;
  }

  if (command === "doctor") {
    await renderDoctor(args);
    return;
  }

  if (command === "update") {
    await handleUpdateCommand(args);
    return;
  }

  if (command === "agent" && second === "install-instructions") {
    process.stdout.write(agentInstructions());
    return;
  }

  if ((command === "webhooks" || command === "webhook") && second === "docs") {
    process.stdout.write(webhookDocs());
    return;
  }

  if (command === "dm" && second && !wantsJson(args)) {
    await runChat(`@${second}`);
    return;
  }

  if (!command || command === "chat") {
    await runChat(command === "chat" ? second : command);
    return;
  }

  let store = await ThaneStore.open();
  const syncHosted = async (options: { workspaceId?: string; silent?: boolean } = {}): Promise<boolean> => {
    if (!hasHostedChat(store)) {
      return false;
    }
    try {
      await syncHostedStore(store, options.workspaceId ? { workspaceId: options.workspaceId } : {});
      store = await ThaneStore.open();
      return true;
    } catch (error) {
      if (!options.silent) {
        throw error;
      }
      return false;
    }
  };
  await syncHosted({ silent: true });
  const syncBeforeRead = async (): Promise<void> => {
    await syncHosted();
  };

  if (command === "agent" && second === "context") {
    await syncBeforeRead();
    const recent = store.recent(undefined, flagNumber(args, "limit", 12));
    const unread = store.unread(flagNumber(args, "unread-limit", 20));
    const response = {
      storePath: resolveStorePath(),
      account: store.currentAccount?.email ?? null,
      workspace: store.activeWorkspace,
      currentUser: store.currentUser,
      channels: store.listChannels(),
      dms: store.listDms(),
      unreadCount: unread.length,
      unread,
      recent
    };
    wantsJson(args) ? printJson(response) : process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  if (command === "export" && second === "messages") {
    await syncBeforeRead();
    const channel = flagString(args, "channel");
    const limit = flagNumber(args, "limit", 10_000);
    const since = parseSince(flagString(args, "since"));
    const exportOptions: Parameters<ThaneStore["exportMessages"]>[0] = {
      limit,
      allWorkspaces: args.flags.has("all")
    };
    if (channel) {
      exportOptions.channelName = channel;
    }
    if (since) {
      exportOptions.since = since;
    }
    const messages = store.exportMessages(exportOptions);
    if (args.flags.has("jsonl")) {
      process.stdout.write(jsonl(messages));
    } else {
      wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    }
    return;
  }

  if (command === "read") {
    const readCommand = second;
    const forwardedArgs: ParsedArgs = {
      positionals: [readCommand ?? "", ...args.positionals.slice(2)].filter(Boolean),
      flags: args.flags
    };
    if (readCommand === "recent") {
      await syncBeforeRead();
      const messages = store.recent(args.positionals[2], flagNumber(forwardedArgs, "limit", 20), parseSince(flagString(forwardedArgs, "since")));
      wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
      return;
    }
    if (readCommand === "thread") {
      const messageId = args.positionals[2];
      if (!messageId) {
        throw new Error("Usage: thane read thread <message-id>");
      }
      await syncBeforeRead();
      const messages = store.thread(messageId);
      wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
      return;
    }
    if (readCommand === "search") {
      const query = args.positionals.slice(2).join(" ").trim();
      if (!query) {
        throw new Error("Usage: thane read search <query>");
      }
      await syncBeforeRead();
      const messages = store.search(query, flagNumber(args, "limit", 20));
      wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
      return;
    }
    throw new Error("Usage: thane read <recent|thread|search> ...");
  }

  if (command === "write") {
    const writeCommand = second;
    if (writeCommand === "send") {
      const channel = args.positionals[2];
      const text = readMessageText(args, 3);
      if (!channel || !text) {
        throw new Error("Usage: thane write send <channel> <message>");
      }
      requireHostedAuthToken(store);
      const target = store.findChannel(channel);
      if (!target) {
        throw new Error(`Channel ${channel} was not found.`);
      }
      await sendHostedMessage(store, { channelId: target.id, text, source: "terminal" });
      store = await ThaneStore.open();
      const message = store.recent(target.id, 1).at(-1);
      if (!message) {
        throw new Error("Message was sent but did not sync back.");
      }
      wantsJson(args) ? printJson({ message }) : process.stdout.write(`sent ${message.id} to #${store.findChannel(channel)?.name ?? channel}\n`);
      return;
    }
    if (writeCommand === "reply") {
      const messageId = args.positionals[2];
      const text = readMessageText(args, 3);
      if (!messageId || !text) {
        throw new Error("Usage: thane write reply <message-id> <message>");
      }
      requireHostedAuthToken(store);
      const root = store.thread(messageId)[0];
      if (!root) {
        throw new Error(`Message ${messageId} was not found.`);
      }
      const target = store.findChannel(root.channel);
      if (!target) {
        throw new Error(`Channel ${root.channel} was not found.`);
      }
      await sendHostedMessage(store, { channelId: target.id, text, source: "terminal", threadRootId: root.threadRootId ?? root.id });
      store = await ThaneStore.open();
      const message = store.thread(messageId).at(-1);
      if (!message) {
        throw new Error("Reply was sent but did not sync back.");
      }
      wantsJson(args) ? printJson({ message }) : process.stdout.write(`sent ${message.id} in thread ${message.threadRootId}\n`);
      return;
    }
    if (writeCommand === "react") {
      const messageId = args.positionals[2];
      const emoji = args.positionals[3];
      if (!messageId || !emoji) {
        throw new Error("Usage: thane write react <message-id> <emoji>");
      }
      requireHostedAuthToken(store);
      await reactHostedMessage(store, { messageId, emoji });
      store = await ThaneStore.open();
      const message = store.thread(messageId)[0];
      if (!message) {
        throw new Error("Reaction was saved but the message did not sync back.");
      }
      wantsJson(args) ? printJson({ message }) : process.stdout.write(`reacted to ${messageId}\n`);
      return;
    }
    throw new Error("Usage: thane write <send|reply|react> ...");
  }

  if (command === "init") {
    if (store.currentAccount && !args.flags.has("force")) {
      const next = {
        account: store.currentAccount,
        workspace: store.hasActiveWorkspace() ? store.activeWorkspace : null,
        next: ["thane chat general", "thane commands"]
      };
      wantsJson(args)
        ? printJson(next)
        : process.stdout.write(`signed in as ${store.currentAccount.email}\nopen chat: thane chat general\n`);
      return;
    }

    const prompts = wantsJson(args) ? undefined : createPrompter();
    try {
      const email = second ?? flagString(args, "email") ?? (prompts ? await prompts.ask("Email: ") : undefined);
      if (!email) {
        throw new Error("Usage: thane init --email <email> [--name \"...\"] [--handle <handle>] --json");
      }
      const displayName = flagString(args, "name");
      const handle = flagString(args, "handle");
      const started = await startHostedAuth(email, displayName || undefined);
      if (wantsJson(args)) {
        printJson(started);
        return;
      }
      process.stdout.write(`${renderHostedAuthStart(started)}Enter the code to sign in.\n`);
      const enteredCode = await prompts?.ask("Code: ");
      const verified = await finishHostedAuth({ store, email: started.email, code: enteredCode ?? "", prompts });
      if (verified.accountState?.isNewAccount) {
        if (!displayName) {
          const promptedDisplayName = await prompts?.ask("Name (optional): ");
          if (promptedDisplayName?.trim()) {
            await setHostedAccountDisplayName(store, promptedDisplayName);
          }
        }
      }
      if (handle && store.hasActiveWorkspace()) {
        await setHostedWorkspaceHandle(store, handle);
      }
      process.stdout.write(`signed in as ${verified.account.email}\nopen chat: thane chat general\n`);
    } finally {
      prompts?.close();
    }
    return;
  }

  if (command === "signup") {
    const email = second;
    if (!email) {
      throw new Error("Usage: thane signup <email>");
    }
    const started = await startHostedAuth(email, flagString(args, "name"));
    wantsJson(args) ? printJson(started) : process.stdout.write(renderHostedAuthStart(started));
    return;
  }

  if (command === "login") {
    const email = second;
    if (!email) {
      throw new Error("Usage: thane login <email>");
    }
    const started = await startHostedAuth(email);
    wantsJson(args) ? printJson(started) : process.stdout.write(renderHostedAuthStart(started));
    return;
  }

  if (command === "verify") {
    const email = second;
    const code = args.positionals[2];
    if (!email || !code) {
      throw new Error("Usage: thane verify <email> <code>");
    }
    const prompts = wantsJson(args) ? undefined : createPrompter();
    try {
      const verified = await finishHostedAuth({ store, email, code, prompts });
      wantsJson(args) ? printJson(verified) : process.stdout.write(`signed in as ${verified.account.email}\n`);
    } finally {
      prompts?.close();
    }
    return;
  }

  if (command === "whoami") {
    const account = store.currentAccount;
    const user = store.currentUser;
    const member = store.currentMember();
    wantsJson(args)
      ? printJson({ account, user, workspace: store.activeWorkspace, member })
      : process.stdout.write(
          `${account?.email ?? "not signed in"} as ${user.displayName || `@${user.handle}`} (@${user.handle}, ${member?.role ?? "member"}) in team ${store.activeWorkspace.slug}\n`
        );
    return;
  }

  if (command === "profile" && second === "name") {
    const displayName = args.positionals.slice(2).join(" ").trim();
    if (!displayName) {
      throw new Error("Usage: thane profile name <display-name>");
    }
    const token = requireHostedAuthToken(store);
    const response = await postThaneApiWithAuth<{ account: ThaneAccount; displayName: string; workspaceDisplayName?: string }>("/v1/thane-cli/profile", token, {
      displayName,
      workspaceId: store.activeWorkspace.id,
      scope: "workspace"
    });
    const workspaceDisplayName = response.workspaceDisplayName ?? response.displayName;
    await store.setWorkspaceDisplayName(workspaceDisplayName);
    await syncHostedStore(store);
    wantsJson(args)
      ? printJson({ account: response.account, workspaceDisplayName, workspace: store.activeWorkspace })
      : process.stdout.write(`team display name: ${workspaceDisplayName}\n`);
    return;
  }

  if (command === "profile" && second === "handle") {
    const handle = args.positionals.slice(2).join(" ").trim();
    if (!handle) {
      throw new Error("Usage: thane profile handle <handle>");
    }
    const workspaceHandle = await setHostedWorkspaceHandle(store, handle);
    wantsJson(args)
      ? printJson({ handle: workspaceHandle, workspace: store.activeWorkspace })
      : process.stdout.write(`team handle: @${workspaceHandle}\n`);
    return;
  }

  if (command === "profile" && second === "account-name") {
    const displayName = args.positionals.slice(2).join(" ").trim();
    if (!displayName) {
      throw new Error("Usage: thane profile account-name <display-name>");
    }
    const token = requireHostedAuthToken(store);
    const response = await postThaneApiWithAuth<{ account: ThaneAccount; displayName: string; accountDisplayName?: string }>("/v1/thane-cli/profile", token, {
      displayName,
      scope: "account"
    });
    const accountDisplayName = response.accountDisplayName ?? response.displayName;
    await store.setAccountDisplayName(accountDisplayName);
    await syncHostedStore(store);
    wantsJson(args)
      ? printJson({ account: response.account, accountDisplayName })
      : process.stdout.write(`account default name: ${accountDisplayName}\n`);
    return;
  }

  if (command === "logout") {
    await store.logout();
    process.stdout.write("signed out\n");
    return;
  }

  if (command === "mfa" && second === "status") {
    const token = requireHostedAuthToken(store);
    const status = await getThaneApi<{ enabled: boolean }>("/v1/thane-cli/mfa/status", token);
    wantsJson(args) ? printJson(status) : process.stdout.write(status.enabled ? "MFA enabled\n" : "MFA disabled\n");
    return;
  }

  if (command === "mfa" && second === "setup") {
    const token = requireHostedAuthToken(store);
    const setup = await postThaneApiWithAuth<{ factorId: string; secret: string; otpauthUrl: string; qrSvg?: string; qrTerminal?: string }>(
      "/v1/thane-cli/mfa/setup/start",
      token
    );
    if (wantsJson(args)) {
      printJson(setup);
      return;
    }
    const prompts = createPrompter();
    try {
      process.stdout.write(
        "Set up MFA (2FA)\n" +
          "Scan this QR code with your authenticator app.\n" +
          "Examples: 1Password, Google Authenticator, Authy, Microsoft Authenticator, Apple Passwords.\n\n" +
          (setup.qrTerminal ? `${setup.qrTerminal}\n\n` : "") +
          "Manual setup fallback:\n" +
          `secret: ${setup.secret}\n` +
          `otpauth URL: ${setup.otpauthUrl}\n`
      );
      const code = await prompts.ask("Authenticator code: ");
      const verified = await postThaneApiWithAuth<{ enabled: boolean }>("/v1/thane-cli/mfa/setup/verify", token, {
        factorId: setup.factorId,
        code
      });
      process.stdout.write(verified.enabled ? "MFA enabled\n" : "MFA setup incomplete\n");
    } finally {
      prompts.close();
    }
    return;
  }

  if (command === "mfa" && second === "disable") {
    const token = requireHostedAuthToken(store);
    const code = args.positionals[2];
    if (!code) {
      throw new Error("Usage: thane mfa disable <code>");
    }
    const disabled = await postThaneApiWithAuth<{ enabled: boolean }>("/v1/thane-cli/mfa/disable", token, { code });
    wantsJson(args) ? printJson(disabled) : process.stdout.write("MFA disabled\n");
    return;
  }

  if (command === "ask-thane" && second === "status") {
    const token = requireHostedAuthToken(store);
    await syncHostedStore(store).catch(() => false);
    const workspaceId = store.activeWorkspace.id;
    const response = await getThaneApi<{ integration: ReturnType<ThaneStore["askThaneStatus"]> }>(
      `/v1/thane-cli/ask-thane/status?workspaceId=${encodeURIComponent(workspaceId)}`,
      token
    );
    const integration = response.integration ?? store.askThaneStatus();
    wantsJson(args)
      ? printJson({ integration })
      : process.stdout.write(
          integration?.enabled
            ? `Ask Thane enabled for team ${store.activeWorkspace.slug} as ${integration.linkedAccountEmail}\n`
            : `Ask Thane disabled for team ${store.activeWorkspace.slug}\n`
        );
    return;
  }

  if (command === "ask-thane" && second === "enable") {
    const token = requireHostedAuthToken(store);
    await syncHostedStore(store).catch(() => false);
    const response = await postThaneApiWithAuth<{ integration: Awaited<ReturnType<ThaneStore["enableAskThane"]>> }>(
      "/v1/thane-cli/ask-thane/enable",
      token,
      { workspaceId: store.activeWorkspace.id }
    );
    await syncHostedStore(store).catch(() => false);
    const integration = response.integration;
    wantsJson(args)
      ? printJson({ integration })
      : process.stdout.write("Ask Thane enabled. Mention @thane in any joined/readable conversation.\n");
    return;
  }

  if (command === "ask-thane" && second === "disable") {
    const token = requireHostedAuthToken(store);
    await syncHostedStore(store).catch(() => false);
    await postThaneApiWithAuth("/v1/thane-cli/ask-thane/disable", token, { workspaceId: store.activeWorkspace.id });
    await syncHostedStore(store).catch(() => false);
    process.stdout.write("Ask Thane disabled\n");
    return;
  }

  if (command === "webhooks" || command === "webhook") {
    const token = requireHostedAuthToken(store);
    await syncHostedStore(store).catch(() => false);
    const workspaceId = store.activeWorkspace.id;
    if (second === "list" || !second) {
      const response = await getThaneApi<{ webhooks: Array<Record<string, unknown>> }>(
        `/v1/thane-cli/webhooks?workspaceId=${encodeURIComponent(workspaceId)}`,
        token
      );
      wantsJson(args)
        ? printJson(response)
        : process.stdout.write(
            response.webhooks.length
              ? `${response.webhooks.map((webhook) => `${webhook.id} ${webhook.name} ${webhook.status} ${webhook.url}`).join("\n")}\n`
              : "no webhooks\n"
          );
      return;
    }
    if (second === "create") {
      const name = args.positionals[2];
      const url = args.positionals[3];
      if (!name || !url) {
        throw new Error("Usage: thane webhooks create <name> <https-url>");
      }
      const response = await postThaneApiWithAuth<{
        webhook: Record<string, unknown>;
        token: string;
        signingSecret: string;
        postMessageEndpoint: string;
        postReactionEndpoint?: string;
      }>("/v1/thane-cli/webhooks", token, {
        workspaceId,
        name,
        url,
        eventTypes: [flagString(args, "event") ?? "message.created"]
      });
      if (wantsJson(args)) {
        printJson(response);
      } else {
        process.stdout.write(
          `webhook created: ${response.webhook.id}\n` +
            `token: ${response.token}\n` +
            `signing secret: ${response.signingSecret}\n` +
            `post messages: ${response.postMessageEndpoint}\n` +
            (response.postReactionEndpoint ? `post reactions: ${response.postReactionEndpoint}\n` : "") +
            "These credentials are shown once. Store them in the external app.\n"
        );
      }
      return;
    }
    if (second === "disable") {
      const webhook = args.positionals[2];
      if (!webhook) {
        throw new Error("Usage: thane webhooks disable <id-or-name>");
      }
      const response = await postThaneApiWithAuth<{ webhook: Record<string, unknown> }>("/v1/thane-cli/webhooks/disable", token, {
        workspaceId,
        webhook
      });
      wantsJson(args) ? printJson(response) : process.stdout.write(`disabled webhook ${response.webhook.id}\n`);
      return;
    }
    throw new Error("Usage: thane webhooks <list|create|disable|docs>");
  }

  if (command === "notify" && second === "location") {
    const location = args.positionals[2];
    if (hasHostedChat(store)) {
      const token = requireHostedAuthToken(store);
      await syncHostedStore(store).catch(() => false);
      const workspaceId = store.activeWorkspace.id;
      if (!location) {
        const response = await getThaneApi<{ preference: NotificationPreference }>(
          `/v1/thane-cli/notify/location?workspaceId=${encodeURIComponent(workspaceId)}`,
          token
        );
        await store.applyNotificationPreference(response.preference);
        wantsJson(args)
          ? printJson({ preference: response.preference })
          : process.stdout.write(`ping location: ${response.preference.preferredPingLocation}\n`);
        return;
      }
      const response = await postThaneApiWithAuth<{ preference: NotificationPreference }>("/v1/thane-cli/notify/location", token, {
        workspaceId,
        preferredPingLocation: parsePingLocation(location)
      });
      await store.applyNotificationPreference(response.preference);
      wantsJson(args)
        ? printJson({ preference: response.preference })
        : process.stdout.write(`ping location set to ${response.preference.preferredPingLocation}\n`);
      return;
    }
    if (!location) {
      const preference = store.notificationPreference();
      wantsJson(args)
        ? printJson({ preference })
        : process.stdout.write(`ping location: ${preference.preferredPingLocation}\n`);
      return;
    }
    const preference = await store.setPingLocation(parsePingLocation(location));
    wantsJson(args)
      ? printJson({ preference })
      : process.stdout.write(`ping location set to ${preference.preferredPingLocation}\n`);
    return;
  }

  if (command === "billing" && second === "status") {
    await syncHostedStore(store).catch(() => false);
    const billing = store.billingSummary();
    wantsJson(args)
      ? printJson(billing)
      : process.stdout.write(
          `plan: ${billing.plan.planTier}\nstatus: ${billing.plan.status}\nmembers: ${billing.usage.members}/${billing.plan.planTier === "free" ? billing.limits.members : "unlimited"}\nprivate channels: ${billing.usage.privateChannels}/${billing.plan.planTier === "free" ? billing.limits.privateChannels : "unlimited"}\n`
        );
    return;
  }

  if (command === "billing" && second === "checkout") {
    await syncHostedStore(store).catch(() => false);
    const link = await createHostedBillingLink(store);
    wantsJson(args) ? printJson({ billing: link }) : process.stdout.write(`${link.checkoutUrl}\n`);
    return;
  }

  if (command === "billing" && (second === "portal" || second === "manage")) {
    await syncHostedStore(store).catch(() => false);
    const link = await createHostedBillingLink(store);
    wantsJson(args) ? printJson({ billing: link }) : process.stdout.write(`${link.portalUrl}\n`);
    return;
  }

  if (command === "billing" && second === "activate-team-dev") {
    if (process.env.THANE_ALLOW_DEV_BILLING_ACTIVATION !== "1") {
      throw new Error("Set THANE_ALLOW_DEV_BILLING_ACTIVATION=1 to use local billing activation.");
    }
    const plan = await store.setBillingPlan("cli_team", "active");
    wantsJson(args) ? printJson({ plan }) : process.stdout.write("activated local CLI Team plan\n");
    return;
  }

  if (command === "import" && second === "slack-export") {
    const zipPath = args.positionals[2];
    if (!zipPath) {
      throw new Error("Usage: thane import slack-export <export.zip> [--preview|--apply]");
    }
    const exportData = await parseSlackExportZip(zipPath);
    if (args.flags.has("apply")) {
      throw new Error("Slack import apply is not available until hosted import is wired up. Preview is still available without creating local data.");
    }
    const preview = store.previewSlackImport(exportData);
    wantsJson(args) ? printJson({ preview }) : process.stdout.write(renderSlackImportSummary(preview, "preview"));
    return;
  }

  const isTeamsCommand = command === "teams" || command === "workspaces";
  const isTeamCommand = command === "team" || command === "workspace";

  if (isTeamsCommand) {
    const workspaces = store.listWorkspaces();
    wantsJson(args)
      ? printJson({ activeWorkspace: store.activeWorkspace, workspaces })
      : process.stdout.write(`${renderWorkspaces(workspaces, store.activeWorkspace.id)}\n`);
    return;
  }

  if (isTeamCommand && second === "current") {
    wantsJson(args)
      ? printJson({ activeWorkspace: store.activeWorkspace })
      : process.stdout.write(`${store.activeWorkspace.slug} - ${store.activeWorkspace.name}\n`);
    return;
  }

  if (isTeamCommand && second === "create") {
    const nameInput = args.positionals.slice(2).join(" ").trim() || undefined;
    const flagName = flagString(args, "name");
    const explicitSlug = flagString(args, "slug") ?? (flagName && nameInput ? nameInput : undefined);
    const workspaceName = flagName ?? nameInput ?? explicitSlug;
    if (!workspaceName) {
      throw new Error("Usage: thane team create <name> [--slug <slug>]");
    }
    requireHostedAuthToken(store);
    await createHostedWorkspace(store, {
      workspaceId: hostedWorkspaceId(),
      name: workspaceName,
      ...(explicitSlug ? { slug: explicitSlug } : {})
    });
    store = await ThaneStore.open();
    const workspace = store.activeWorkspace;
    wantsJson(args) ? printJson({ workspace }) : process.stdout.write(`created team ${workspace.slug}\n`);
    return;
  }

  if (isTeamCommand && second === "use") {
    const slug = args.positionals[2];
    if (!slug) {
      throw new Error("Usage: thane team use <slug>");
    }
    const workspace = await store.useWorkspace(slug);
    await syncHosted({ workspaceId: workspace.id, silent: true });
    wantsJson(args) ? printJson({ activeWorkspace: workspace }) : process.stdout.write(`using team ${workspace.slug}\n`);
    return;
  }

  if (isTeamCommand && second === "leave") {
    requireHostedAuthToken(store);
    const leaving = store.activeWorkspace.slug;
    await leaveHostedWorkspace(store);
    wantsJson(args) ? printJson({ ok: true, workspace: leaving }) : process.stdout.write(`left team ${leaving}\n`);
    return;
  }

  if (isTeamCommand && second === "art") {
    const action = args.positionals[2] ?? "show";
    if (action === "show") {
      const art = store.activeWorkspace.asciiArt ?? null;
      wantsJson(args)
        ? printJson({ workspace: store.activeWorkspace, art, source: art ? "custom" : "generated" })
        : process.stdout.write(art ? `${art}\n` : "Using generated team art.\n");
      return;
    }
    if (action === "set") {
      const art = await readWorkspaceArtInput(args, 3);
      const workspace = await store.setWorkspaceAsciiArt(art);
      if (hasHostedChat(store)) {
        await ensureHostedWorkspace(store);
      }
      wantsJson(args)
        ? printJson({ workspace, art: workspace.asciiArt, source: "custom" })
        : process.stdout.write(`updated team art for ${workspace.slug}\n`);
      return;
    }
    if (action === "reset" || action === "clear") {
      const workspace = await store.clearWorkspaceAsciiArt();
      if (hasHostedChat(store)) {
        await ensureHostedWorkspace(store);
      }
      wantsJson(args)
        ? printJson({ workspace, art: null, source: "generated" })
        : process.stdout.write(`reset team art for ${workspace.slug}\n`);
      return;
    }
    throw new Error("Usage: thane team art <show|set|reset>");
  }

  if (isTeamCommand && second === "create-from-slack") {
    const zipPath = args.positionals[2];
    if (!zipPath) {
      throw new Error("Usage: thane team create-from-slack <export.zip> [--slug <slug>] [--name \"...\"] [--apply]");
    }
    const exportData = await parseSlackExportZip(zipPath);
    const slug = flagString(args, "slug") ?? slugFromSlackExportPath(zipPath);
    const name = flagString(args, "name") ?? slug.replace(/[-_]+/g, " ");
    if (!args.flags.has("apply")) {
      const preview = store.previewSlackImport(exportData);
      const response = { proposedWorkspace: { slug, name }, preview };
      wantsJson(args)
        ? printJson(response)
        : process.stdout.write(
            `Proposed team: ${slug} - ${name}\n${renderSlackImportSummary(preview, "preview")}`
          );
      return;
    }
    throw new Error("Slack import apply is not available until hosted import is wired up. Preview is still available without creating local data.");
    return;
  }

  if (command === "channels") {
    const channels = store.listChannels();
    wantsJson(args) ? printJson({ channels }) : process.stdout.write(`${renderChannels(channels)}\n`);
    return;
  }

  if (command === "users") {
    const users = store.listUsers();
    wantsJson(args) ? printJson({ users }) : process.stdout.write(`${renderUsers(users)}\n`);
    return;
  }

  if (command === "members") {
    const members = store.listMembers();
    wantsJson(args) ? printJson({ members }) : process.stdout.write(`${renderMembers(members)}\n`);
    return;
  }

  if (command === "member" && (second === "remove" || second === "kick")) {
    const target = args.positionals[2];
    if (!target) {
      throw new Error(`Usage: thane member ${second} <handle-or-email>`);
    }
    requireHostedAuthToken(store);
    await removeHostedWorkspaceMember(store, { target });
    wantsJson(args) ? printJson({ ok: true, target }) : process.stdout.write(`removed ${target} from team ${store.activeWorkspace.slug}\n`);
    return;
  }

  if (command === "member" && second === "ban") {
    const target = args.positionals[2];
    if (!target) {
      throw new Error("Usage: thane member ban <handle-or-email> [--reason \"...\"]");
    }
    requireHostedAuthToken(store);
    const reason = flagString(args, "reason");
    await banHostedWorkspaceMember(store, { target, ...(reason ? { reason } : {}) });
    wantsJson(args) ? printJson({ ok: true, target, banned: true }) : process.stdout.write(`banned ${target} from team ${store.activeWorkspace.slug}\n`);
    return;
  }

  if (command === "member" && second === "unban") {
    const email = args.positionals[2];
    if (!email) {
      throw new Error("Usage: thane member unban <email>");
    }
    requireHostedAuthToken(store);
    await unbanHostedWorkspaceMember(store, { email });
    wantsJson(args) ? printJson({ ok: true, email, unbanned: true }) : process.stdout.write(`unbanned ${email} in team ${store.activeWorkspace.slug}\n`);
    return;
  }

  if (command === "invite") {
    const email = second;
    if (!email) {
      throw new Error("Usage: thane invite <email>");
    }
    const role = flagMemberRole(args, "member");
    store.requireWorkspaceAdmin();
    const token = requireHostedAuthToken(store);
    const response = await postThaneApiWithAuth<{
      invite: {
        url: string;
        webUrl?: string;
        token: string;
        workspace: { id: string; slug: string; name: string };
        role: "admin" | "member";
        expiresAt: string;
        maxUses?: number | null;
        inviteeEmail?: string;
        emailSent?: boolean;
      };
    }>("/v1/thane-cli/workspace-invites", token, {
      workspaceId: store.activeWorkspace.id,
      workspaceSlug: store.activeWorkspace.slug,
      workspaceName: store.activeWorkspace.name,
      inviteeEmail: email,
      role,
      expiresInHours: parseExpiresInHours(flagString(args, "expires")),
      maxUses: 1
    });
    wantsJson(args)
      ? printJson(response)
      : process.stdout.write(
          `sent invite to ${email} for team ${response.invite.workspace.slug}\n` +
            `web link: ${response.invite.webUrl ?? response.invite.url}\n` +
            `cli link: ${response.invite.url}\n` +
            `role: ${response.invite.role}\n` +
            `expires: ${response.invite.expiresAt}\n`
        );
    return;
  }

  if (command === "invite-link" && second === "create") {
    store.requireWorkspaceAdmin();
    const token = requireHostedAuthToken(store);
    const role = flagMemberRole(args, "member");
    const expiresInHours = parseExpiresInHours(flagString(args, "expires"));
    const maxUsesRaw = flagString(args, "max-uses");
    const parsedMaxUses = maxUsesRaw ? Number(maxUsesRaw) : undefined;
    if (parsedMaxUses !== undefined && (!Number.isFinite(parsedMaxUses) || parsedMaxUses <= 0)) {
      throw new Error("--max-uses must be a positive number.");
    }
    const maxUses = parsedMaxUses ? Math.floor(parsedMaxUses) : undefined;
    const response = await postThaneApiWithAuth<{
      invite: {
        url: string;
        webUrl?: string;
        token: string;
        workspace: { id: string; slug: string; name: string };
        role: "admin" | "member";
        expiresAt: string;
        maxUses?: number | null;
      };
    }>("/v1/thane-cli/workspace-invites", token, {
      workspaceId: store.activeWorkspace.id,
      workspaceSlug: store.activeWorkspace.slug,
      workspaceName: store.activeWorkspace.name,
      role,
      expiresInHours,
      ...(maxUses ? { maxUses } : {})
    });
    wantsJson(args)
      ? printJson(response)
      : process.stdout.write(
          `invite link for team ${response.invite.workspace.slug}\n` +
            `web link: ${response.invite.webUrl ?? response.invite.url}\n` +
            `cli link: ${response.invite.url}\n` +
            `role: ${response.invite.role}\n` +
            `expires: ${response.invite.expiresAt}\n`
        );
    return;
  }

  if (command === "invite-link" && second === "accept") {
    const linkOrToken = args.positionals[2];
    if (!linkOrToken) {
      throw new Error("Usage: thane invite-link accept <link-or-token>");
    }
    const token = requireHostedAuthToken(store);
    const response = await postThaneApiWithAuth<{
      workspace: { id: string; slug: string; name: string; role: "admin" | "member"; expiresAt: string };
    }>("/v1/thane-cli/workspace-invites/accept", token, { token: linkOrToken });
    const joined = await store.joinWorkspaceFromInvite({
      id: response.workspace.id,
      slug: response.workspace.slug,
      name: response.workspace.name,
      role: response.workspace.role
    });
    wantsJson(args)
      ? printJson({ workspace: joined.workspace, member: joined.member })
      : process.stdout.write(`joined ${joined.workspace.slug} as ${joined.member.role}\nopen chat: thane chat general\n`);
    return;
  }

  if (command === "member" && second === "role") {
    const target = args.positionals[2];
    const role = args.positionals[3];
    if (!target || !role) {
      throw new Error("Usage: thane member role <handle-or-email> <admin|member>");
    }
    if (role !== "admin" && role !== "member") {
      throw new Error("Role must be admin or member.");
    }
    requireHostedAuthToken(store);
    await setHostedWorkspaceMemberRole(store, { target, role });
    wantsJson(args) ? printJson({ ok: true, target, role }) : process.stdout.write(`set ${target} role to ${role}\n`);
    return;
  }

  if (command === "user" && second === "add") {
    const handle = args.positionals[2];
    if (!handle) {
      throw new Error("Usage: thane user add <handle>");
    }
    throw new Error("Local-only users are no longer supported. Invite a real account with `thane invite <email>`.");
    return;
  }

  if (command === "dms") {
    const dms = store.listDms();
    wantsJson(args) ? printJson({ dms }) : process.stdout.write(`${renderDms(dms)}\n`);
    return;
  }

  if (command === "inbox") {
    const conversations = store.inbox({
      allWorkspaces: args.flags.has("all-teams") || args.flags.has("all-workspaces"),
      onlyUnread: !args.flags.has("include-quiet"),
      includeQuiet: args.flags.has("include-quiet")
    });
    wantsJson(args) ? printJson({ conversations }) : process.stdout.write(`${renderInbox(conversations)}\n`);
    return;
  }

  if (command === "channel" && second === "create") {
    const name = args.positionals[2];
    if (!name) {
      throw new Error("Usage: thane channel create <name>");
    }
    const topic = flagString(args, "topic");
    requireHostedAuthToken(store);
    await createHostedChannel(store, { name, ...(topic ? { topic } : {}), private: args.flags.has("private") });
    store = await ThaneStore.open();
    const channel = store.findChannel(name);
    if (!channel) {
      throw new Error(`Hosted channel ${name} was created but did not sync back.`);
    }
    wantsJson(args) ? printJson({ channel }) : process.stdout.write(`created #${channel.name}\n`);
    return;
  }

  if (command === "channel" && second === "invite") {
    const channelName = args.positionals[2];
    const target = args.positionals[3];
    if (!channelName || !target) {
      throw new Error("Usage: thane channel invite <channel> <handle-or-email>");
    }
    requireHostedAuthToken(store);
    await addHostedChannelMember(store, { channelName, target });
    wantsJson(args) ? printJson({ ok: true, channel: channelName, target }) : process.stdout.write(`invited ${target} to #${channelName}\n`);
    return;
  }

  if (command === "channel" && second === "join") {
    const channelName = args.positionals[2];
    if (!channelName) {
      throw new Error("Usage: thane channel join <channel>");
    }
    requireHostedAuthToken(store);
    await joinHostedChannel(store, { channelName });
    wantsJson(args) ? printJson({ ok: true, channel: channelName }) : process.stdout.write(`joined #${channelName}\n`);
    return;
  }

  if (command === "channel" && second === "leave") {
    const channelName = args.positionals[2];
    if (!channelName) {
      throw new Error("Usage: thane channel leave <channel>");
    }
    requireHostedAuthToken(store);
    await leaveHostedChannel(store, { channelName });
    wantsJson(args) ? printJson({ ok: true, channel: channelName }) : process.stdout.write(`left #${channelName}\n`);
    return;
  }

  if (command === "channel" && (second === "remove" || second === "kick")) {
    const channelName = args.positionals[2];
    const target = args.positionals[3];
    if (!channelName || !target) {
      throw new Error(`Usage: thane channel ${second} <channel> <handle-or-email>`);
    }
    requireHostedAuthToken(store);
    await removeHostedChannelMember(store, { channelName, target });
    wantsJson(args) ? printJson({ ok: true, channel: channelName, target }) : process.stdout.write(`removed ${target} from #${channelName}\n`);
    return;
  }

  if (command === "channel" && second === "members") {
    const channelName = args.positionals[2];
    if (!channelName) {
      throw new Error("Usage: thane channel members <channel>");
    }
    const users = store.channelMembers(channelName);
    wantsJson(args) ? printJson({ users }) : process.stdout.write(`${renderUsers(users)}\n`);
    return;
  }

  if (command === "send") {
    const channel = second;
    const text = readMessageText(args, 2);
    if (!channel || !text) {
      throw new Error("Usage: thane send <channel> <message>");
    }
    requireHostedAuthToken(store);
    const target = store.findChannel(channel);
    if (!target) {
      throw new Error(`Channel ${channel} was not found.`);
    }
    await sendHostedMessage(store, { channelId: target.id, text, source: "terminal" });
    store = await ThaneStore.open();
    const outputMessage = store.recent(target.id, 1).at(-1);
    if (!outputMessage) {
      throw new Error("Message was sent but did not sync back.");
    }
    wantsJson(args) ? printJson({ message: outputMessage }) : process.stdout.write(`sent ${outputMessage.id} to #${store.findChannel(channel)?.name ?? channel}\n`);
    return;
  }

  if (command === "dm-send") {
    const handle = second;
    const text = readMessageText(args, 2);
    if (!handle || !text) {
      throw new Error("Usage: thane dm-send <handle> <message>");
    }
    throw new Error("DM sending from the CLI requires hosted DM support and is not available yet.");
    return;
  }

  if ((command === "dm-recent" || command === "dm") && second) {
    await syncBeforeRead();
    const messages = store.recentDm(second, flagNumber(args, "limit", 20), parseSince(flagString(args, "since")));
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "recent" || command === "see-recent") {
    await syncBeforeRead();
    const limit = flagNumber(args, "limit", command === "see-recent" ? 50 : 20);
    const since = parseSince(flagString(args, "since"));
    const channel = second && !second.startsWith("--") ? second : undefined;
    const messages = store.recent(channel, limit, since);
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "unread") {
    await syncBeforeRead();
    const messages = store.unread(flagNumber(args, "limit", 50));
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "mentions") {
    await syncBeforeRead();
    const messages = store.mentions(flagNumber(args, "limit", 20), parseSince(flagString(args, "since")));
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "search") {
    const query = args.positionals.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Usage: thane search <query>");
    }
    await syncBeforeRead();
    const messages = store.search(query, flagNumber(args, "limit", 20));
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "thread") {
    if (!second) {
      throw new Error("Usage: thane thread <message-id>");
    }
    await syncBeforeRead();
    const messages = store.thread(second);
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "reply") {
    const text = readMessageText(args, 2);
    if (!second || !text) {
      throw new Error("Usage: thane reply <message-id> <message>");
    }
    requireHostedAuthToken(store);
    const root = store.thread(second)[0];
    if (!root) {
      throw new Error(`Message ${second} was not found.`);
    }
    const target = store.findChannel(root.channel);
    if (!target) {
      throw new Error(`Channel ${root.channel} was not found.`);
    }
    await sendHostedMessage(store, { channelId: target.id, text, source: "terminal", threadRootId: root.threadRootId ?? root.id });
    store = await ThaneStore.open();
    const outputMessage = store.thread(second).at(-1);
    if (!outputMessage) {
      throw new Error("Reply was sent but did not sync back.");
    }
    wantsJson(args) ? printJson({ message: outputMessage }) : process.stdout.write(`sent ${outputMessage.id} in thread ${outputMessage.threadRootId ?? second}\n`);
    return;
  }

  if (command === "react") {
    const emoji = args.positionals[2];
    if (!second || !emoji) {
      throw new Error("Usage: thane react <message-id> <emoji>");
    }
    requireHostedAuthToken(store);
    await reactHostedMessage(store, { messageId: second, emoji });
    store = await ThaneStore.open();
    const outputMessage = store.thread(second)[0];
    if (!outputMessage) {
      throw new Error("Reaction was saved but the message did not sync back.");
    }
    wantsJson(args) ? printJson({ message: outputMessage }) : process.stdout.write(`reacted to ${second}\n`);
    return;
  }

  if (command === "mark-read") {
    if (!second) {
      throw new Error("Usage: thane mark-read <channel>");
    }
    const state = await store.markRead(second);
    wantsJson(args) ? printJson({ readState: state }) : process.stdout.write(`marked #${second} read\n`);
    return;
  }

  throw new Error(`Unknown command "${command}". Run "thane help".`);
}

main().catch((error) => {
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: (error as Error).message })}\n`);
  } else {
    process.stderr.write(`${(error as Error).message}\n`);
  }
  process.exitCode = 1;
});
