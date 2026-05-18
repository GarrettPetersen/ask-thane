import { D1TaskRepository } from "@ask-thane/data";
import {
  inferSlackConversationKind,
  normalizeSlackEvent,
  normalizeSlackMembershipEvent,
  type SlackEnvelope
} from "@ask-thane/integrations";
import { runConversationalAgentForSlackMessage } from "../services/agent-runtime";
import { addSlackReaction, fetchSlackMessageByTs, fetchSlackUserProfile, postSlackMessage } from "../services/slack-api";
import { mapAgentEventTypesToSlackReactions, mapTaskActionTypesToSlackReactions } from "../services/slack-task-reactions";
import type { BotEnv } from "../services/task-inference";
import { ConversationAccessResolver } from "../services/conversation-access";
import { OrgRegistry } from "../services/org-registry";
import { SlackInstallStore } from "../services/slack-install-store";
import { verifySlackRequestSignature } from "../services/slack-signature";

function resolveSlackEnterpriseId(payload: SlackEnvelope): string | undefined {
  const fromTopLevel = (payload as { enterprise_id?: unknown }).enterprise_id;
  if (typeof fromTopLevel === "string" && fromTopLevel.trim()) {
    return fromTopLevel.trim();
  }
  const fromContext = (payload as { context_enterprise_id?: unknown }).context_enterprise_id;
  if (typeof fromContext === "string" && fromContext.trim()) {
    return fromContext.trim();
  }
  const authorizations = (payload as { authorizations?: Array<Record<string, unknown>> }).authorizations;
  if (Array.isArray(authorizations) && authorizations.length > 0) {
    const fromAuth = authorizations[0]?.enterprise_id;
    if (typeof fromAuth === "string" && fromAuth.trim()) {
      return fromAuth.trim();
    }
  }
  return undefined;
}

async function resolveSlackInstall(input: {
  env: BotEnv;
  externalWorkspaceId: string;
}): Promise<{ botToken: string | null; botUserId?: string }> {
  const installStore = new SlackInstallStore(input.env.DB);
  const install = await installStore.getInstallByExternalWorkspaceId(input.externalWorkspaceId);
  if (install?.botToken) {
    return {
      botToken: install.botToken,
      ...(install.botUserId ? { botUserId: install.botUserId } : {})
    };
  }
  return { botToken: input.env.SLACK_BOT_TOKEN ?? null };
}

function resolveBotUserIdFromPayload(payload: SlackEnvelope): string | null {
  const eventUser =
    (payload.event && typeof payload.event.user === "string" ? payload.event.user : null) ?? null;
  const authorizations = (payload as { authorizations?: Array<Record<string, unknown>> }).authorizations;
  if (Array.isArray(authorizations) && authorizations.length > 0) {
    const fromAuth = authorizations[0]?.user_id;
    if (typeof fromAuth === "string" && fromAuth.trim()) {
      return fromAuth.trim();
    }
  }
  const fromAuthedUsers = (payload as { authed_users?: unknown }).authed_users;
  if (Array.isArray(fromAuthedUsers) && typeof fromAuthedUsers[0] === "string" && fromAuthedUsers[0].trim()) {
    return fromAuthedUsers[0].trim();
  }
  if (eventUser && eventUser.startsWith("U")) {
    return eventUser;
  }
  return null;
}

function isSlackAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("invalid_auth") || message.includes("not_authed");
}

function uniqueTokens(primary: string | null, fallback: string | undefined): string[] {
  const tokens: string[] = [];
  if (primary) {
    tokens.push(primary);
  }
  if (fallback && fallback !== primary) {
    tokens.push(fallback);
  }
  return tokens;
}

async function fetchAuthorProfile(input: {
  env: BotEnv;
  externalWorkspaceId: string;
  authorUserId: string;
}): Promise<{ displayName?: string; email?: string } | null> {
  const install = await resolveSlackInstall({
    env: input.env,
    externalWorkspaceId: input.externalWorkspaceId
  });
  const tokens = uniqueTokens(install.botToken, input.env.SLACK_BOT_TOKEN);
  for (const token of tokens) {
    try {
      const profile = await fetchSlackUserProfile({
        botToken: token,
        userId: input.authorUserId
      });
      if (!profile) {
        return null;
      }
      return {
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(profile.email ? { email: profile.email } : {})
      };
    } catch (error) {
      if (isSlackAuthError(error)) {
        continue;
      }
      console.warn("slack_author_profile_fetch_failed", {
        externalWorkspaceId: input.externalWorkspaceId,
        authorUserId: input.authorUserId,
        reason: error instanceof Error ? error.message : String(error)
      });
      break;
    }
  }
  return null;
}

async function shouldRespondToMessage(input: {
  env: BotEnv;
  payload: SlackEnvelope;
  externalWorkspaceId: string;
  channelId: string;
  messageTs: string;
  text: string;
  conversationKind: "public_channel" | "private_channel" | "group_dm" | "dm";
}): Promise<boolean> {
  if (input.payload.event?.type === "app_mention") {
    return true;
  }

  if (input.conversationKind === "dm") {
    return true;
  }

  const install = await resolveSlackInstall({
    env: input.env,
    externalWorkspaceId: input.externalWorkspaceId
  });
  const botUserId = install.botUserId ?? resolveBotUserIdFromPayload(input.payload);
  const botMentioned = Boolean(botUserId && input.text.includes(`<@${botUserId}>`));
  if (botMentioned) {
    return true;
  }

  const threadTs = (input.payload.event as { thread_ts?: string } | undefined)?.thread_ts?.trim();
  if (threadTs && threadTs !== input.messageTs && botUserId) {
    const tokens = uniqueTokens(install.botToken, input.env.SLACK_BOT_TOKEN);
    let lastReason: string | undefined;
    for (const token of tokens) {
      try {
        const parent = await fetchSlackMessageByTs({
          botToken: token,
          channelId: input.channelId,
          messageTs: threadTs
        });
        if (parent.message?.user === botUserId) {
          return true;
        }
        break;
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
        continue;
      }
    }
    if (lastReason) {
      console.warn("slack_parent_message_lookup_failed", {
        externalWorkspaceId: input.externalWorkspaceId,
        channelId: input.channelId,
        threadTs,
        reason: lastReason
      });
    }
  }

  return false;
}

async function processSlackEventsPayload(payload: SlackEnvelope & { type?: string; challenge?: string }, env: BotEnv): Promise<Response> {
  const externalWorkspaceId = payload.team_id;
  if (!externalWorkspaceId) {
    return Response.json({ ok: true, ignored: true, reason: "missing_team_id" }, { status: 202 });
  }

  const registry = new OrgRegistry(env.DB);
  const enterpriseId = resolveSlackEnterpriseId(payload);
  const workspaceRef = await registry.resolveOrCreateSlackWorkspace(
    enterpriseId
      ? { externalWorkspaceId, externalOrganizationId: enterpriseId }
      : { externalWorkspaceId }
  );
  const organizationId = workspaceRef.organizationId;

  const ingestRepo = new D1TaskRepository(env.DB);
  const potentialDuplicateMessageId =
    typeof payload.event?.ts === "string" && payload.event.ts.trim().length > 0 ? payload.event.ts.trim() : null;
  const potentialDuplicateChannelId =
    typeof payload.event?.channel === "string" && payload.event.channel.trim().length > 0 ? payload.event.channel.trim() : null;
  if (potentialDuplicateMessageId && potentialDuplicateChannelId) {
    const existingByMessage = await env.DB
      .prepare(
        `SELECT provider_event_id
         FROM ingest_events
         WHERE organization_id = ?
           AND provider = 'slack'
           AND channel_id = ?
           AND provider_message_id = ?
         LIMIT 1`
      )
      .bind(organizationId, potentialDuplicateChannelId, potentialDuplicateMessageId)
      .first<Record<string, unknown>>();
    if (existingByMessage?.provider_event_id) {
      return Response.json(
        {
          ok: true,
          deduped: true,
          reason: "duplicate_message_event"
        },
        { status: 200 }
      );
    }
  }
  const canonicalMessageEventId =
    typeof payload.event?.channel === "string" &&
    payload.event.channel.trim().length > 0 &&
    typeof payload.event?.ts === "string" &&
    payload.event.ts.trim().length > 0 &&
    (payload.event?.type === "app_mention" || payload.event?.type === "message")
      ? `slack_message:${payload.event.channel.trim()}:${payload.event.ts.trim()}`
      : null;
  const providerEventId =
    canonicalMessageEventId ??
    payload.event_id ??
    `${payload.event?.type ?? "unknown"}:${payload.event?.channel ?? "unknown"}:${payload.event?.ts ?? payload.event_time ?? "unknown"}`;
  const slackEventTs =
    typeof payload.event?.ts === "string" && payload.event.ts.trim().length > 0
      ? payload.event.ts.trim()
      : typeof payload.event_time === "number"
        ? String(payload.event_time)
        : undefined;
  const ingestInput = {
    id: crypto.randomUUID(),
    organizationId,
    provider: "slack",
    providerEventId,
    ...(payload.event?.type ? { eventType: payload.event.type } : {}),
    ...(payload.event?.subtype ? { eventSubtype: payload.event.subtype } : {}),
    ...(payload.event?.channel ? { channelId: payload.event.channel } : {}),
    ...(payload.event?.user ? { actorExternalUserId: payload.event.user } : {}),
    ...(slackEventTs ? { eventTs: slackEventTs } : {}),
    receivedAt: new Date().toISOString()
  } as Parameters<D1TaskRepository["recordIngestEvent"]>[0];
  const isFirstIngest = await ingestRepo.recordIngestEvent(
    payload.event?.ts
      ? {
          ...ingestInput,
          providerMessageId: payload.event.ts
        }
      : ingestInput
  );

  if (!isFirstIngest) {
    return Response.json({ ok: true, deduped: true }, { status: 200 });
  }

  const resolver = new ConversationAccessResolver(env.DB);
  const membershipEvent = normalizeSlackMembershipEvent(payload);
  if (membershipEvent) {
    await resolver.applySlackMembershipEvent({
      organizationId,
      workspaceId: workspaceRef.workspaceId,
      event: membershipEvent
    });
    await ingestRepo.markIngestEventProcessed(
      organizationId,
      "slack",
      providerEventId,
      new Date().toISOString()
    );
    return Response.json({ ok: true, membershipEvent: true }, { status: 200 });
  }

  const event = normalizeSlackEvent(payload);
  if (!event) {
    await ingestRepo.markIngestEventProcessed(
      organizationId,
      "slack",
      providerEventId,
      new Date().toISOString()
    );
    return Response.json({ ok: true, ignored: true }, { status: 202 });
  }

  const conversationMeta = inferSlackConversationKind(event.channelId, payload.event?.channel_type);
  const conversationSource = await resolver.upsertSlackConversationSource({
    organizationId,
    workspaceId: workspaceRef.workspaceId,
    channelId: event.channelId,
    conversationKind: conversationMeta.conversationKind,
    isPublic: conversationMeta.isPublic,
    nowIso: event.occurredAt
  });
  await resolver.ensureSlackConversationMembership({
    organizationId,
    workspaceId: workspaceRef.workspaceId,
    conversationSourceId: conversationSource.id,
    platformUserId: event.author.platformUserId,
    nowIso: event.occurredAt
  });
  try {
    const profile = await fetchAuthorProfile({
      env,
      externalWorkspaceId,
      authorUserId: event.author.platformUserId
    });
    if (profile?.displayName || profile?.email) {
      const enrichedUser = await resolver.ensureSlackUser({
        organizationId,
        workspaceId: workspaceRef.workspaceId,
        platformUserId: event.author.platformUserId,
        nowIso: event.occurredAt,
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(profile.email ? { email: profile.email } : {})
      });
      await ingestRepo.resolveOrCreatePersonForIdentity({
        organizationId,
        provider: "slack",
        externalWorkspaceId,
        externalUserId: event.author.platformUserId,
        linkedUserId: enrichedUser.userId,
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(profile.email ? { email: profile.email } : {}),
        confidence: 0.85,
        nowIso: event.occurredAt
      });
    }
  } catch (error) {
    console.warn("slack_author_profile_enrichment_failed", {
      organizationId,
      workspaceId: workspaceRef.workspaceId,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  let agentUsed = false;
  let tasksCreatedByAgent = 0;
  let reactionEmojis: string[] = [];
  let agentSummary: string | undefined;
  let shouldRespond = false;

  try {
    shouldRespond = await shouldRespondToMessage({
      env,
      payload,
      externalWorkspaceId,
      channelId: event.channelId,
      messageTs: event.messageId,
      text: event.text,
      conversationKind: conversationMeta.conversationKind
    });
    console.log("thane_reply_decision", {
      externalWorkspaceId,
      channelId: event.channelId,
      messageTs: event.messageId,
      shouldRespond,
      conversationKind: conversationMeta.conversationKind
    });

    const agentRun = await runConversationalAgentForSlackMessage({
      env,
      organizationId,
      workspaceId: workspaceRef.workspaceId,
      externalWorkspaceId,
      conversationSourceId: conversationSource.id,
      event: {
        ...event,
        workspaceId: workspaceRef.workspaceId
      },
      interactionMode: shouldRespond ? "dm_reply" : "passive_ingest"
    });
    agentUsed = agentRun.usedTools;
    tasksCreatedByAgent = agentRun.createdTaskIds.length;
    const taskEventReactions = mapTaskActionTypesToSlackReactions(agentRun.taskActionTypes);
    const nonTaskEventReactions = mapAgentEventTypesToSlackReactions(agentRun.eventTypes);
    reactionEmojis = Array.from(new Set([...taskEventReactions, ...nonTaskEventReactions]));
    agentSummary = agentRun.finalSummary;
    console.log("thane_agent_run_result", {
      externalWorkspaceId,
      channelId: event.channelId,
      messageTs: event.messageId,
      usedTools: agentRun.usedTools,
      hasReplyText: Boolean(agentRun.replyText?.trim()),
      createdTasks: agentRun.createdTaskIds.length,
      actionTypes: agentRun.taskActionTypes,
      eventTypes: agentRun.eventTypes
    });

    if (shouldRespond && agentRun.replyText) {
      const install = await resolveSlackInstall({ env, externalWorkspaceId });
      const tokens = uniqueTokens(install.botToken, env.SLACK_BOT_TOKEN);
      if (tokens.length > 0) {
        const threadTs = (payload.event as { thread_ts?: string } | undefined)?.thread_ts?.trim();
        let sent = false;
        let lastReason: string | undefined;
        for (const token of tokens) {
          try {
            await postSlackMessage({
              botToken: token,
              channelId: event.channelId,
              text: agentRun.replyText,
              ...(threadTs && threadTs !== event.messageId ? { threadTs } : {})
            });
            console.log("thane_reply_posted", {
              externalWorkspaceId,
              channelId: event.channelId,
              messageTs: event.messageId
            });
            sent = true;
            break;
          } catch (error) {
            lastReason = error instanceof Error ? error.message : String(error);
            continue;
          }
        }
        if (!sent) {
          console.warn("slack_post_reply_failed", {
            externalWorkspaceId,
            channelId: event.channelId,
            messageTs: event.messageId,
            reason: lastReason ?? "all_tokens_failed"
          });
        }
      }
    } else if (shouldRespond && !agentRun.replyText) {
      console.warn("agent_reply_missing", {
        externalWorkspaceId,
        channelId: event.channelId,
        messageTs: event.messageId
      });
    }
  } catch (error) {
    console.error("agent_runtime_failed", {
      organizationId,
      workspaceId: workspaceRef.workspaceId,
      reason: error instanceof Error ? error.message : String(error)
    });
    return Response.json(
      {
        ok: false,
        error: "agent_runtime_failed"
      },
      { status: 500 }
    );
  }

  if (reactionEmojis.length > 0) {
    const install = await resolveSlackInstall({ env, externalWorkspaceId });
    const tokens = uniqueTokens(install.botToken, env.SLACK_BOT_TOKEN);
    if (tokens.length > 0) {
      for (const reaction of reactionEmojis) {
        let reacted = false;
        let lastReason: string | undefined;
        for (const token of tokens) {
          try {
            await addSlackReaction({
              botToken: token,
              channelId: event.channelId,
              messageTs: event.messageId,
              reaction
            });
            reacted = true;
            break;
          } catch (error) {
            lastReason = error instanceof Error ? error.message : String(error);
            continue;
          }
        }
        if (!reacted) {
          console.warn("Failed to add task-event reaction", {
            externalWorkspaceId,
            channelId: event.channelId,
            messageTs: event.messageId,
            reaction,
            reason: lastReason ?? "all_tokens_failed"
          });
        }
      }
    }
  }
  await ingestRepo.markIngestEventProcessed(organizationId, "slack", providerEventId, new Date().toISOString());

  return Response.json(
    {
      ok: true,
      taskCount: tasksCreatedByAgent,
      agentUsed,
      agentSummary: agentSummary ?? null
    },
    { status: 200 }
  );
}

export async function handleSlackEvents(request: Request, env: BotEnv, ctx?: ExecutionContext): Promise<Response> {
  const rawBody = await request.text();
  const verificationInput: {
    signingSecret?: string;
    timestampHeader: string | null;
    signatureHeader: string | null;
    rawBody: string;
  } = {
    timestampHeader: request.headers.get("x-slack-request-timestamp"),
    signatureHeader: request.headers.get("x-slack-signature"),
    rawBody
  };
  if (env.SLACK_SIGNING_SECRET) {
    verificationInput.signingSecret = env.SLACK_SIGNING_SECRET;
  }
  const signatureVerification = await verifySlackRequestSignature({
    ...verificationInput
  });
  if (!signatureVerification.ok) {
    return Response.json(
      { ok: false, error: "invalid_slack_signature", reason: signatureVerification.reason },
      { status: 401 }
    );
  }

  let payload: (SlackEnvelope & {
    type?: string;
    challenge?: string;
  }) | null = null;
  try {
    payload = JSON.parse(rawBody) as SlackEnvelope & {
      type?: string;
      challenge?: string;
    };
  } catch {
    return Response.json({ ok: false, error: "invalid_json_body" }, { status: 400 });
  }

  if (payload.type === "url_verification" && payload.challenge) {
    return new Response(payload.challenge, { status: 200 });
  }

  if (ctx) {
    ctx.waitUntil(
      processSlackEventsPayload(payload, env).catch((error) => {
        console.error("slack_event_background_processing_failed", {
          reason: error instanceof Error ? error.message : String(error)
        });
      })
    );
    return Response.json({ ok: true, accepted: true }, { status: 200 });
  }

  return processSlackEventsPayload(payload, env);
}
