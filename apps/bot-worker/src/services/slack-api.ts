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

interface SlackSingleMessageLookupResult {
  message: SlackHistoryMessage | null;
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

interface SlackAddReactionResponse {
  ok?: boolean;
  error?: string;
}

interface SlackUserProfileResponse {
  ok?: boolean;
  error?: string;
  user?: {
    id?: string;
    team_id?: string;
    is_stranger?: boolean;
    deleted?: boolean;
    is_bot?: boolean;
    name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  };
}

interface SlackUsersListResponse {
  ok?: boolean;
  error?: string;
  members?: Array<{
    id?: string;
    team_id?: string;
    is_stranger?: boolean;
    deleted?: boolean;
    is_bot?: boolean;
    name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  }>;
  response_metadata?: {
    next_cursor?: string;
  };
}

export interface SlackWorkspaceUserProfile {
  id: string;
  teamId?: string;
  isStranger?: boolean;
  displayName?: string;
  email?: string;
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

export async function fetchSlackThreadReplies(input: {
  botToken: string;
  channelId: string;
  threadTs: string;
  oldestTs?: string;
  latestTs?: string;
  limit?: number;
  maxPages?: number;
}): Promise<SlackHistoryMessage[]> {
  const messages: SlackHistoryMessage[] = [];
  let cursor: string | null = null;
  const maxPages = Math.min(Math.max(input.maxPages ?? 3, 1), 20);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  let pages = 0;

  do {
    const params = new URLSearchParams({
      channel: input.channelId,
      ts: input.threadTs,
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

    const response = await fetch(`https://slack.com/api/conversations.replies?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${input.botToken}`
      }
    });
    if (!response.ok) {
      throw new Error(`slack_thread_replies_http_error:${response.status}`);
    }

    const payload = (await response.json()) as SlackHistoryResponse;
    if (!payload.ok) {
      throw new Error(`slack_thread_replies_error:${payload.error ?? "unknown"}`);
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
  threadTs?: string;
}): Promise<{ channelId: string; ts: string }> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.botToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel: input.channelId,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {})
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

export async function fetchSlackMessageByTs(input: {
  botToken: string;
  channelId: string;
  messageTs: string;
}): Promise<SlackSingleMessageLookupResult> {
  const params = new URLSearchParams({
    channel: input.channelId,
    oldest: input.messageTs,
    latest: input.messageTs,
    inclusive: "true",
    limit: "1"
  });

  const response = await fetch(`https://slack.com/api/conversations.history?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${input.botToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`slack_message_lookup_http_error:${response.status}`);
  }

  const payload = (await response.json()) as SlackHistoryResponse;
  if (!payload.ok) {
    throw new Error(`slack_message_lookup_error:${payload.error ?? "unknown"}`);
  }

  return {
    message: (payload.messages ?? [])[0] ?? null
  };
}

export async function addSlackReaction(input: {
  botToken: string;
  channelId: string;
  messageTs: string;
  reaction: string;
}): Promise<void> {
  const body = new URLSearchParams({
    channel: input.channelId,
    timestamp: input.messageTs,
    name: input.reaction
  });

  const response = await fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.botToken}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`slack_reaction_http_error:${response.status}`);
  }

  const payload = (await response.json()) as SlackAddReactionResponse;
  if (!payload.ok && payload.error !== "already_reacted") {
    throw new Error(`slack_reaction_error:${payload.error ?? "unknown"}`);
  }
}

export async function fetchSlackUserProfile(input: {
  botToken: string;
  userId: string;
}): Promise<SlackWorkspaceUserProfile | null> {
  const params = new URLSearchParams({ user: input.userId });
  const response = await fetch(`https://slack.com/api/users.info?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${input.botToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`slack_user_info_http_error:${response.status}`);
  }

  const payload = (await response.json()) as SlackUserProfileResponse;
  if (!payload.ok) {
    throw new Error(`slack_user_info_error:${payload.error ?? "unknown"}`);
  }
  if (!payload.user?.id || payload.user.deleted || payload.user.is_bot) {
    return null;
  }

  const displayName =
    payload.user.profile?.display_name?.trim() ||
    payload.user.profile?.real_name?.trim() ||
    payload.user.name?.trim() ||
    undefined;
  const email = payload.user.profile?.email?.trim() || undefined;

  return {
    id: payload.user.id,
    ...(payload.user.team_id?.trim() ? { teamId: payload.user.team_id.trim() } : {}),
    ...(payload.user.is_stranger === true ? { isStranger: true } : {}),
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {})
  };
}

export async function listSlackWorkspaceUsers(input: {
  botToken: string;
  limit?: number;
  maxPages?: number;
}): Promise<SlackWorkspaceUserProfile[]> {
  const users: SlackWorkspaceUserProfile[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 200);
  const maxPages = Math.min(Math.max(input.maxPages ?? 10, 1), 100);
  let pages = 0;

  do {
    const params = new URLSearchParams({
      limit: String(limit)
    });
    if (cursor) {
      params.set("cursor", cursor);
    }

    const response = await fetch(`https://slack.com/api/users.list?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${input.botToken}`
      }
    });
    if (!response.ok) {
      throw new Error(`slack_users_list_http_error:${response.status}`);
    }

    const payload = (await response.json()) as SlackUsersListResponse;
    if (!payload.ok) {
      throw new Error(`slack_users_list_error:${payload.error ?? "unknown"}`);
    }

    for (const member of payload.members ?? []) {
      const id = member.id?.trim();
      if (!id || member.deleted || member.is_bot || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const displayName = member.profile?.display_name?.trim() || member.profile?.real_name?.trim() || member.name?.trim() || undefined;
      const email = member.profile?.email?.trim() || undefined;
      users.push({
        id,
        ...(member.team_id?.trim() ? { teamId: member.team_id.trim() } : {}),
        ...(member.is_stranger === true ? { isStranger: true } : {}),
        ...(displayName ? { displayName } : {}),
        ...(email ? { email } : {})
      });
    }

    pages += 1;
    cursor = payload.response_metadata?.next_cursor?.trim() || null;
    if (pages >= maxPages) {
      break;
    }
  } while (cursor);

  return users;
}
