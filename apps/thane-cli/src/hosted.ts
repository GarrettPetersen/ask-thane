import { ThaneStore } from "./store.js";
import type {
  ThaneAccount,
  ThaneChannel,
  ThaneMessage,
  ThaneUser,
  ThaneWorkspace,
  ThaneWorkspaceMember
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

export function hasHostedChat(store: ThaneStore): boolean {
  return Boolean(hostedBaseUrl() && authToken(store));
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
  if (!response.ok) {
    throw new Error(`Thane API returned ${response.status}: ${JSON.stringify(await response.json())}`);
  }
  return (await response.json()) as T;
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
  if (!response.ok) {
    throw new Error(`Thane API returned ${response.status}: ${JSON.stringify(await response.json())}`);
  }
  return (await response.json()) as T;
}

export async function syncHostedStore(store: ThaneStore, options: { workspaceId?: string } = {}): Promise<boolean> {
  if (!hasHostedChat(store)) {
    return false;
  }
  const workspaceId = encodeURIComponent(options.workspaceId ?? store.activeWorkspace.id);
  const snapshot = await getHosted<HostedSyncSnapshot>(store, `/v1/thane-cli/sync?workspaceId=${workspaceId}`);
  await store.applyHostedSnapshot(snapshot);
  return true;
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

export async function sendHostedMessage(
  store: ThaneStore,
  input: { channelId: string; text: string; source?: "chat" | "terminal"; threadRootId?: string }
): Promise<void> {
  await postHosted(store, "/v1/thane-cli/messages", {
    workspaceId: store.activeWorkspace.id,
    channelId: input.channelId,
    text: input.text,
    source: input.source ?? "terminal",
    ...(input.threadRootId ? { threadRootId: input.threadRootId } : {})
  });
  await syncHostedStore(store);
}

export async function reactHostedMessage(store: ThaneStore, input: { messageId: string; emoji: string }): Promise<void> {
  await postHosted(store, "/v1/thane-cli/reactions", {
    workspaceId: store.activeWorkspace.id,
    messageId: input.messageId,
    emoji: input.emoji
  });
  await syncHostedStore(store);
}
