import type { BotEnv } from "./task-inference";

interface ThaneChatWebhookMessageResponse {
  ok?: boolean;
  error?: string;
  message?: {
    id?: string;
    channelId?: string;
  };
}

interface ThaneChatWebhookReactionResponse {
  ok?: boolean;
  error?: string;
}

interface ThaneChatWebhookHistoryResponse {
  ok?: boolean;
  error?: string;
  messages?: ThaneChatWebhookHistoryMessage[];
}

export interface ThaneChatWebhookHistoryMessage {
  id: string;
  channelId: string;
  authorHandle?: string;
  text?: string;
  threadRootId?: string;
  reactions?: Array<{ emoji: string; by: string; createdAt: string }>;
}

function thaneChatApiBaseUrl(env: BotEnv): string {
  const configured = env.TASKS_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/g, "");
  }
  if (env.BUILD_ENV === "staging") {
    return "https://api-staging.askthane.com";
  }
  return "https://api.askthane.com";
}

async function hmacSha256Bytes(value: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
}

function base64UrlEncode(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function askThaneWebhookTokenSecret(env: BotEnv): string {
  const configured = env.INTERNAL_API_BEARER_TOKEN?.trim();
  if (configured) {
    return configured;
  }
  if (env.BUILD_ENV === "production") {
    throw new Error("INTERNAL_API_BEARER_TOKEN is required for Ask Thane webhook tokens in production.");
  }
  return "thane-local-dev-app-token-secret";
}

export async function deriveAskThaneWebhookToken(env: BotEnv, webhookId: string): Promise<string> {
  return `twk_ask_${base64UrlEncode(await hmacSha256Bytes(`ask-thane-webhook:${webhookId}`, askThaneWebhookTokenSecret(env)))}`;
}

export async function getAskThaneWebhookId(env: BotEnv, workspaceId: string): Promise<string | null> {
  const row = await env.DB
    .prepare("SELECT id FROM thane_cli_webhooks WHERE workspace_id = ? AND name = 'Ask Thane' AND status = 'active' LIMIT 1")
    .bind(workspaceId)
    .first<{ id?: string }>();
  return row?.id ?? null;
}

async function resolveWebhookId(env: BotEnv, input: { webhookId?: string; workspaceId?: string }): Promise<string> {
  if (input.webhookId) {
    return input.webhookId;
  }
  if (!input.workspaceId) {
    throw new Error("thane_chat_webhook_id_required");
  }
  const webhookId = await getAskThaneWebhookId(env, input.workspaceId);
  if (!webhookId) {
    throw new Error("ask_thane_webhook_not_enabled");
  }
  return webhookId;
}

export async function postThaneChatWebhookMessage(input: {
  env: BotEnv;
  webhookId?: string;
  workspaceId?: string;
  channelId?: string;
  channelName?: string;
  dmTarget?: string;
  text: string;
  threadRootId?: string | null;
}): Promise<{ messageId?: string; channelId?: string }> {
  const webhookId = await resolveWebhookId(input.env, input);
  const response = await fetch(`${thaneChatApiBaseUrl(input.env)}/v1/thane-cli/webhooks/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await deriveAskThaneWebhookToken(input.env, webhookId)}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.channelName ? { channelName: input.channelName } : {}),
      ...(input.dmTarget ? { dmTarget: input.dmTarget } : {}),
      text: input.text,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {})
    })
  });
  const payload = (await response.json().catch(() => ({}))) as ThaneChatWebhookMessageResponse;
  if (!response.ok) {
    throw new Error(`webhook_message_failed:${response.status}:${payload.error ?? "unknown"}`);
  }
  return {
    ...(payload.message?.id ? { messageId: payload.message.id } : {}),
    ...(payload.message?.channelId ? { channelId: payload.message.channelId } : {})
  };
}

export async function postThaneChatWebhookReaction(input: {
  env: BotEnv;
  webhookId?: string;
  workspaceId?: string;
  messageId: string;
  emoji: string;
}): Promise<void> {
  const webhookId = await resolveWebhookId(input.env, input);
  const response = await fetch(`${thaneChatApiBaseUrl(input.env)}/v1/thane-cli/webhooks/reactions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await deriveAskThaneWebhookToken(input.env, webhookId)}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      messageId: input.messageId,
      emoji: input.emoji
    })
  });
  const payload = (await response.json().catch(() => ({}))) as ThaneChatWebhookReactionResponse;
  if (!response.ok) {
    throw new Error(`webhook_reaction_failed:${response.status}:${payload.error ?? "unknown"}`);
  }
}

export async function fetchThaneChatWebhookMessages(input: {
  env: BotEnv;
  webhookId?: string;
  workspaceId?: string;
  channelId: string;
  limit: number;
  threadRootId?: string | null;
}): Promise<ThaneChatWebhookHistoryMessage[]> {
  const webhookId = await resolveWebhookId(input.env, input);
  const url = new URL(`${thaneChatApiBaseUrl(input.env)}/v1/thane-cli/webhooks/messages`);
  url.searchParams.set("channelId", input.channelId);
  url.searchParams.set("limit", String(input.limit));
  if (input.threadRootId) {
    url.searchParams.set("threadRootId", input.threadRootId);
  }
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      authorization: `Bearer ${await deriveAskThaneWebhookToken(input.env, webhookId)}`
    }
  });
  const payload = (await response.json().catch(() => ({}))) as ThaneChatWebhookHistoryResponse;
  if (!response.ok) {
    throw new Error(`webhook_history_failed:${response.status}:${payload.error ?? "unknown"}`);
  }
  return payload.messages ?? [];
}
