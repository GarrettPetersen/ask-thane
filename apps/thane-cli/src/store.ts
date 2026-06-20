import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  AskThaneIntegration,
  ChannelVisibility,
  ConversationSummary,
  MessageView,
  NotificationPreference,
  PendingLogin,
  PingLocation,
  ThaneAccount,
  ThaneChannel,
  ThaneCliPlanTier,
  ThaneMessage,
  ThaneReadState,
  ThaneStoreData,
  ThaneUser,
  ThaneWorkspace,
  ThaneWorkspaceMember,
  WorkspaceBillingPlan,
  WorkspaceRole
} from "./model.js";
import type { ParsedSlackConversation, ParsedSlackExport, SlackExportMessage, SlackImportPreview } from "./slack-import.js";
import { previewSlackExport } from "./slack-import.js";

const defaultStorePath = join(homedir(), ".thane", "store.json");
const reservedHandles = new Set(["thane"]);

export function resolveStorePath(): string {
  if (process.env.THANE_STORE_PATH) {
    return process.env.THANE_STORE_PATH;
  }
  if (process.env.THANE_HOME) {
    return join(process.env.THANE_HOME, "store.json");
  }
  return defaultStorePath;
}

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function handleFromAccountId(accountId: string): string {
  return `user-${accountId.replace(/^acct_/, "").replace(/[^a-z0-9]+/gi, "").slice(0, 8).toLowerCase() || "member"}`;
}

function handleSeedFromDisplayName(displayName: string | undefined): string | undefined {
  const token = displayName
    ?.toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((candidate) => !["mr", "mrs", "ms", "dr", "phd"].includes(candidate))
    .find((candidate) => candidate.length >= 2);
  return token ? normalizeHandle(token) : undefined;
}

function handleSeedForAccount(account: ThaneAccount): string {
  return handleSeedFromDisplayName(account.displayName) || handleFromAccountId(account.id);
}

function uniqueWorkspaceHandle(
  users: ThaneUser[],
  workspaceId: string,
  desiredHandle: string,
  excludeUserId?: string
): string {
  const desired = normalizeHandle(desiredHandle) || "member";
  const seed = reservedHandles.has(desired) ? `${desired}-user` : desired;
  const taken = new Set(
    users
      .filter((user) => user.workspaceId === workspaceId && user.id !== excludeUserId)
      .map((user) => normalizeHandle(user.handle))
      .filter(Boolean)
  );
  for (const handle of reservedHandles) {
    taken.add(handle);
  }
  if (!taken.has(seed)) {
    return seed;
  }
  const base = seed.slice(0, 28).replace(/[-._]+$/g, "") || "member";
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, 32);
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 32);
}

function isGeneratedAccountHandle(handle: string | undefined, accountId: string | undefined): boolean {
  if (!accountId || !handle) {
    return false;
  }
  const normalized = normalizeHandle(handle);
  return normalized === handleFromAccountId(accountId) || /^user-[a-z0-9]{1,8}$/.test(normalized);
}

function displayNameFromAccountId(accountId: string): string {
  const suffix = accountId.replace(/^acct_/, "").replace(/[^a-z0-9]+/gi, "").slice(0, 6).toUpperCase();
  return suffix ? `Member ${suffix}` : "Member";
}

function userDisplayLabel(user: ThaneUser | undefined, fallback: string): string {
  if (!user) {
    return fallback;
  }
  return user.displayName.trim() || `@${user.handle}`;
}

function workspaceJoinMessageId(memberId: string): string {
  return `evt_join_${memberId}`;
}

function workspaceJoinMessageText(user: ThaneUser | undefined): string {
  return `${userDisplayLabel(user, "A member")} joined the team.`;
}

function makeLoginCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export const THANE_CLI_FREE_LIMITS = {
  members: 100,
  privateChannels: 10,
  historyDays: 90
} as const;

export const THANE_CLI_TEAM_PRICE = {
  monthlyPerMemberUsd: 8,
  history: "unlimited",
  privateChannels: "unlimited"
} as const;

export interface SlackImportResult extends SlackImportPreview {
  importedUsers: number;
  importedChannels: number;
  importedMessages: number;
  skippedDuplicateMessages: number;
}

function defaultData(): ThaneStoreData {
  return {
    accounts: [],
    workspaceMembers: [],
    askThaneIntegrations: [],
    notificationPreferences: [],
    billingPlans: [],
    pendingLogins: [],
    activeWorkspaceId: "",
    workspaces: [],
    currentUserId: "",
    users: [],
    channels: [],
    messages: [],
    readStates: []
  };
}

function normalizeWorkspaceSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeWorkspaceAsciiArt(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const trimmed = lines
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();
  if (!trimmed) {
    throw new Error("Workspace ASCII art cannot be empty.");
  }
  const normalizedLines = trimmed.split("\n");
  if (normalizedLines.length > 10) {
    throw new Error("Workspace ASCII art can be at most 10 lines.");
  }
  if (normalizedLines.some((line) => line.length > 30)) {
    throw new Error("Workspace ASCII art lines can be at most 30 characters.");
  }
  return normalizedLines.join("\n");
}

function migrateData(
  rawData: ThaneStoreData &
    Partial<{
      currentAccountId: string;
      accounts: ThaneAccount[];
      workspaceMembers: ThaneWorkspaceMember[];
      askThaneIntegrations: AskThaneIntegration[];
      notificationPreferences: NotificationPreference[];
      billingPlans: WorkspaceBillingPlan[];
      pendingLogins: PendingLogin[];
      workspaces: ThaneWorkspace[];
      activeWorkspaceId: string;
    }>
): ThaneStoreData {
  const localAccountIds = new Set(rawData.accounts?.filter((account) => account.id === "acct_local" || account.email === "you@example.local").map((account) => account.id) ?? []);
  const localWorkspaceIds = new Set(
    rawData.workspaces
      ?.filter((workspace) => workspace.id === "wsp_local" || workspace.slug === "local")
      .map((workspace) => workspace.id) ?? []
  );
  const keepWorkspace = (workspaceId: string | undefined): workspaceId is string => Boolean(workspaceId && !localWorkspaceIds.has(workspaceId));
  const keepAccount = (accountId: string | undefined): accountId is string => Boolean(accountId && !localAccountIds.has(accountId));

  if (rawData.workspaces?.length && rawData.activeWorkspaceId) {
    const createdAt = nowIso();
    const accounts = (rawData.accounts ?? []).filter((account) => keepAccount(account.id));
    const currentAccountId = keepAccount(rawData.currentAccountId) ? rawData.currentAccountId : accounts[0]?.id;
    const workspaces = rawData.workspaces.filter((workspace) => keepWorkspace(workspace.id));
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    const users = rawData.users
      .filter((user) => workspaceIds.has(user.workspaceId) && keepAccount(user.accountId))
      .map((user) => ({
        ...user,
        accountId: user.accountId ?? undefined,
        email: user.email ?? undefined
      }));
    const workspaceMembers =
      rawData.workspaceMembers?.length
        ? rawData.workspaceMembers.filter((member) => workspaceIds.has(member.workspaceId) && keepAccount(member.accountId))
        : users
            .filter((user) => user.accountId)
            .map((user) => ({
              id: id("mbr"),
              workspaceId: user.workspaceId,
              accountId: user.accountId!,
              userId: user.id,
              role: user.handle === "you" ? "owner" : "member",
              joinedAt: createdAt
            }));
    const activeWorkspaceId = keepWorkspace(rawData.activeWorkspaceId)
      ? rawData.activeWorkspaceId
      : workspaces[0]?.id ?? "";
    const currentUserId = users.some((user) => user.id === rawData.currentUserId) ? rawData.currentUserId : users[0]?.id ?? "";
    return {
      ...rawData,
      currentAccountId,
      accounts,
      workspaceMembers,
      askThaneIntegrations: rawData.askThaneIntegrations ?? [],
      notificationPreferences: rawData.notificationPreferences ?? [],
      billingPlans: rawData.billingPlans ?? [],
      pendingLogins: rawData.pendingLogins ?? [],
      activeWorkspaceId,
      workspaces,
      currentUserId,
      users,
      channels: rawData.channels
        .filter((channel) => workspaceIds.has(channel.workspaceId))
        .map((channel) => ({
          ...channel,
          kind: channel.kind ?? "channel",
          visibility: channel.visibility ?? "public",
          memberIds:
            channel.memberIds ??
            users.filter((user) => user.workspaceId === channel.workspaceId).map((user) => user.id)
        })),
      messages: rawData.messages.filter((message) => workspaceIds.has(message.workspaceId)),
      readStates: rawData.readStates.filter((state) => workspaceIds.has(state.workspaceId))
    } as ThaneStoreData;
  }
  const { currentAccountId: _legacyCurrentAccountId, ...rawDataWithoutCurrentAccount } = rawData;
  void _legacyCurrentAccountId;
  return {
    ...rawDataWithoutCurrentAccount,
    accounts: [],
    workspaceMembers: [],
    askThaneIntegrations: rawData.askThaneIntegrations ?? [],
    notificationPreferences: rawData.notificationPreferences ?? [],
    billingPlans: rawData.billingPlans ?? [],
    pendingLogins: rawData.pendingLogins ?? [],
    activeWorkspaceId: "",
    workspaces: [],
    currentUserId: "",
    users: [],
    channels: [],
    messages: [],
    readStates: []
  };
}

async function loadData(): Promise<ThaneStoreData> {
  const path = resolveStorePath();
  try {
    const raw = await readFile(path, "utf8");
    return migrateData(JSON.parse(raw) as ThaneStoreData);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const data = defaultData();
    await saveData(data);
    return data;
  }
}

async function saveData(data: ThaneStoreData): Promise<void> {
  const path = resolveStorePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeChannelName(name: string): string {
  return name.trim().replace(/^#/, "").toLowerCase();
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function assertUserHandleAllowed(handle: string): void {
  if (reservedHandles.has(handle)) {
    throw new Error("@thane is reserved for Ask Thane.");
  }
}

function extractMentions(text: string): string[] {
  const mentions = new Set<string>();
  for (const match of text.matchAll(/@([a-zA-Z0-9._-]+)/g)) {
    const handle = match[1];
    if (handle) {
      mentions.add(handle.toLowerCase());
    }
  }
  return [...mentions];
}

function parsePingLocationRequest(text: string): PingLocation | undefined {
  const normalized = text.toLowerCase();
  const mentionsPing = /\b(ping|notify|message|remind|follow up|follow-up|send)\b/.test(normalized);
  if (!mentionsPing) {
    return undefined;
  }
  if (/\b(both|everywhere|slack and (thane|cli)|thane and slack)\b/.test(normalized)) {
    return "both";
  }
  if (/\b(slack)\b/.test(normalized)) {
    return "slack";
  }
  if (/\b(here|cli|thane cli|terminal|this app)\b/.test(normalized)) {
    return "thane_cli";
  }
  if (/\b(origin|where it started|same place|source)\b/.test(normalized)) {
    return "origin";
  }
  return undefined;
}

function describePingLocation(location: PingLocation): string {
  switch (location) {
    case "both":
      return "Slack and Thane CLI";
    case "slack":
      return "Slack";
    case "thane_cli":
      return "Thane CLI";
    case "origin":
      return "the place where the task or reminder started";
  }
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signBillingPayload(secret: string, payloadEncoded: string): string {
  return createHmac("sha256", secret).update(payloadEncoded).digest("base64url");
}

function deterministicId(prefix: string, ...parts: string[]): string {
  const normalized = parts.join("_").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return `${prefix}_${normalized || "import"}`;
}

function slackTsToIso(ts: string | undefined, fallback = nowIso()): string {
  if (!ts) {
    return fallback;
  }
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) {
    return fallback;
  }
  return new Date(Math.floor(seconds * 1000)).toISOString();
}

function normalizeSlackHandle(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback).trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback.toLowerCase();
}

function decodeSlackEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export class ThaneStore {
  private constructor(private data: ThaneStoreData) {}

  static async open(): Promise<ThaneStore> {
    return new ThaneStore(await loadData());
  }

  stats(): {
    accountCount: number;
    workspaceCount: number;
    userCount: number;
    channelCount: number;
    dmCount: number;
    messageCount: number;
    unreadCount: number;
  } {
    const activeWorkspace = this.data.workspaces.find((candidate) => candidate.id === this.data.activeWorkspaceId);
    if (!activeWorkspace) {
      return {
        accountCount: this.data.accounts.length,
        workspaceCount: this.data.workspaces.length,
        userCount: this.data.users.length,
        channelCount: 0,
        dmCount: 0,
        messageCount: 0,
        unreadCount: 0
      };
    }
    return {
      accountCount: this.data.accounts.length,
      workspaceCount: this.data.workspaces.length,
      userCount: this.data.users.length,
      channelCount: this.listChannels().length,
      dmCount: this.listDms().length,
      messageCount: this.data.messages.filter((message) => message.workspaceId === activeWorkspace.id).length,
      unreadCount: this.unread(10_000).length
    };
  }

  get activeWorkspaceId(): string | undefined {
    return this.data.workspaces.some((workspace) => workspace.id === this.data.activeWorkspaceId)
      ? this.data.activeWorkspaceId
      : undefined;
  }

  hasActiveWorkspace(): boolean {
    return Boolean(this.activeWorkspaceId);
  }

  get activeWorkspace(): ThaneWorkspace {
    const workspace = this.data.workspaces.find((candidate) => candidate.id === this.data.activeWorkspaceId);
    if (!workspace) {
      throw new Error("No hosted workspace is cached. Run `thane init` to sign in, or accept/create a hosted workspace.");
    }
    return workspace;
  }

  get currentAccount(): ThaneAccount | undefined {
    return this.data.accounts.find((account) => account.id === this.data.currentAccountId);
  }

  async applyHostedSnapshot(snapshot: {
    account?: ThaneAccount;
    activeWorkspaceId?: string | null;
    workspaces: ThaneWorkspace[];
    workspaceMembers: ThaneWorkspaceMember[];
    users: ThaneUser[];
    channels: ThaneChannel[];
    messages: ThaneMessage[];
    readStates?: ThaneReadState[];
    askThaneIntegrations?: AskThaneIntegration[];
    notificationPreferences?: NotificationPreference[];
    billingPlans?: WorkspaceBillingPlan[];
  }): Promise<void> {
    if (snapshot.account) {
      const existing = this.data.accounts.find((account) => account.id === snapshot.account?.id || account.email === snapshot.account?.email);
      if (existing) {
        existing.displayName = snapshot.account.displayName || existing.displayName;
        if (snapshot.account.authToken) {
          existing.authToken = snapshot.account.authToken;
        }
      } else {
        this.data.accounts.push(snapshot.account);
      }
      this.data.currentAccountId = existing?.id ?? snapshot.account.id;
    }

    for (const workspace of snapshot.workspaces) {
      const existing = this.data.workspaces.find((candidate) => candidate.id === workspace.id || candidate.slug === workspace.slug);
      if (existing) {
        existing.id = workspace.id;
        existing.slug = workspace.slug;
        existing.name = workspace.name;
        existing.createdAt = workspace.createdAt;
        if (workspace.asciiArt) {
          existing.asciiArt = workspace.asciiArt;
        } else {
          delete existing.asciiArt;
        }
      } else {
        this.data.workspaces.push(workspace);
      }
    }

    const activeWorkspaceId = snapshot.activeWorkspaceId ?? snapshot.workspaces[0]?.id;
    if (activeWorkspaceId) {
      this.data.activeWorkspaceId = activeWorkspaceId;
      this.data.workspaceMembers = this.data.workspaceMembers
        .filter((member) => member.workspaceId !== activeWorkspaceId)
        .concat(snapshot.workspaceMembers);
      this.data.users = this.data.users.filter((user) => user.workspaceId !== activeWorkspaceId).concat(snapshot.users);
      this.data.channels = this.data.channels.filter((channel) => channel.workspaceId !== activeWorkspaceId).concat(snapshot.channels);
      this.data.messages = this.data.messages.filter((message) => message.workspaceId !== activeWorkspaceId).concat(snapshot.messages);
      if (snapshot.readStates) {
        this.data.readStates = this.data.readStates
          .filter((readState) => readState.workspaceId !== activeWorkspaceId)
          .concat(snapshot.readStates);
      }
      if (snapshot.askThaneIntegrations) {
        this.data.askThaneIntegrations = this.data.askThaneIntegrations
          .filter((integration) => integration.workspaceId !== activeWorkspaceId)
          .concat(snapshot.askThaneIntegrations);
      }
      if (snapshot.billingPlans) {
        this.data.billingPlans = this.data.billingPlans
          .filter((plan) => !snapshot.billingPlans?.some((snapshotPlan) => snapshotPlan.workspaceId === plan.workspaceId))
          .concat(snapshot.billingPlans);
      }
      if (snapshot.notificationPreferences) {
        this.data.notificationPreferences = this.data.notificationPreferences
          .filter((preference) =>
            !snapshot.notificationPreferences?.some((snapshotPreference) => snapshotPreference.accountId === preference.accountId)
          )
          .concat(snapshot.notificationPreferences);
      }

      const currentAccountId = this.data.currentAccountId;
      const hostedUser =
        (currentAccountId && snapshot.users.find((user) => user.accountId === currentAccountId)) ??
        snapshot.users.find((user) => user.email === this.currentAccount?.email) ??
        snapshot.users[0];
      if (hostedUser) {
        this.data.currentUserId = hostedUser.id;
      }
    }

    await saveData(this.data);
  }

  get currentUser(): ThaneUser {
    const user = this.data.users.find(
      (candidate) => candidate.id === this.data.currentUserId && candidate.workspaceId === this.activeWorkspace.id
    );
    if (!user) {
      throw new Error("Current user is missing from the hosted workspace cache. Run `thane init` or `thane workspaces` to refresh.");
    }
    return user;
  }

  currentMember(): ThaneWorkspaceMember | undefined {
    return this.data.workspaceMembers.find(
      (member) => member.workspaceId === this.activeWorkspace.id && member.userId === this.currentUser.id
    );
  }

  async setAccountDisplayName(displayName: string): Promise<{ account: ThaneAccount }> {
    const cleaned = displayName.trim();
    if (!cleaned) {
      throw new Error("Display name must contain at least one character.");
    }
    const account = this.currentAccount;
    if (!account) {
      throw new Error("No hosted account is active. Run `thane init` first.");
    }
    account.displayName = cleaned.slice(0, 120);
    await saveData(this.data);
    return { account };
  }

  async setWorkspaceDisplayName(displayName: string, workspaceId = this.activeWorkspace.id): Promise<{ user: ThaneUser }> {
    const cleaned = displayName.trim();
    if (!cleaned) {
      throw new Error("Display name must contain at least one character.");
    }
    const account = this.currentAccount;
    const user =
      (account && this.data.users.find((candidate) => candidate.workspaceId === workspaceId && candidate.accountId === account.id)) ||
      this.data.users.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === this.data.currentUserId);
    if (!user) {
      throw new Error("Current workspace user is missing. Run `thane sync` or `thane workspaces` to refresh.");
    }
    user.displayName = cleaned.slice(0, 120);
    if (account && isGeneratedAccountHandle(user.handle, account.id)) {
      user.handle = uniqueWorkspaceHandle(this.data.users, workspaceId, handleSeedFromDisplayName(cleaned) || handleFromAccountId(account.id), user.id);
    }
    await saveData(this.data);
    return { user };
  }

  async setWorkspaceHandle(handle: string, workspaceId = this.activeWorkspace.id): Promise<{ user: ThaneUser }> {
    const cleaned = normalizeHandle(handle);
    if (!cleaned) {
      throw new Error("Handle must contain at least one character.");
    }
    assertUserHandleAllowed(cleaned);
    const account = this.currentAccount;
    const user =
      (account && this.data.users.find((candidate) => candidate.workspaceId === workspaceId && candidate.accountId === account.id)) ||
      this.data.users.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === this.data.currentUserId);
    if (!user) {
      throw new Error("Current workspace user is missing. Run `thane sync` or `thane workspaces` to refresh.");
    }
    user.handle = cleaned.slice(0, 32);
    await saveData(this.data);
    return { user };
  }

  async setDisplayName(displayName: string): Promise<{ account?: ThaneAccount; user: ThaneUser }> {
    const account = this.currentAccount;
    if (account) {
      await this.setAccountDisplayName(displayName);
    }
    const { user } = await this.setWorkspaceDisplayName(displayName);
    return {
      ...(account ? { account } : {}),
      user
    };
  }

  requireWorkspaceAdmin(): void {
    const role = this.currentMember()?.role;
    if (role !== "owner" && role !== "admin") {
      throw new Error("Only workspace owners and admins can add people to this workspace.");
    }
  }

  askThaneStatus(): AskThaneIntegration | undefined {
    return this.data.askThaneIntegrations.find((integration) => integration.workspaceId === this.activeWorkspace.id);
  }

  billingPlan(): WorkspaceBillingPlan {
    return (
      this.data.billingPlans.find((plan) => plan.workspaceId === this.activeWorkspace.id) ?? {
        workspaceId: this.activeWorkspace.id,
        planTier: "free",
        status: "active",
        updatedAt: nowIso()
      }
    );
  }

  billingSummary(): {
    plan: WorkspaceBillingPlan;
    limits: typeof THANE_CLI_FREE_LIMITS;
    usage: { members: number; privateChannels: number };
  } {
    return {
      plan: this.billingPlan(),
      limits: THANE_CLI_FREE_LIMITS,
      usage: {
        members: this.listMembers().length,
        privateChannels: this.data.channels.filter(
          (channel) => channel.workspaceId === this.activeWorkspace.id && channel.kind === "channel" && channel.visibility === "private"
        ).length
      }
    };
  }

  async setBillingPlan(planTier: ThaneCliPlanTier, status: "active" | "inactive" | "past_due" = "active"): Promise<WorkspaceBillingPlan> {
    let plan = this.data.billingPlans.find((candidate) => candidate.workspaceId === this.activeWorkspace.id);
    if (!plan) {
      plan = {
        workspaceId: this.activeWorkspace.id,
        planTier,
        status,
        updatedAt: nowIso()
      };
      this.data.billingPlans.push(plan);
    } else {
      plan.planTier = planTier;
      plan.status = status;
      plan.updatedAt = nowIso();
    }
    await saveData(this.data);
    return plan;
  }

  async setWorkspaceAsciiArt(value: string): Promise<ThaneWorkspace> {
    this.requireWorkspaceAdmin();
    const workspace = this.activeWorkspace;
    workspace.asciiArt = normalizeWorkspaceAsciiArt(value);
    await saveData(this.data);
    return workspace;
  }

  async clearWorkspaceAsciiArt(): Promise<ThaneWorkspace> {
    this.requireWorkspaceAdmin();
    const workspace = this.activeWorkspace;
    delete workspace.asciiArt;
    await saveData(this.data);
    return workspace;
  }

  createBillingCheckoutUrl(input: { paymentsBaseUrl?: string; signingSecret?: string; email?: string }): string {
    const paymentsBaseUrl = input.paymentsBaseUrl?.trim();
    const signingSecret = input.signingSecret?.trim();
    if (!paymentsBaseUrl) {
      throw new Error("Set THANE_PAYMENTS_BASE_URL to create a Stripe checkout link.");
    }
    if (!signingSecret) {
      throw new Error("Set THANE_BILLING_LINK_SIGNING_SECRET to create a Stripe checkout link.");
    }
    const payloadEncoded = base64UrlJson({
      organizationId: this.activeWorkspace.id,
      workspaceId: this.activeWorkspace.id,
      planTier: "cli_team",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 15 * 60
    });
    const token = `${payloadEncoded}.${signBillingPayload(signingSecret, payloadEncoded)}`;
    const url = new URL("/subscribe", paymentsBaseUrl);
    url.searchParams.set("billing_token", token);
    url.searchParams.set("autostart", "1");
    if (input.email?.trim()) {
      url.searchParams.set("email", input.email.trim());
    }
    return url.toString();
  }

  private isCliTeam(): boolean {
    const plan = this.billingPlan();
    return plan.planTier === "cli_team" && plan.status === "active";
  }

  private enforceMemberLimitForFree(): void {
    if (this.isCliTeam()) {
      return;
    }
    if (this.listMembers().length >= THANE_CLI_FREE_LIMITS.members) {
      throw new Error(`Free workspaces support up to ${THANE_CLI_FREE_LIMITS.members} members. Upgrade with: thane billing checkout`);
    }
  }

  private enforcePrivateChannelLimitForFree(): void {
    if (this.isCliTeam()) {
      return;
    }
    const privateChannels = this.data.channels.filter(
      (channel) => channel.workspaceId === this.activeWorkspace.id && channel.kind === "channel" && channel.visibility === "private"
    );
    if (privateChannels.length >= THANE_CLI_FREE_LIMITS.privateChannels) {
      throw new Error(
        `Free workspaces support up to ${THANE_CLI_FREE_LIMITS.privateChannels} private channels. Upgrade with: thane billing checkout`
      );
    }
  }

  previewSlackImport(exportData: ParsedSlackExport): SlackImportPreview {
    return previewSlackExport(exportData, THANE_CLI_FREE_LIMITS);
  }

  async importSlackExport(exportData: ParsedSlackExport): Promise<SlackImportResult> {
    this.requireWorkspaceAdmin();
    const preview = this.previewSlackImport(exportData);
    const privateChannelNames = new Set(
      exportData.conversations
        .filter((item) => item.source === "groups")
        .map((item) => normalizeChannelName(item.conversation.name ?? item.conversation.id))
    );
    const existingPrivateChannelNames = new Set(
      this.data.channels
        .filter((channel) => channel.workspaceId === this.activeWorkspace.id && channel.kind === "channel" && channel.visibility === "private")
        .map((channel) => channel.name)
    );
    const privateChannelsAfterImport = new Set([...existingPrivateChannelNames, ...privateChannelNames]).size;
    if (!this.isCliTeam() && (preview.users > THANE_CLI_FREE_LIMITS.members || privateChannelsAfterImport > THANE_CLI_FREE_LIMITS.privateChannels)) {
      throw new Error(
        `This Slack export has ${preview.users} users and ${privateChannelsAfterImport} private channels after import. Free workspaces support ${THANE_CLI_FREE_LIMITS.members} members and ${THANE_CLI_FREE_LIMITS.privateChannels} private channels. Upgrade with: thane billing checkout`
      );
    }

    const workspaceId = this.activeWorkspace.id;
    const userBySlackId = new Map<string, ThaneUser>();
    const userByHandle = new Map(this.data.users.filter((user) => user.workspaceId === workspaceId).map((user) => [user.handle, user]));
    let importedUsers = 0;

    for (const slackUser of exportData.users) {
      if (!slackUser.id) {
        continue;
      }
      const email = slackUser.profile?.email?.trim().toLowerCase();
      const displayName = slackUser.profile?.real_name || slackUser.real_name || slackUser.profile?.display_name || slackUser.name || slackUser.id;
      const handle = normalizeSlackHandle(slackUser.name, slackUser.id.toLowerCase());
      const currentAccountMatches = email && this.currentAccount?.email === email;
      let user =
        (currentAccountMatches ? this.currentUser : undefined) ??
        (email ? this.data.users.find((candidate) => candidate.workspaceId === workspaceId && candidate.email === email) : undefined) ??
        userByHandle.get(handle);

      if (!user) {
        user = {
          id: deterministicId("usr_slack", workspaceId, slackUser.id),
          workspaceId,
          handle,
          displayName,
          ...(email ? { email } : {})
        };
        this.data.users.push(user);
        userByHandle.set(handle, user);
        importedUsers += 1;
      } else {
        user.displayName = user.displayName || displayName;
        if (email && !user.email) {
          user.email = email;
        }
      }

      if (email) {
        let account = this.data.accounts.find((candidate) => candidate.email === email);
        if (!account) {
          account = {
            id: deterministicId("acct_slack", email),
            email,
            displayName,
            createdAt: nowIso()
          };
          this.data.accounts.push(account);
        }
        user.accountId = user.accountId ?? account.id;
        if (!this.data.workspaceMembers.some((member) => member.workspaceId === workspaceId && member.userId === user.id)) {
          this.data.workspaceMembers.push({
            id: deterministicId("mbr_slack", workspaceId, user.id),
            workspaceId,
            accountId: account.id,
            userId: user.id,
            role: user.id === this.currentUser.id ? this.currentMember()?.role ?? "owner" : "member",
            joinedAt: nowIso()
          });
        }
      }

      userBySlackId.set(slackUser.id, user);
    }

    const botUserByKey = new Map<string, ThaneUser>();
    const ensureBotUser = (message: SlackExportMessage): ThaneUser => {
      const rawName = message.username || message.bot_id || "slackbot";
      const handle = normalizeSlackHandle(rawName, "slackbot");
      const key = message.bot_id || handle;
      const existing = botUserByKey.get(key) ?? this.data.users.find((user) => user.workspaceId === workspaceId && user.handle === handle);
      if (existing) {
        botUserByKey.set(key, existing);
        return existing;
      }
      const user: ThaneUser = {
        id: deterministicId("usr_slackbot", workspaceId, key),
        workspaceId,
        handle,
        displayName: rawName
      };
      this.data.users.push(user);
      botUserByKey.set(key, user);
      return user;
    };

    const conversationByFolder = new Map<string, ParsedSlackConversation>();
    for (const item of exportData.conversations) {
      const conversation = item.conversation;
      const keys = [conversation.id, conversation.name].filter((value): value is string => Boolean(value));
      for (const key of keys) {
        conversationByFolder.set(key, item);
      }
    }

    const channelBySlackId = new Map<string, ThaneChannel>();
    let importedChannels = 0;
    for (const item of exportData.conversations) {
      const conversation = item.conversation;
      if (!conversation.id) {
        continue;
      }
      const isDm = item.source === "dms" || item.source === "mpims";
      const memberIds = (conversation.members ?? []).map((memberId) => userBySlackId.get(memberId)?.id).filter((value): value is string => Boolean(value));
      if (!memberIds.includes(this.currentUser.id)) {
        memberIds.push(this.currentUser.id);
      }
      const sourceName = conversation.name ?? conversation.id;
      const dmName =
        isDm && conversation.members?.length
          ? conversation.members
              .map((memberId) => userBySlackId.get(memberId)?.handle)
              .filter((handle): handle is string => Boolean(handle && handle !== this.currentUser.handle))
              .join("-") || sourceName
          : sourceName;
      const name = normalizeChannelName(isDm ? dmName : sourceName);
      const visibility: ChannelVisibility = item.source === "channels" ? "public" : "private";
      let channel = this.data.channels.find(
        (candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.kind === (isDm ? "dm" : "channel") &&
          (candidate.id === deterministicId(isDm ? "dm_slack" : "chn_slack", workspaceId, conversation.id) || candidate.name === name)
      );
      if (!channel) {
        channel = {
          id: deterministicId(isDm ? "dm_slack" : "chn_slack", workspaceId, conversation.id),
          workspaceId,
          name,
          kind: isDm ? "dm" : "channel",
          visibility,
          memberIds,
          createdAt: conversation.created ? slackTsToIso(String(conversation.created)) : nowIso()
        };
        const topic = conversation.topic?.value || conversation.purpose?.value;
        if (topic) {
          channel.topic = topic;
        }
        this.data.channels.push(channel);
        importedChannels += 1;
      } else {
        for (const memberId of memberIds) {
          if (!channel.memberIds.includes(memberId)) {
            channel.memberIds.push(memberId);
          }
        }
      }
      channelBySlackId.set(conversation.id, channel);
    }

    const messages = exportData.messageFiles
      .flatMap((file) =>
        file.messages.map((message) => ({
          file,
          message,
          order: Number.parseFloat(message.ts ?? "0")
        }))
      )
      .filter((item) => item.message.ts)
      .sort((a, b) => a.order - b.order);

    let importedMessages = 0;
    let skippedDuplicateMessages = 0;
    for (const item of messages) {
      const sourceConversation = conversationByFolder.get(item.file.folder);
      const channel = sourceConversation ? channelBySlackId.get(sourceConversation.conversation.id) : undefined;
      if (!channel || !item.message.ts) {
        continue;
      }
      const messageId = deterministicId("msg_slack", workspaceId, channel.id, item.message.ts);
      if (this.data.messages.some((message) => message.id === messageId)) {
        skippedDuplicateMessages += 1;
        continue;
      }
      const author = item.message.user ? userBySlackId.get(item.message.user) : undefined;
      const authorUser = author ?? ensureBotUser(item.message);
      const text = this.renderSlackMessageText(item.message, userBySlackId, channelBySlackId);
      const threadRootId =
        item.message.thread_ts && item.message.thread_ts !== item.message.ts
          ? deterministicId("msg_slack", workspaceId, channel.id, item.message.thread_ts)
          : undefined;
      const importedMessage: ThaneMessage = {
        id: messageId,
        workspaceId,
        channelId: channel.id,
        authorId: authorUser.id,
        text,
        createdAt: slackTsToIso(item.message.ts),
        reactions: (item.message.reactions ?? []).map((reaction) => ({
          emoji: reaction.name ?? "reaction",
          by: (reaction.users ?? []).map((userId) => userBySlackId.get(userId)?.handle ?? userId).join(", ") || "unknown",
          createdAt: slackTsToIso(item.message.ts)
        })),
        mentions: extractMentions(text),
        ...(threadRootId ? { threadRootId } : {})
      };
      this.data.messages.push(importedMessage);
      importedMessages += 1;
    }

    await saveData(this.data);
    return {
      ...preview,
      importedUsers,
      importedChannels,
      importedMessages,
      skippedDuplicateMessages
    };
  }

  private renderSlackMessageText(
    message: SlackExportMessage,
    userBySlackId: Map<string, ThaneUser>,
    channelBySlackId: Map<string, ThaneChannel>
  ): string {
    let text = decodeSlackEntities(message.text ?? "");
    text = text.replace(/<@([A-Z0-9]+)>/g, (_match, userId: string) => {
      const user = userBySlackId.get(userId);
      return user ? `@${user.handle}` : `@${userId}`;
    });
    text = text.replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, channelId: string, label?: string) => {
      const channel = channelBySlackId.get(channelId);
      return `#${channel?.name ?? label ?? channelId}`;
    });
    text = text.replace(/<((?:https?:|mailto:)[^>|]+)\|([^>]+)>/g, (_match, url: string, label: string) => `${label} (${url})`);
    text = text.replace(/<((?:https?:|mailto:)[^>]+)>/g, (_match, url: string) => url);
    if (message.files?.length) {
      const fileLines = message.files.map((file) => {
        const label = file.title || file.name || file.id || "Slack file";
        const url = file.permalink || file.url_private;
        return url ? `[file: ${label}] ${url}` : `[file: ${label}]`;
      });
      text = [text, ...fileLines].filter(Boolean).join("\n");
    }
    return text || `[Slack ${message.subtype ?? "message"}]`;
  }

  async enableAskThane(): Promise<AskThaneIntegration> {
    const account = this.currentAccount;
    if (!account) {
      throw new Error("Sign in before enabling Ask Thane: thane login <email>");
    }
    let bot = this.data.users.find((user) => user.workspaceId === this.activeWorkspace.id && user.handle === "thane");
    if (!bot) {
      bot = {
        id: id("usr"),
        workspaceId: this.activeWorkspace.id,
        handle: "thane",
        displayName: "Ask Thane"
      };
      this.data.users.push(bot);
    }
    const existing = this.askThaneStatus();
    const integration: AskThaneIntegration =
      existing ??
      ({
        workspaceId: this.activeWorkspace.id,
        enabled: true,
        botUserId: bot.id,
        linkedAccountEmail: account.email,
        provider: "thane_cli",
        externalUserId: account.email,
        connectedAt: nowIso()
      } satisfies AskThaneIntegration);
    integration.enabled = true;
    integration.botUserId = bot.id;
    integration.linkedAccountEmail = account.email;
    integration.externalUserId = account.email;
    if (!existing) {
      this.data.askThaneIntegrations.push(integration);
    }
    await saveData(this.data);
    return integration;
  }

  async disableAskThane(): Promise<void> {
    const existing = this.askThaneStatus();
    if (existing) {
      existing.enabled = false;
      existing.lastEventAt = nowIso();
      await saveData(this.data);
    }
  }

  notificationPreference(): NotificationPreference {
    const account = this.currentAccount;
    if (!account) {
      throw new Error("Sign in before reading notification settings: thane login <email>");
    }
    return (
      this.data.notificationPreferences.find((preference) => preference.accountId === account.id) ?? {
        accountId: account.id,
        preferredPingLocation: "origin",
        updatedAt: nowIso()
      }
    );
  }

  async setPingLocation(location: PingLocation, updatedBy: "user" | "ask_thane" = "user"): Promise<NotificationPreference> {
    const account = this.currentAccount;
    if (!account) {
      throw new Error("Sign in before changing notification settings: thane login <email>");
    }
    let preference = this.data.notificationPreferences.find((candidate) => candidate.accountId === account.id);
    if (!preference) {
      preference = {
        accountId: account.id,
        preferredPingLocation: location,
        updatedAt: nowIso(),
        updatedBy
      };
      this.data.notificationPreferences.push(preference);
    } else {
      preference.preferredPingLocation = location;
      preference.updatedAt = nowIso();
      preference.updatedBy = updatedBy;
    }
    await saveData(this.data);
    return preference;
  }

  async applyNotificationPreference(preference: NotificationPreference): Promise<void> {
    const existing = this.data.notificationPreferences.find((candidate) => candidate.accountId === preference.accountId);
    if (existing) {
      existing.preferredPingLocation = preference.preferredPingLocation;
      existing.updatedAt = preference.updatedAt;
      if (preference.updatedBy) {
        existing.updatedBy = preference.updatedBy;
      } else {
        delete existing.updatedBy;
      }
    } else {
      this.data.notificationPreferences.push(preference);
    }
    await saveData(this.data);
  }

  async signup(email: string, displayName?: string): Promise<{ account: ThaneAccount; code: string }> {
    void email;
    void displayName;
    throw new Error("Local signup is no longer supported. Use hosted auth with `thane init`.");
  }

  async login(email: string): Promise<{ account?: ThaneAccount; code: string }> {
    void email;
    throw new Error("Local login is no longer supported. Use hosted auth with `thane init`.");
  }

  async acceptVerifiedAccount(account: ThaneAccount): Promise<ThaneAccount> {
    const existing = this.data.accounts.find((candidate) => candidate.email === account.email);
    const stored =
      existing ??
      ({
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        createdAt: account.createdAt,
        ...(account.authToken ? { authToken: account.authToken } : {})
      } satisfies ThaneAccount);
    if (!existing) {
      this.data.accounts.push(stored);
    } else {
      existing.displayName = account.displayName || existing.displayName;
      if (account.authToken) {
        existing.authToken = account.authToken;
      }
    }
    this.data.currentAccountId = stored.id;
    if (this.hasActiveWorkspace()) {
      this.ensureAccountMembership(stored, this.activeWorkspace.id, this.data.workspaceMembers.length === 0 ? "owner" : "member");
    }
    await saveData(this.data);
    return stored;
  }

  async verify(email: string, code: string): Promise<ThaneAccount> {
    void email;
    void code;
    throw new Error("Local verification is no longer supported. Use hosted auth with `thane init`.");
  }

  async logout(): Promise<void> {
    delete this.data.currentAccountId;
    await saveData(this.data);
  }

  private createPendingLogin(email: string): string {
    void email;
    throw new Error("Local verification codes are no longer supported.");
  }

  private ensureGeneralChannel(workspaceId: string, memberUserId?: string, createdAt = nowIso()): ThaneChannel {
    let channel = this.data.channels.find((candidate) => candidate.workspaceId === workspaceId && candidate.kind === "channel" && candidate.name === "general");
    if (!channel) {
      const memberIds = this.data.workspaceMembers
        .filter((member) => member.workspaceId === workspaceId)
        .map((member) => member.userId);
      if (memberUserId && !memberIds.includes(memberUserId)) {
        memberIds.push(memberUserId);
      }
      channel = {
        id: id("chn"),
        workspaceId,
        name: "general",
        kind: "channel",
        visibility: "public",
        memberIds,
        topic: "Community-wide conversation",
        createdAt
      };
      this.data.channels.push(channel);
    } else if (memberUserId && !channel.memberIds.includes(memberUserId)) {
      channel.memberIds.push(memberUserId);
    }
    return channel;
  }

  private recordWorkspaceJoinMessage(member: ThaneWorkspaceMember): void {
    const account = this.data.accounts.find((candidate) => candidate.id === member.accountId);
    if (account?.email === "thane@askthane.com") {
      return;
    }
    const messageId = workspaceJoinMessageId(member.id);
    if (this.data.messages.some((message) => message.id === messageId)) {
      return;
    }
    const user = this.data.users.find((candidate) => candidate.id === member.userId);
    const channel = this.ensureGeneralChannel(member.workspaceId, member.userId, member.joinedAt);
    this.data.messages.push({
      id: messageId,
      workspaceId: member.workspaceId,
      channelId: channel.id,
      authorId: member.userId,
      text: workspaceJoinMessageText(user),
      createdAt: member.joinedAt,
      source: "chat",
      reactions: [],
      mentions: []
    });
  }

  private ensureAccountMembership(account: ThaneAccount, workspaceId: string, role: WorkspaceRole): ThaneWorkspaceMember {
    let user = this.data.users.find((candidate) => candidate.workspaceId === workspaceId && candidate.accountId === account.id);
    if (!user) {
      user = {
        id: id("usr"),
        workspaceId,
        accountId: account.id,
        handle: uniqueWorkspaceHandle(this.data.users, workspaceId, handleSeedForAccount(account)),
        displayName: account.displayName || displayNameFromAccountId(account.id),
        email: account.email
      };
      this.data.users.push(user);
    }
    let member = this.data.workspaceMembers.find(
      (candidate) => candidate.workspaceId === workspaceId && candidate.accountId === account.id
    );
    const createdMember = !member;
    if (!member) {
      member = {
        id: id("mbr"),
        workspaceId,
        accountId: account.id,
        userId: user.id,
        role,
        joinedAt: nowIso()
      };
      this.data.workspaceMembers.push(member);
    }
    if (createdMember) {
      this.recordWorkspaceJoinMessage(member);
    }
    if (workspaceId === this.data.activeWorkspaceId && account.id === this.data.currentAccountId) {
      this.data.currentUserId = user.id;
    }
    return member;
  }

  listWorkspaces(): ThaneWorkspace[] {
    return [...this.data.workspaces].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  findWorkspace(slugOrId: string): ThaneWorkspace | undefined {
    const normalized = normalizeWorkspaceSlug(slugOrId);
    return this.data.workspaces.find((workspace) => workspace.id === slugOrId || workspace.slug === normalized);
  }

  async createWorkspace(slug: string, name?: string): Promise<ThaneWorkspace> {
    const account = this.currentAccount;
    if (!account) {
      throw new Error("Run `thane init` before creating a workspace.");
    }
    const normalized = normalizeWorkspaceSlug(slug);
    if (!normalized) {
      throw new Error("Workspace slug must contain at least one letter or number.");
    }
    const existing = this.findWorkspace(normalized);
    if (existing) {
      return existing;
    }
    const workspace: ThaneWorkspace = {
      id: id("wsp"),
      slug: normalized,
      name: name?.trim() || normalized,
      createdAt: nowIso()
    };
    this.data.workspaces.push(workspace);
    this.ensureAccountMembership(account, workspace.id, "owner");
    await saveData(this.data);
    return workspace;
  }

  async joinWorkspaceFromInvite(input: {
    id: string;
    slug: string;
    name: string;
    role: "admin" | "member";
  }): Promise<{ workspace: ThaneWorkspace; member: ThaneWorkspaceMember }> {
    const account = this.currentAccount;
    if (!account) {
      throw new Error("Run `thane init` before accepting a workspace invite.");
    }
    const normalized = normalizeWorkspaceSlug(input.slug);
    if (!normalized) {
      throw new Error("Invite workspace slug is invalid.");
    }
    let workspace = this.findWorkspace(input.id) ?? this.findWorkspace(normalized);
    if (!workspace) {
      workspace = {
        id: input.id || id("wsp"),
        slug: normalized,
        name: input.name.trim() || normalized,
        createdAt: nowIso()
      };
      this.data.workspaces.push(workspace);
    }
    const member = this.ensureAccountMembership(account, workspace.id, input.role);
    this.ensureGeneralChannel(workspace.id, member.userId);
    this.data.activeWorkspaceId = workspace.id;
    this.data.currentUserId = member.userId;
    await saveData(this.data);
    return { workspace, member };
  }

  async useWorkspace(slugOrId: string): Promise<ThaneWorkspace> {
    const workspace = this.findWorkspace(slugOrId);
    if (!workspace) {
      throw new Error(`Workspace ${slugOrId} was not found. Create it with: thane workspace create ${slugOrId}`);
    }
    this.data.activeWorkspaceId = workspace.id;
    const existingUser =
      (this.currentAccount &&
        this.data.users.find((user) => user.workspaceId === workspace.id && user.accountId === this.currentAccount?.id)) ??
      this.data.users.find((user) => user.workspaceId === workspace.id && user.handle === "you");
    if (existingUser) {
      this.data.currentUserId = existingUser.id;
    } else {
      const user = {
        id: id("usr"),
        workspaceId: workspace.id,
        ...(this.currentAccount ? { accountId: this.currentAccount.id, email: this.currentAccount.email } : {}),
        handle: "you",
        displayName: this.currentAccount?.displayName ?? "You"
      };
      this.data.users.push(user);
      this.data.currentUserId = user.id;
    }
    await saveData(this.data);
    return workspace;
  }

  listMembers(): Array<{ user: ThaneUser; account?: ThaneAccount; role: WorkspaceRole; joinedAt: string }> {
    return this.data.workspaceMembers
      .filter((member) => member.workspaceId === this.activeWorkspace.id)
      .map((member) => {
        const renderedMember: { user?: ThaneUser; account?: ThaneAccount; role: WorkspaceRole; joinedAt: string } = {
          role: member.role,
          joinedAt: member.joinedAt
        };
        const user = this.data.users.find((candidate) => candidate.id === member.userId);
        if (user) {
          renderedMember.user = user;
        }
        const account = this.data.accounts.find((candidate) => candidate.id === member.accountId);
        if (account) {
          renderedMember.account = account;
        }
        return renderedMember;
      })
      .filter((member): member is { user: ThaneUser; account?: ThaneAccount; role: WorkspaceRole; joinedAt: string } =>
        Boolean(member.user)
      )
      .sort((a, b) => a.user.handle.localeCompare(b.user.handle));
  }

  async invite(email: string, role: WorkspaceRole = "member", handle?: string): Promise<ThaneWorkspaceMember> {
    this.requireWorkspaceAdmin();
    this.enforceMemberLimitForFree();
    if (role === "owner") {
      throw new Error("Use admin/member for invites in the MVP; ownership transfer is not implemented.");
    }
    const normalized = normalizeEmail(email);
    if (!normalized.includes("@")) {
      throw new Error("Usage: thane invite <email>");
    }
    let account = this.data.accounts.find((candidate) => candidate.email === normalized);
    if (!account) {
      const accountId = id("acct");
      account = {
        id: accountId,
        email: normalized,
        displayName: displayNameFromAccountId(accountId),
        createdAt: nowIso()
      };
      this.data.accounts.push(account);
    }
    const member = this.ensureAccountMembership(account, this.activeWorkspace.id, role);
    const user = this.data.users.find((candidate) => candidate.id === member.userId);
    if (user && handle) {
      const cleanedHandle = normalizeHandle(handle);
      assertUserHandleAllowed(cleanedHandle);
      user.handle = cleanedHandle;
    }
    await saveData(this.data);
    return member;
  }

  async setMemberRole(handleOrEmail: string, role: WorkspaceRole): Promise<ThaneWorkspaceMember> {
    this.requireWorkspaceAdmin();
    const target = this.data.workspaceMembers.find((member) => {
      if (member.workspaceId !== this.activeWorkspace.id) {
        return false;
      }
      const user = this.data.users.find((candidate) => candidate.id === member.userId);
      const account = this.data.accounts.find((candidate) => candidate.id === member.accountId);
      return user?.handle === normalizeHandle(handleOrEmail) || account?.email === normalizeEmail(handleOrEmail);
    });
    if (!target) {
      throw new Error(`Member ${handleOrEmail} was not found.`);
    }
    target.role = role;
    await saveData(this.data);
    return target;
  }

  listChannels(): ThaneChannel[] {
    return this.data.channels
      .filter((channel) => channel.workspaceId === this.activeWorkspace.id && channel.kind === "channel")
      .filter((channel) => channel.visibility === "public" || channel.memberIds.includes(this.currentUser.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listDms(): ThaneChannel[] {
    return this.data.channels
      .filter((channel) => channel.workspaceId === this.activeWorkspace.id && channel.kind === "dm")
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listUsers(): ThaneUser[] {
    return this.data.users
      .filter((user) => user.workspaceId === this.activeWorkspace.id)
      .sort((a, b) => a.handle.localeCompare(b.handle));
  }

  findUser(handleOrId: string): ThaneUser | undefined {
    const normalized = normalizeHandle(handleOrId);
    return this.data.users.find(
      (user) => user.workspaceId === this.activeWorkspace.id && (user.id === handleOrId || user.handle === normalized)
    );
  }

  async addUser(handle: string, displayName?: string): Promise<ThaneUser> {
    const normalized = normalizeHandle(handle);
    if (!normalized) {
      throw new Error("User handle must contain at least one character.");
    }
    assertUserHandleAllowed(normalized);
    const existing = this.findUser(normalized);
    if (existing) {
      return existing;
    }
    const user: ThaneUser = {
      id: id("usr"),
      workspaceId: this.activeWorkspace.id,
      handle: normalized,
      displayName: displayName?.trim() || normalized
    };
    this.data.users.push(user);
    await saveData(this.data);
    return user;
  }

  findChannel(nameOrId: string): ThaneChannel | undefined {
    const normalized = normalizeChannelName(nameOrId);
    return this.data.channels.find(
      (channel) =>
        channel.workspaceId === this.activeWorkspace.id &&
        (channel.id === nameOrId || channel.name === normalized) &&
        (channel.visibility === "public" || channel.memberIds.includes(this.currentUser.id))
    );
  }

  private canReadChannel(channel: ThaneChannel, userId = this.currentUser.id): boolean {
    return channel.workspaceId === this.activeWorkspace.id && (channel.visibility === "public" || channel.memberIds.includes(userId));
  }

  private canReadWorkspaceChannel(channel: ThaneChannel, workspaceId: string, userId: string): boolean {
    return channel.workspaceId === workspaceId && (channel.visibility === "public" || channel.memberIds.includes(userId));
  }

  private memberForWorkspace(workspaceId: string): ThaneWorkspaceMember | undefined {
    const currentAccountId = this.data.currentAccountId;
    const currentEmail = this.currentAccount?.email;
    return this.data.workspaceMembers.find((member) => {
      if (member.workspaceId !== workspaceId) {
        return false;
      }
      if (currentAccountId && member.accountId === currentAccountId) {
        return true;
      }
      if (!currentEmail) {
        return false;
      }
      const user = this.data.users.find((candidate) => candidate.id === member.userId);
      return user?.email === currentEmail;
    });
  }

  private currentUserForWorkspace(workspaceId: string): ThaneUser | undefined {
    const currentAccountId = this.data.currentAccountId;
    const currentEmail = this.currentAccount?.email;
    return (
      (currentAccountId && this.data.users.find((user) => user.workspaceId === workspaceId && user.accountId === currentAccountId)) ||
      (currentEmail && this.data.users.find((user) => user.workspaceId === workspaceId && user.email === currentEmail)) ||
      this.data.users.find((user) => user.workspaceId === workspaceId && user.id === this.data.currentUserId) ||
      this.data.users.find((user) => user.workspaceId === workspaceId && user.handle === "you")
    );
  }

  private userDisplayLabel(user: ThaneUser | undefined): string {
    return user?.displayName?.trim() || (user?.handle ? `@${user.handle}` : "unknown");
  }

  dmDisplayLabel(channel: ThaneChannel, currentUserId = this.currentUserForWorkspace(channel.workspaceId)?.id): string {
    if (channel.kind !== "dm") {
      return channel.name;
    }
    const peers = this.data.users
      .filter((user) => user.workspaceId === channel.workspaceId && channel.memberIds.includes(user.id) && user.id !== currentUserId)
      .map((user) => this.userDisplayLabel(user));
    return peers.length > 0 ? peers.join(", ") : channel.name;
  }

  conversationDisplayLabel(channel: ThaneChannel, currentUserId = this.currentUserForWorkspace(channel.workspaceId)?.id): string {
    return channel.kind === "dm" ? this.dmDisplayLabel(channel, currentUserId) : `#${channel.name}`;
  }

  private findChannelInWorkspace(workspaceId: string, nameOrId: string, userId: string): ThaneChannel | undefined {
    const normalized = normalizeChannelName(nameOrId);
    return this.data.channels.find(
      (channel) =>
        channel.workspaceId === workspaceId &&
        (channel.id === nameOrId || channel.name === normalized) &&
        this.canReadWorkspaceChannel(channel, workspaceId, userId)
    );
  }

  private isJoinedChannel(channel: ThaneChannel, userId = this.currentUser.id): boolean {
    return channel.memberIds.includes(userId);
  }

  async createChannel(name: string, topic?: string, visibility: ChannelVisibility = "public"): Promise<ThaneChannel> {
    const normalized = normalizeChannelName(name);
    const existing = this.findChannel(normalized);
    if (existing) {
      return existing;
    }
    if (visibility === "private") {
      this.enforcePrivateChannelLimitForFree();
    }
    const channel: ThaneChannel = {
      id: id("chn"),
      workspaceId: this.activeWorkspace.id,
      name: normalized,
      kind: "channel",
      visibility,
      memberIds: [this.currentUser.id],
      createdAt: nowIso()
    };
    if (topic) {
      channel.topic = topic;
    }
    this.data.channels.push(channel);
    await saveData(this.data);
    return channel;
  }

  async inviteToChannel(channelName: string, handleOrEmail: string): Promise<ThaneChannel> {
    const channel = this.requireChannel(channelName);
    if (channel.visibility === "private" && !channel.memberIds.includes(this.currentUser.id)) {
      throw new Error("Only members of a private channel can invite others to it.");
    }
    const user =
      this.findUser(handleOrEmail) ??
      this.data.users.find(
        (candidate) => candidate.workspaceId === this.activeWorkspace.id && candidate.email === normalizeEmail(handleOrEmail)
      );
    if (!user) {
      throw new Error(`User ${handleOrEmail} was not found in this workspace. Add them with: thane invite ${handleOrEmail}`);
    }
    if (!channel.memberIds.includes(user.id)) {
      channel.memberIds.push(user.id);
    }
    await saveData(this.data);
    return channel;
  }

  async joinChannel(channelName: string): Promise<ThaneChannel> {
    const channel = this.requireChannel(channelName);
    if (!this.canReadChannel(channel)) {
      throw new Error(`Channel ${channelName} was not found.`);
    }
    if (!channel.memberIds.includes(this.currentUser.id)) {
      channel.memberIds.push(this.currentUser.id);
    }
    await saveData(this.data);
    return channel;
  }

  async leaveChannel(channelName: string): Promise<ThaneChannel> {
    const channel = this.requireChannel(channelName);
    channel.memberIds = channel.memberIds.filter((memberId) => memberId !== this.currentUser.id);
    await saveData(this.data);
    return channel;
  }

  channelMembers(channelName: string): ThaneUser[] {
    const channel = this.requireChannel(channelName);
    return this.data.users
      .filter((user) => user.workspaceId === this.activeWorkspace.id && channel.memberIds.includes(user.id))
      .sort((a, b) => a.handle.localeCompare(b.handle));
  }

  async findOrCreateDm(handle: string): Promise<ThaneChannel> {
    const otherUser = this.findUser(handle) ?? (await this.addUser(handle));
    if (otherUser.id === this.currentUser.id) {
      throw new Error("You cannot open a DM with yourself.");
    }
    const memberIds = [this.currentUser.id, otherUser.id].sort();
    const existing = this.data.channels.find(
      (channel) =>
        channel.workspaceId === this.activeWorkspace.id &&
        channel.kind === "dm" &&
        channel.memberIds.length === memberIds.length &&
        memberIds.every((memberId) => channel.memberIds.includes(memberId))
    );
    if (existing) {
      return existing;
    }
    const channel: ThaneChannel = {
      id: id("dm"),
      workspaceId: this.activeWorkspace.id,
      name: otherUser.handle,
      kind: "dm",
      visibility: "private",
      memberIds,
      createdAt: nowIso()
    };
    this.data.channels.push(channel);
    await saveData(this.data);
    return channel;
  }

  async addOptimisticMessage(input: {
    channelId: string;
    text: string;
    threadRootId?: string;
    source?: "chat" | "terminal";
  }): Promise<ThaneMessage> {
    const channel = this.data.channels.find((candidate) => candidate.workspaceId === this.activeWorkspace.id && candidate.id === input.channelId);
    if (!channel) {
      throw new Error(`Channel ${input.channelId} was not found.`);
    }
    const message: ThaneMessage = {
      id: id("pending"),
      workspaceId: this.activeWorkspace.id,
      channelId: channel.id,
      authorId: this.currentUser.id,
      text: input.text,
      createdAt: nowIso(),
      source: input.source ?? "chat",
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      reactions: [],
      mentions: extractMentions(input.text)
    };
    this.data.messages.push(message);
    await saveData(this.data);
    return message;
  }

  async removeLocalMessage(messageId: string): Promise<void> {
    const before = this.data.messages.length;
    this.data.messages = this.data.messages.filter((message) => message.id !== messageId);
    if (this.data.messages.length !== before) {
      await saveData(this.data);
    }
  }

  async replaceLocalMessage(localMessageId: string, replacement: ThaneMessage): Promise<void> {
    if (this.data.messages.some((message) => message.id === replacement.id)) {
      this.data.messages = this.data.messages.filter((message) => message.id !== localMessageId);
      await saveData(this.data);
      return;
    }
    const localIndex = this.data.messages.findIndex((message) => message.id === localMessageId);
    if (localIndex >= 0) {
      this.data.messages[localIndex] = replacement;
    } else {
      this.data.messages.push(replacement);
    }
    await saveData(this.data);
  }

  async sendMessage(channelName: string, text: string, threadRootId?: string, source: "chat" | "terminal" = "terminal"): Promise<ThaneMessage> {
    const channel = this.findChannel(channelName) ?? (await this.createChannel(channelName));
    if (!this.canReadChannel(channel)) {
      throw new Error(`Channel ${channelName} was not found.`);
    }
    if (channel.visibility === "private" && !this.isJoinedChannel(channel)) {
      throw new Error(`You are not a member of #${channel.name}.`);
    }
    if (channel.visibility === "public" && !this.isJoinedChannel(channel)) {
      channel.memberIds.push(this.currentUser.id);
    }
    const message: ThaneMessage = {
      id: id("msg"),
      workspaceId: this.activeWorkspace.id,
      channelId: channel.id,
      authorId: this.currentUser.id,
      text,
      createdAt: nowIso(),
      source,
      ...(threadRootId ? { threadRootId } : {}),
      reactions: [],
      mentions: extractMentions(text)
    };
    this.data.messages.push(message);
    this.maybeRespondAsAskThane(channel, message);
    await saveData(this.data);
    return message;
  }

  private maybeRespondAsAskThane(channel: ThaneChannel, message: ThaneMessage): void {
    const integration = this.askThaneStatus();
    if (!integration?.enabled || !message.mentions.includes("thane") || message.authorId === integration.botUserId) {
      return;
    }
    const requestedLocation = parsePingLocationRequest(message.text);
    let responseText =
      "Ask Thane is connected for this workspace. In the hosted backend, this mention will run the same task/memory agent used from Slack, linked by your account email.";
    if (requestedLocation && this.currentAccount) {
      let preference = this.data.notificationPreferences.find((candidate) => candidate.accountId === this.currentAccount?.id);
      if (!preference) {
        preference = {
          accountId: this.currentAccount.id,
          preferredPingLocation: requestedLocation,
          updatedAt: nowIso(),
          updatedBy: "ask_thane"
        };
        this.data.notificationPreferences.push(preference);
      } else {
        preference.preferredPingLocation = requestedLocation;
        preference.updatedAt = nowIso();
        preference.updatedBy = "ask_thane";
      }
      responseText = `Done. I will ping you in ${describePingLocation(requestedLocation)}.`;
    }

    const response: ThaneMessage = {
      id: id("msg"),
      workspaceId: this.activeWorkspace.id,
      channelId: channel.id,
      authorId: integration.botUserId,
      text: responseText,
      createdAt: nowIso(),
      source: "terminal",
      ...(message.threadRootId ? { threadRootId: message.threadRootId } : { threadRootId: message.id }),
      reactions: [],
      mentions: []
    };
    integration.lastEventAt = response.createdAt;
    this.data.messages.push(response);
  }

  async sendDm(handle: string, text: string, source: "chat" | "terminal" = "terminal"): Promise<ThaneMessage> {
    const channel = await this.findOrCreateDm(handle);
    return this.sendMessage(channel.id, text, undefined, source);
  }

  async reply(messageId: string, text: string, source: "chat" | "terminal" = "terminal"): Promise<ThaneMessage> {
    const root = this.data.messages.find((message) => message.workspaceId === this.activeWorkspace.id && message.id === messageId);
    if (!root) {
      throw new Error(`Message ${messageId} was not found.`);
    }
    return this.sendMessage(root.channelId, text, root.threadRootId ?? root.id, source);
  }

  async react(messageId: string, emoji: string): Promise<ThaneMessage> {
    const message = this.data.messages.find((candidate) => candidate.workspaceId === this.activeWorkspace.id && candidate.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} was not found.`);
    }
    message.reactions.push({ emoji, by: this.currentUser.handle, createdAt: nowIso() });
    await saveData(this.data);
    return message;
  }

  async markRead(channelName: string): Promise<ThaneReadState> {
    const channel = this.requireChannel(channelName);
    return this.markReadConversation(channel.id);
  }

  async markReadConversation(conversationId: string): Promise<ThaneReadState> {
    const channel = this.data.channels.find(
      (candidate) => candidate.workspaceId === this.activeWorkspace.id && candidate.id === conversationId
    );
    if (!channel) {
      throw new Error(`Conversation ${conversationId} was not found.`);
    }
    const existing = this.data.readStates.find(
      (state) => state.workspaceId === this.activeWorkspace.id && state.channelId === channel.id && state.userId === this.currentUser.id
    );
    const state =
      existing ?? { workspaceId: this.activeWorkspace.id, channelId: channel.id, userId: this.currentUser.id, lastReadAt: nowIso() };
    state.lastReadAt = nowIso();
    if (!existing) {
      this.data.readStates.push(state);
    }
    await saveData(this.data);
    return state;
  }

  inbox(options: { allWorkspaces?: boolean; onlyUnread?: boolean; includeQuiet?: boolean } = {}): ConversationSummary[] {
    const workspaceIds = options.allWorkspaces
      ? this.data.workspaces.map((workspace) => workspace.id)
      : [this.activeWorkspace.id];
    const workspaces = new Map(this.data.workspaces.map((workspace) => [workspace.id, workspace]));
    const users = new Map(this.data.users.map((user) => [user.id, user]));
    const readStates = new Map(
      this.data.readStates.map((state) => [`${state.workspaceId}:${state.channelId}:${state.userId}`, state.lastReadAt])
    );

    const summaries: ConversationSummary[] = [];
    for (const channel of this.data.channels.filter((candidate) => workspaceIds.includes(candidate.workspaceId))) {
      const workspace = workspaces.get(channel.workspaceId);
      const localUser = this.currentUserForWorkspace(channel.workspaceId);
      if (!workspace || !localUser || !channel.memberIds.includes(localUser.id)) {
        const isReadablePublic = channel.visibility === "public" && Boolean(localUser);
        if (!workspace || !localUser || !isReadablePublic) {
          continue;
        }
      }

      if (channel.visibility === "private" && !channel.memberIds.includes(localUser.id)) {
        continue;
      }

      const messages = this.data.messages
        .filter((message) => message.workspaceId === channel.workspaceId && message.channelId === channel.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const latest = messages.at(-1);
      const readAt = readStates.get(`${channel.workspaceId}:${channel.id}:${localUser.id}`);
      const unread = messages.filter((message) => message.authorId !== localUser.id && (!readAt || message.createdAt > readAt));
      const mentionCount = unread.filter((message) => message.mentions.includes(localUser.handle.toLowerCase())).length;
      const isJoined = channel.memberIds.includes(localUser.id);
      const inboxUnread = isJoined ? unread.length : mentionCount;
      const hasSignal = inboxUnread > 0 || mentionCount > 0 || options.includeQuiet;
      if (options.onlyUnread && inboxUnread === 0) {
        continue;
      }
      if (!hasSignal) {
        continue;
      }

      summaries.push({
        workspace: workspace.slug,
        workspaceId: workspace.id,
        conversationId: channel.id,
        conversation: channel.kind === "dm" ? this.dmDisplayLabel(channel, localUser.id) : channel.name,
        conversationKind: channel.kind,
        unreadCount: inboxUnread,
        mentionCount,
        ...(latest ? { latestMessageAt: latest.createdAt } : {}),
        ...(latest ? { latestAuthor: userDisplayLabel(users.get(latest.authorId), latest.authorId) } : {}),
        ...(latest ? { latestText: latest.text } : {})
      });
    }

    return summaries.sort((a, b) => (b.latestMessageAt ?? "").localeCompare(a.latestMessageAt ?? ""));
  }

  recent(channelName?: string, limit = 20, since?: Date): MessageView[] {
    const channel = channelName ? this.requireChannel(channelName) : undefined;
    return this.toViews(
      this.data.messages
        .filter((message) => message.workspaceId === this.activeWorkspace.id)
        .filter((message) => !channel || message.channelId === channel.id)
        .filter((message) => {
          const messageChannel = this.data.channels.find((candidate) => candidate.id === message.channelId);
          return Boolean(messageChannel && this.canReadChannel(messageChannel));
        })
        .filter((message) => !since || new Date(message.createdAt).getTime() >= since.getTime())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-limit)
    );
  }

  exportMessages(options: {
    channelName?: string;
    allWorkspaces?: boolean;
    limit?: number;
    since?: Date;
  } = {}): MessageView[] {
    const limit = options.limit ?? 10_000;
    const workspaces = options.allWorkspaces
      ? this.data.workspaces.filter((workspace) => this.memberForWorkspace(workspace.id))
      : [this.activeWorkspace];
    const views: MessageView[] = [];

    for (const workspace of workspaces) {
      const member = this.memberForWorkspace(workspace.id);
      const userId = member?.userId ?? this.currentUser.id;
      const channel = options.channelName
        ? this.findChannelInWorkspace(workspace.id, options.channelName, userId)
        : undefined;
      if (options.channelName && !channel) {
        continue;
      }
      const messages = this.data.messages
        .filter((message) => message.workspaceId === workspace.id)
        .filter((message) => !channel || message.channelId === channel.id)
        .filter((message) => {
          const messageChannel = this.data.channels.find((candidate) => candidate.id === message.channelId);
          return Boolean(messageChannel && this.canReadWorkspaceChannel(messageChannel, workspace.id, userId));
        })
        .filter((message) => !options.since || new Date(message.createdAt).getTime() >= options.since.getTime());
      views.push(...this.toWorkspaceViews(messages, workspace.id, userId));
    }

    if (options.channelName && views.length === 0) {
      throw new Error(`Channel ${options.channelName} was not found in readable exported workspaces.`);
    }
    return views.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit);
  }

  recentDm(handle: string, limit = 20, since?: Date): MessageView[] {
    const user = this.findUser(handle);
    if (!user) {
      throw new Error(`User ${handle} was not found. Add them with: thane user add ${handle}`);
    }
    const channel = this.data.channels.find(
      (candidate) =>
        candidate.workspaceId === this.activeWorkspace.id &&
        candidate.kind === "dm" &&
        candidate.memberIds.includes(this.currentUser.id) &&
        candidate.memberIds.includes(user.id)
    );
    if (!channel) {
      return [];
    }
    return this.recent(channel.id, limit, since);
  }

  mentions(limit = 20, since?: Date): MessageView[] {
    const handle = this.currentUser.handle.toLowerCase();
    const displayName = this.currentUser.displayName.toLowerCase();
    return this.toViews(
      this.data.messages
        .filter((message) => message.workspaceId === this.activeWorkspace.id)
        .filter((message) => {
          const channel = this.data.channels.find((candidate) => candidate.id === message.channelId);
          return Boolean(channel && this.canReadChannel(channel));
        })
        .filter(
          (message) =>
            message.mentions.includes(handle) ||
            message.text.toLowerCase().includes(`@${displayName}`) ||
            message.text.toLowerCase().includes(displayName)
        )
        .filter((message) => !since || new Date(message.createdAt).getTime() >= since.getTime())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-limit)
    );
  }

  unread(limit = 50): MessageView[] {
    const byChannel = new Map(
      this.data.readStates
        .filter((state) => state.workspaceId === this.activeWorkspace.id)
        .map((state) => [state.channelId, state.lastReadAt])
    );
    return this.toViews(
      this.data.messages
        .filter((message) => message.workspaceId === this.activeWorkspace.id)
        .filter((message) => message.authorId !== this.currentUser.id)
        .filter((message) => {
          const channel = this.data.channels.find((candidate) => candidate.id === message.channelId);
          if (!channel || !this.canReadChannel(channel)) {
            return false;
          }
          return channel.memberIds.includes(this.currentUser.id) || message.mentions.includes(this.currentUser.handle.toLowerCase());
        })
        .filter((message) => {
          const readAt = byChannel.get(message.channelId);
          return !readAt || message.createdAt > readAt;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-limit)
    );
  }

  search(query: string, limit = 20): MessageView[] {
    const needle = query.toLowerCase();
    return this.toViews(
      this.data.messages
        .filter((message) => message.workspaceId === this.activeWorkspace.id)
        .filter((message) => {
          const channel = this.data.channels.find((candidate) => candidate.id === message.channelId);
          return Boolean(channel && this.canReadChannel(channel));
        })
        .filter((message) => message.text.toLowerCase().includes(needle))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-limit)
    );
  }

  thread(rootId: string): MessageView[] {
    const root = this.data.messages.find((message) => message.workspaceId === this.activeWorkspace.id && message.id === rootId);
    if (!root) {
      throw new Error(`Message ${rootId} was not found.`);
    }
    const rootChannel = this.data.channels.find((channel) => channel.id === root.channelId);
    if (!rootChannel || !this.canReadChannel(rootChannel)) {
      throw new Error(`Message ${rootId} was not found.`);
    }
    const realRootId = root.threadRootId ?? root.id;
    return this.toViews(
      this.data.messages
        .filter((message) => message.workspaceId === this.activeWorkspace.id)
        .filter((message) => message.id === realRootId || message.threadRootId === realRootId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    );
  }

  private requireChannel(nameOrId: string): ThaneChannel {
    const channel = this.findChannel(nameOrId);
    if (!channel) {
      throw new Error(`Channel ${nameOrId} was not found. Create it with: thane channel create ${nameOrId}`);
    }
    return channel;
  }

  private toViews(messages: ThaneMessage[]): MessageView[] {
    return this.toWorkspaceViews(messages, this.activeWorkspace.id, this.currentUser.id);
  }

  private toWorkspaceViews(messages: ThaneMessage[], workspaceId: string, userId: string): MessageView[] {
    const workspace = this.data.workspaces.find((candidate) => candidate.id === workspaceId);
    const channels = new Map(
      this.data.channels
        .filter((channel) => channel.workspaceId === workspaceId)
        .map((channel) => [channel.id, channel])
    );
    const users = new Map(this.data.users.filter((user) => user.workspaceId === workspaceId).map((user) => [user.id, user]));
    const repliesByRoot = new Map<string, number>();
    for (const message of this.data.messages) {
      if (message.workspaceId === workspaceId && message.threadRootId) {
        repliesByRoot.set(message.threadRootId, (repliesByRoot.get(message.threadRootId) ?? 0) + 1);
      }
    }
    const handle = this.data.users.find((user) => user.id === userId)?.handle.toLowerCase() ?? "";
    return messages.map((message) => {
      const channel = channels.get(message.channelId);
      return {
        id: message.id,
        workspace: workspace?.slug ?? workspaceId,
        channel: channel ? (channel.kind === "dm" ? this.dmDisplayLabel(channel, userId) : channel.name) : message.channelId,
        conversationKind: channel?.kind ?? "channel",
        author: userDisplayLabel(users.get(message.authorId), message.authorId),
        text: message.text,
        createdAt: message.createdAt,
        ...(message.source ? { source: message.source } : {}),
        ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
        replyCount: repliesByRoot.get(message.id) ?? 0,
        reactions: message.reactions,
        mentions: message.mentions,
        mentionsMe: message.mentions.includes(handle)
      };
    });
  }
}
