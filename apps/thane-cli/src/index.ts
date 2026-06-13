#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { runChat } from "./chat.js";
import { cliCommands, renderCliCommands } from "./commands.js";
import { renderChannels, renderDms, renderInbox, renderMembers, renderMessages, printJson, renderUsers, renderWorkspaces } from "./render.js";
import { parseSlackExportZip } from "./slack-import.js";
import { ThaneStore } from "./store.js";
import { parseSince } from "./time.js";
import type { SlackImportPreview } from "./slack-import.js";
import type { SlackImportResult } from "./store.js";
import type { PingLocation, WorkspaceRole } from "./model.js";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
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

function slugFromSlackExportPath(path: string): string {
  const base = basename(path).replace(/\.zip$/i, "").replace(/slack[-_ ]?export/gi, "slack").replace(/[^a-z0-9._-]+/gi, "-");
  return base.toLowerCase().replace(/^-+|-+$/g, "") || "slack-import";
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
  return `Thane CLI MVP

Command discovery:
  thane commands [--json]
  thane help

Interactive:
  thane chat [channel]
  thane dm <handle>

Accounts:
  thane signup <email> [--name "..."]
  thane login <email>
  thane verify <email> <code>
  thane whoami [--json]
  thane logout

Ask Thane:
  thane ask-thane status [--json]
  thane ask-thane enable [--json]
  thane ask-thane disable

Notifications:
  thane notify location [--json]
  thane notify location <origin|thane_cli|slack|both> [--json]

Billing:
  thane billing status [--json]
  thane billing checkout
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
  thane channel members <channel> [--json]

Members, users, and DMs:
  thane members [--json]
  thane invite <email> [--role admin|member] [--handle "..."]
  thane member role <handle-or-email> <admin|member>
  thane users [--json]
  thane user add <handle> [--name "..."]
  thane dms [--json]
  thane dm <handle>
  thane dm-recent <handle> [--limit 20] [--json]
  thane dm-send <handle> <message>
  thane dm-send <handle> --stdin

Workspaces:
  thane workspaces [--json]
  thane workspace current [--json]
  thane workspace create <slug> [--name "..."]
  thane workspace use <slug>
  thane workspace create-from-slack <export.zip> [--slug "..."] [--name "..."] [--apply] [--json]

Messages:
  thane inbox [--all-workspaces] [--json]
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

All channels, messages, mentions, unread state, and search results are scoped to the active workspace.`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, second] = args.positionals;

  if (command === "dm" && second && !wantsJson(args)) {
    await runChat(`@${second}`);
    return;
  }

  if (!command || command === "chat") {
    await runChat(command === "chat" ? second : command);
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

  const store = await ThaneStore.open();

  if (command === "signup") {
    const email = second;
    if (!email) {
      throw new Error("Usage: thane signup <email>");
    }
    const { account, code } = await store.signup(email, flagString(args, "name"));
    wantsJson(args)
      ? printJson({ account, verificationCode: code })
      : process.stdout.write(`created account ${account.email}\nverification code: ${code}\n`);
    return;
  }

  if (command === "login") {
    const email = second;
    if (!email) {
      throw new Error("Usage: thane login <email>");
    }
    const { account, code } = await store.login(email);
    wantsJson(args)
      ? printJson({ account, verificationCode: code })
      : process.stdout.write(`${account ? `login code for ${account.email}` : `account will be created for ${email}`}\nverification code: ${code}\n`);
    return;
  }

  if (command === "verify") {
    const email = second;
    const code = args.positionals[2];
    if (!email || !code) {
      throw new Error("Usage: thane verify <email> <code>");
    }
    const account = await store.verify(email, code);
    wantsJson(args) ? printJson({ account }) : process.stdout.write(`signed in as ${account.email}\n`);
    return;
  }

  if (command === "whoami") {
    const account = store.currentAccount;
    const user = store.currentUser;
    const member = store.currentMember();
    wantsJson(args)
      ? printJson({ account, user, workspace: store.activeWorkspace, member })
      : process.stdout.write(`${account?.email ?? "not signed in"} as @${user.handle} (${member?.role ?? "member"}) in ${store.activeWorkspace.slug}\n`);
    return;
  }

  if (command === "logout") {
    await store.logout();
    process.stdout.write("signed out\n");
    return;
  }

  if (command === "ask-thane" && second === "status") {
    const integration = store.askThaneStatus();
    wantsJson(args)
      ? printJson({ integration })
      : process.stdout.write(
          integration?.enabled
            ? `Ask Thane enabled for ${store.activeWorkspace.slug} as ${integration.linkedAccountEmail}\n`
            : `Ask Thane disabled for ${store.activeWorkspace.slug}\n`
        );
    return;
  }

  if (command === "ask-thane" && second === "enable") {
    const integration = await store.enableAskThane();
    wantsJson(args)
      ? printJson({ integration })
      : process.stdout.write(`Ask Thane enabled. Mention @thane in any joined/readable conversation.\n`);
    return;
  }

  if (command === "ask-thane" && second === "disable") {
    await store.disableAskThane();
    process.stdout.write("Ask Thane disabled\n");
    return;
  }

  if (command === "notify" && second === "location") {
    const location = args.positionals[2];
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
    const billing = store.billingSummary();
    wantsJson(args)
      ? printJson(billing)
      : process.stdout.write(
          `plan: ${billing.plan.planTier}\nstatus: ${billing.plan.status}\nmembers: ${billing.usage.members}/${billing.plan.planTier === "free" ? billing.limits.members : "unlimited"}\nprivate channels: ${billing.usage.privateChannels}/${billing.plan.planTier === "free" ? billing.limits.privateChannels : "unlimited"}\n`
        );
    return;
  }

  if (command === "billing" && second === "checkout") {
    const checkoutOptions: { paymentsBaseUrl?: string; signingSecret?: string; email?: string } = {};
    if (process.env.THANE_PAYMENTS_BASE_URL) {
      checkoutOptions.paymentsBaseUrl = process.env.THANE_PAYMENTS_BASE_URL;
    }
    if (process.env.THANE_BILLING_LINK_SIGNING_SECRET) {
      checkoutOptions.signingSecret = process.env.THANE_BILLING_LINK_SIGNING_SECRET;
    }
    if (store.currentAccount?.email) {
      checkoutOptions.email = store.currentAccount.email;
    }
    const checkoutUrl = store.createBillingCheckoutUrl(checkoutOptions);
    process.stdout.write(`${checkoutUrl}\n`);
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
      const result = await store.importSlackExport(exportData);
      wantsJson(args) ? printJson({ result }) : process.stdout.write(renderSlackImportSummary(result, "apply"));
      return;
    }
    const preview = store.previewSlackImport(exportData);
    wantsJson(args) ? printJson({ preview }) : process.stdout.write(renderSlackImportSummary(preview, "preview"));
    return;
  }

  if (command === "workspaces") {
    const workspaces = store.listWorkspaces();
    wantsJson(args)
      ? printJson({ activeWorkspace: store.activeWorkspace, workspaces })
      : process.stdout.write(`${renderWorkspaces(workspaces, store.activeWorkspace.id)}\n`);
    return;
  }

  if (command === "workspace" && second === "current") {
    wantsJson(args)
      ? printJson({ activeWorkspace: store.activeWorkspace })
      : process.stdout.write(`${store.activeWorkspace.slug} - ${store.activeWorkspace.name}\n`);
    return;
  }

  if (command === "workspace" && second === "create") {
    const slug = args.positionals[2];
    if (!slug) {
      throw new Error("Usage: thane workspace create <slug>");
    }
    const workspace = await store.createWorkspace(slug, flagString(args, "name"));
    wantsJson(args) ? printJson({ workspace }) : process.stdout.write(`created workspace ${workspace.slug}\n`);
    return;
  }

  if (command === "workspace" && second === "use") {
    const slug = args.positionals[2];
    if (!slug) {
      throw new Error("Usage: thane workspace use <slug>");
    }
    const workspace = await store.useWorkspace(slug);
    wantsJson(args) ? printJson({ activeWorkspace: workspace }) : process.stdout.write(`using workspace ${workspace.slug}\n`);
    return;
  }

  if (command === "workspace" && second === "create-from-slack") {
    const zipPath = args.positionals[2];
    if (!zipPath) {
      throw new Error("Usage: thane workspace create-from-slack <export.zip> [--slug <slug>] [--name \"...\"] [--apply]");
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
            `Proposed workspace: ${slug} - ${name}\n${renderSlackImportSummary(preview, "preview")}`
          );
      return;
    }
    const workspace = await store.createWorkspace(slug, name);
    await store.useWorkspace(workspace.slug);
    const result = await store.importSlackExport(exportData);
    wantsJson(args)
      ? printJson({ workspace, result })
      : process.stdout.write(`created workspace ${workspace.slug}\n${renderSlackImportSummary(result, "apply")}`);
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

  if (command === "invite") {
    const email = second;
    if (!email) {
      throw new Error("Usage: thane invite <email>");
    }
    const member = await store.invite(email, flagRole(args, "member"), flagString(args, "handle"));
    wantsJson(args) ? printJson({ member }) : process.stdout.write(`invited ${email} as ${member.role}\n`);
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
    const member = await store.setMemberRole(target, role);
    wantsJson(args) ? printJson({ member }) : process.stdout.write(`updated ${target} to ${role}\n`);
    return;
  }

  if (command === "user" && second === "add") {
    const handle = args.positionals[2];
    if (!handle) {
      throw new Error("Usage: thane user add <handle>");
    }
    const user = await store.addUser(handle, flagString(args, "name"));
    wantsJson(args) ? printJson({ user }) : process.stdout.write(`added @${user.handle}\n`);
    return;
  }

  if (command === "dms") {
    const dms = store.listDms();
    wantsJson(args) ? printJson({ dms }) : process.stdout.write(`${renderDms(dms)}\n`);
    return;
  }

  if (command === "inbox") {
    const conversations = store.inbox({
      allWorkspaces: args.flags.has("all-workspaces"),
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
    const channel = await store.createChannel(name, flagString(args, "topic"), args.flags.has("private") ? "private" : "public");
    wantsJson(args) ? printJson({ channel }) : process.stdout.write(`created #${channel.name}\n`);
    return;
  }

  if (command === "channel" && second === "invite") {
    const channelName = args.positionals[2];
    const target = args.positionals[3];
    if (!channelName || !target) {
      throw new Error("Usage: thane channel invite <channel> <handle-or-email>");
    }
    const channel = await store.inviteToChannel(channelName, target);
    wantsJson(args) ? printJson({ channel }) : process.stdout.write(`added ${target} to #${channel.name}\n`);
    return;
  }

  if (command === "channel" && second === "join") {
    const channelName = args.positionals[2];
    if (!channelName) {
      throw new Error("Usage: thane channel join <channel>");
    }
    const channel = await store.joinChannel(channelName);
    wantsJson(args) ? printJson({ channel }) : process.stdout.write(`joined #${channel.name}\n`);
    return;
  }

  if (command === "channel" && second === "leave") {
    const channelName = args.positionals[2];
    if (!channelName) {
      throw new Error("Usage: thane channel leave <channel>");
    }
    const channel = await store.leaveChannel(channelName);
    wantsJson(args) ? printJson({ channel }) : process.stdout.write(`left #${channel.name}\n`);
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
    const message = await store.sendMessage(channel, text);
    wantsJson(args) ? printJson({ message }) : process.stdout.write(`sent ${message.id} to #${store.findChannel(channel)?.name ?? channel}\n`);
    return;
  }

  if (command === "dm-send") {
    const handle = second;
    const text = readMessageText(args, 2);
    if (!handle || !text) {
      throw new Error("Usage: thane dm-send <handle> <message>");
    }
    const message = await store.sendDm(handle, text);
    wantsJson(args) ? printJson({ message }) : process.stdout.write(`sent ${message.id} to @${handle.replace(/^@/, "")}\n`);
    return;
  }

  if ((command === "dm-recent" || command === "dm") && second) {
    const messages = store.recentDm(second, flagNumber(args, "limit", 20), parseSince(flagString(args, "since")));
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "recent" || command === "see-recent") {
    const limit = flagNumber(args, "limit", command === "see-recent" ? 50 : 20);
    const since = parseSince(flagString(args, "since"));
    const channel = second && !second.startsWith("--") ? second : undefined;
    const messages = store.recent(channel, limit, since);
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "unread") {
    const messages = store.unread(flagNumber(args, "limit", 50));
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "mentions") {
    const messages = store.mentions(flagNumber(args, "limit", 20), parseSince(flagString(args, "since")));
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "search") {
    const query = args.positionals.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Usage: thane search <query>");
    }
    const messages = store.search(query, flagNumber(args, "limit", 20));
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "thread") {
    if (!second) {
      throw new Error("Usage: thane thread <message-id>");
    }
    const messages = store.thread(second);
    wantsJson(args) ? printJson({ messages }) : process.stdout.write(`${renderMessages(messages)}\n`);
    return;
  }

  if (command === "reply") {
    const text = readMessageText(args, 2);
    if (!second || !text) {
      throw new Error("Usage: thane reply <message-id> <message>");
    }
    const message = await store.reply(second, text);
    wantsJson(args) ? printJson({ message }) : process.stdout.write(`sent ${message.id} in thread ${message.threadRootId}\n`);
    return;
  }

  if (command === "react") {
    const emoji = args.positionals[2];
    if (!second || !emoji) {
      throw new Error("Usage: thane react <message-id> <emoji>");
    }
    const message = await store.react(second, emoji);
    wantsJson(args) ? printJson({ message }) : process.stdout.write(`reacted to ${second}\n`);
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
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
