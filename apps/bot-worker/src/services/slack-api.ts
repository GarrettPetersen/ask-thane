export interface SlackReaction {
  name?: string;
  users?: string[];
}

export interface SlackHistoryMessage {
  type?: string;
  subtype?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  reactions?: SlackReaction[];
}

interface SlackHistoryResponse {
  ok?: boolean;
  error?: string;
  messages?: SlackHistoryMessage[];
  response_metadata?: {
    next_cursor?: string;
  };
}

interface SlackOpenConversationResponse {
  ok?: boolean;
  error?: string;
  channel?: {
    id?: string;
  };
}

interface SlackPostMessageResponse {
  ok?: boolean;
  error?: string;
  channel?: string;
  ts?: string;
}

export async function fetchSlackConversationHistory(input: {
  botToken: string;
  channelId: string;
  oldestTs?: string;
  latestTs?: string;
  limit?: number;
  maxPages?: number;
}): Promise<SlackHistoryMessage[]> {
  const messages: SlackHistoryMessage[] = [];
  let cursor: string | null = null;
  const maxPages = Math.min(Math.max(input.maxPages ?? 3, 1), 20);
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  let pages = 0;

  do {
    const params = new URLSearchParams({
      channel: input.channelId,
      limit: String(limit),
      inclusive: "false"
    });
    if (input.oldestTs) {
      params.set("oldest", input.oldestTs);
    }
    if (input.latestTs) {
      params.set("latest", input.latestTs);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetch(`https://slack.com/api/conversations.history?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${input.botToken}`
      }
    });
    if (!response.ok) {
      throw new Error(`slack_history_http_error:${response.status}`);
    }

    const payload = (await response.json()) as SlackHistoryResponse;
    if (!payload.ok) {
      throw new Error(`slack_history_error:${payload.error ?? "unknown"}`);
    }

    for (const message of payload.messages ?? []) {
      messages.push(message);
    }

    pages += 1;
    cursor = payload.response_metadata?.next_cursor?.trim() || null;
    if (pages >= maxPages) {
      break;
    }
  } while (cursor);

  messages.sort((a, b) => Number(a.ts ?? "0") - Number(b.ts ?? "0"));
  return messages;
}

export async function openSlackDirectMessage(input: {
  botToken: string;
  userId: string;
}): Promise<{ channelId: string }> {
  const body = new URLSearchParams({
    users: input.userId
  });

  const response = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.botToken}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`slack_open_dm_http_error:${response.status}`);
  }

  const payload = (await response.json()) as SlackOpenConversationResponse;
  if (!payload.ok || !payload.channel?.id) {
    throw new Error(`slack_open_dm_error:${payload.error ?? "unknown"}`);
  }

  return { channelId: payload.channel.id };
}

export async function postSlackMessage(input: {
  botToken: string;
  channelId: string;
  text: string;
}): Promise<{ channelId: string; ts: string }> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.botToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel: input.channelId,
      text: input.text
    })
  });

  if (!response.ok) {
    throw new Error(`slack_post_message_http_error:${response.status}`);
  }

  const payload = (await response.json()) as SlackPostMessageResponse;
  if (!payload.ok || !payload.channel || !payload.ts) {
    throw new Error(`slack_post_message_error:${payload.error ?? "unknown"}`);
  }

  return {
    channelId: payload.channel,
    ts: payload.ts
  };
}
