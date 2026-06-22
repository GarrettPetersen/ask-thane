import { ThaneStore } from "./store.js";
import type {
  AskThaneIntegration,
  NotificationPreference,
  ThaneAccount,
  ThaneChannel,
  ThaneMessage,
  ThaneReadState,
  ThaneUser,
  ThaneWorkspace,
  ThaneWorkspaceMember,
  WorkspaceBillingPlan
} from "./model.js";

export interface HostedSyncSnapshot {
  ok: boolean;
  account?: ThaneAccount;
  activeWorkspaceId?: string | null;
  workspaces: ThaneWorkspace[];
  workspaceMembers: ThaneWorkspaceMember[];
  users: ThaneUser[];
  channels: ThaneChannel[];
  messages: ThaneMessage[];
  readStates?: ThaneReadState[];
  unreadCounts?: Array<{ workspaceId: string; channelId: string; unreadCount: number; mentionCount: number }>;
  workspaceUnreadCounts?: Array<{ workspaceId: string; unreadCount: number; mentionCount: number }>;
  askThaneIntegrations?: AskThaneIntegration[];
  notificationPreferences?: NotificationPreference[];
  billingPlans?: WorkspaceBillingPlan[];
}

export interface HostedBillingLink {
  workspaceId: string;
  planTier: "free" | "cli_team";
  targetPlanTier: "cli_team";
  checkoutUrl: string;
  portalUrl: string;
  expiresAt: string;
}

export interface HostedChatEvent {
  type: "connected" | "message_created" | "reaction_created" | "workspace_changed";
  workspaceId?: string;
  channelId?: string;
  messageId?: string;
  occurredAt?: string;
}

function hostedBaseUrl(): string | undefined {
  const value = process.env.THANE_API_BASE_URL?.trim();
  if (value === "local" || value === "none") {
    return undefined;
  }
  return (value || "https://api.askthane.com").replace(/\/+$/g, "");
}

function authToken(store: ThaneStore): string | undefined {
  return store.currentAccount?.authToken;
}

function realtimeEnabled(): boolean {
  return process.env.THANE_ENABLE_REALTIME !== "0";
}

function hostedEventsUrl(store: ThaneStore, workspaceId: string): string {
  const baseUrl = hostedBaseUrl();
  const token = authToken(store);
  if (!baseUrl || !token) {
    throw new Error("Run `thane init` with hosted auth before using hosted chat.");
  }
  const params = new URLSearchParams({ workspaceId, authToken: token });
  return `${baseUrl}/v1/thane-cli/events?${params}`;
}

export function hasHostedChat(store: ThaneStore): boolean {
  return Boolean(hostedBaseUrl() && authToken(store));
}

function hostedApiError(payload: { error?: string; retryAfterSeconds?: number }, status: number): string {
  if (payload.error === "rate_limited" && payload.retryAfterSeconds) {
    return `rate_limited: try again in ${payload.retryAfterSeconds}s`;
  }
  return payload.error ?? `Thane API returned ${status}`;
}

async function getHosted<T>(store: ThaneStore, path: string): Promise<T> {
  const baseUrl = hostedBaseUrl();
  const token = authToken(store);
  if (!baseUrl || !token) {
    throw new Error("Run `thane init` with hosted auth before using hosted chat.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; retryAfterSeconds?: number } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(hostedApiError(payload, response.status));
  }
  return payload;
}

async function postHosted<T>(store: ThaneStore, path: string, body: Record<string, unknown>): Promise<T> {
  const baseUrl = hostedBaseUrl();
  const token = authToken(store);
  if (!baseUrl || !token) {
    throw new Error("Run `thane init` with hosted auth before using hosted chat.");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; retryAfterSeconds?: number } & T;
  if (!response.ok || payload.ok === false) {
    throw new Error(hostedApiError(payload, response.status));
  }
  return payload;
}

export async function syncHostedStore(store: ThaneStore, options: { workspaceId?: string } = {}): Promise<boolean> {
  if (!hasHostedChat(store)) {
    return false;
  }
  const workspaceId = options.workspaceId ?? store.activeWorkspaceId;
  const path = workspaceId ? `/v1/thane-cli/sync?workspaceId=${encodeURIComponent(workspaceId)}` : "/v1/thane-cli/sync";
  const snapshot = await getHosted<HostedSyncSnapshot>(store, path);
  await store.applyHostedSnapshot(snapshot);
  return true;
}

export function watchHostedWorkspaceEvents(
  store: ThaneStore,
  input: {
    workspaceId?: string;
    onEvent: (event: HostedChatEvent) => void;
    onStatus?: (status: "connecting" | "live" | "closed" | "unavailable") => void;
  }
): { close: () => void } {
  if (!realtimeEnabled()) {
    input.onStatus?.("unavailable");
    return { close: () => {} };
  }
  if (!hasHostedChat(store) || typeof fetch === "undefined" || typeof AbortController === "undefined") {
    input.onStatus?.("unavailable");
    return { close: () => {} };
  }
  const workspaceId = input.workspaceId ?? store.activeWorkspaceId;
  if (!workspaceId) {
    input.onStatus?.("unavailable");
    return { close: () => {} };
  }
  const controller = new AbortController();
  let closed = false;
  let backoffMs = 1000;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);
      controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
    });

  const readEventStream = async (): Promise<void> => {
    const response = await fetch(hostedEventsUrl(store, workspaceId), {
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`Thane events returned ${response.status}`);
    }
    input.onStatus?.("live");
    backoffMs = 1000;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!closed) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        const data = rawEvent
          .split(/\r?\n/g)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (data) {
          try {
            input.onEvent(JSON.parse(data) as HostedChatEvent);
          } catch (_error) {
            // Ignore malformed push events; fallback polling still keeps the cache fresh.
          }
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  };

  void (async () => {
    while (!closed) {
      input.onStatus?.("connecting");
      try {
        await readEventStream();
      } catch (_error) {
        if (closed) {
          break;
        }
      }
      if (!closed) {
        input.onStatus?.("closed");
        await wait(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  })();

  return {
    close: () => {
      closed = true;
      controller.abort();
    }
  };
}

export async function createHostedWorkspace(
  store: ThaneStore,
  input: { workspaceId: string; name: string; slug?: string; asciiArt?: string }
): Promise<void> {
  await postHosted(store, "/v1/thane-cli/workspaces", {
    workspaceId: input.workspaceId,
    workspaceName: input.name,
    ...(input.slug ? { workspaceSlug: input.slug } : {}),
    ...(input.asciiArt ? { asciiArt: input.asciiArt } : {})
  });
  await syncHostedStore(store, { workspaceId: input.workspaceId });
}

export async function ensureHostedWorkspace(store: ThaneStore): Promise<void> {
  if (!hasHostedChat(store)) {
    return;
  }
  const workspace = store.activeWorkspace;
  await postHosted(store, "/v1/thane-cli/workspaces", {
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    workspaceName: workspace.name,
    ...(workspace.asciiArt ? { asciiArt: workspace.asciiArt } : {})
  });
  await syncHostedStore(store, { workspaceId: workspace.id });
}

export async function createHostedChannel(store: ThaneStore, input: { name: string; topic?: string; private?: boolean }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/channels", {
    workspaceId: store.activeWorkspace.id,
    name: input.name,
    ...(input.topic ? { topic: input.topic } : {}),
    ...(input.private ? { private: true } : {})
  });
  await syncHostedStore(store);
}

export async function joinHostedChannel(store: ThaneStore, input: { channelName: string }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/channels/join", {
    workspaceId: store.activeWorkspace.id,
    channelName: input.channelName
  });
  await syncHostedStore(store);
}

export async function leaveHostedChannel(store: ThaneStore, input: { channelName: string }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/channels/leave", {
    workspaceId: store.activeWorkspace.id,
    channelName: input.channelName
  });
  await syncHostedStore(store);
}

export async function addHostedChannelMember(store: ThaneStore, input: { channelName: string; target: string }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/channel-members/add", {
    workspaceId: store.activeWorkspace.id,
    channelName: input.channelName,
    target: input.target
  });
  await syncHostedStore(store);
}

export async function removeHostedChannelMember(store: ThaneStore, input: { channelName: string; target: string }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/channel-members/remove", {
    workspaceId: store.activeWorkspace.id,
    channelName: input.channelName,
    target: input.target
  });
  await syncHostedStore(store);
}

export async function leaveHostedWorkspace(store: ThaneStore): Promise<void> {
  const workspaceId = store.activeWorkspace.id;
  await postHosted(store, "/v1/thane-cli/workspaces/leave", { workspaceId });
  await syncHostedStore(store, {});
}

export async function removeHostedWorkspaceMember(store: ThaneStore, input: { target: string }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/workspace-members/remove", {
    workspaceId: store.activeWorkspace.id,
    target: input.target
  });
  await syncHostedStore(store);
}

export async function setHostedWorkspaceMemberRole(store: ThaneStore, input: { target: string; role: "admin" | "member" }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/workspace-members/role", {
    workspaceId: store.activeWorkspace.id,
    target: input.target,
    role: input.role
  });
  await syncHostedStore(store);
}

export async function banHostedWorkspaceMember(store: ThaneStore, input: { target: string; reason?: string }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/workspace-members/ban", {
    workspaceId: store.activeWorkspace.id,
    target: input.target,
    ...(input.reason ? { reason: input.reason } : {})
  });
  await syncHostedStore(store);
}

export async function unbanHostedWorkspaceMember(store: ThaneStore, input: { email: string }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/workspace-members/unban", {
    workspaceId: store.activeWorkspace.id,
    target: input.email
  });
  await syncHostedStore(store);
}

export async function createHostedBillingLink(store: ThaneStore, input: { returnUrl?: string } = {}): Promise<HostedBillingLink> {
  const response = await postHosted<{ ok: true; billing: HostedBillingLink }>(store, "/v1/thane-cli/billing/link", {
    workspaceId: store.activeWorkspace.id,
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {})
  });
  return response.billing;
}

export async function sendHostedMessage(
  store: ThaneStore,
  input: { channelId: string; text: string; source?: "chat" | "terminal"; threadRootId?: string }
): Promise<ThaneMessage> {
  const response = await postHosted<{ ok: true; message: ThaneMessage }>(store, "/v1/thane-cli/messages", {
    workspaceId: store.activeWorkspace.id,
    channelId: input.channelId,
    text: input.text,
    source: input.source ?? "terminal",
    ...(input.threadRootId ? { threadRootId: input.threadRootId } : {})
  });
  await syncHostedStore(store).catch(() => false);
  return response.message;
}

export async function sendHostedDm(
  store: ThaneStore,
  input: { target: string; text: string; source?: "chat" | "terminal" }
): Promise<ThaneMessage> {
  const response = await postHosted<{ ok: true; message: ThaneMessage }>(store, "/v1/thane-cli/messages", {
    workspaceId: store.activeWorkspace.id,
    dmTarget: input.target,
    text: input.text,
    source: input.source ?? "terminal"
  });
  await syncHostedStore(store).catch(() => false);
  return response.message;
}

export async function openHostedDm(store: ThaneStore, input: { target: string }): Promise<ThaneChannel> {
  const response = await postHosted<{ ok: true; channel: ThaneChannel }>(store, "/v1/thane-cli/dms/open", {
    workspaceId: store.activeWorkspace.id,
    target: input.target
  });
  await syncHostedStore(store).catch(() => false);
  return response.channel;
}

export async function reactHostedMessage(store: ThaneStore, input: { messageId: string; emoji: string }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/reactions", {
    workspaceId: store.activeWorkspace.id,
    messageId: input.messageId,
    emoji: input.emoji
  });
  await syncHostedStore(store);
}

export async function markHostedRead(store: ThaneStore, input: { channelId: string }): Promise<ThaneReadState> {
  const response = await postHosted<{ ok: true; readState: ThaneReadState }>(store, "/v1/thane-cli/read-states", {
    workspaceId: store.activeWorkspace.id,
    channelId: input.channelId
  });
  return response.readState;
}
