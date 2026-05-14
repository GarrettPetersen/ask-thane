import { D1TaskRepository } from "@ask-thane/data";
import {
  inferSlackConversationKind,
  normalizeSlackEvent,
  normalizeSlackMembershipEvent,
  type SlackEnvelope
} from "@ask-thane/integrations";
import { runConversationalAgentForSlackMessage } from "../services/agent-runtime";
import { addSlackReaction, fetchSlackMessageByTs, postSlackMessage } from "../services/slack-api";
import { mapTaskActionTypesToSlackReactions } from "../services/slack-task-reactions";
import type { BotEnv } from "../services/task-inference";
import { ConversationAccessResolver } from "../services/conversation-access";
import { OrgRegistry } from "../services/org-registry";
import { SlackInstallStore } from "../services/slack-install-store";
import { verifySlackRequestSignature } from "../services/slack-signature";

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

function normalizeForAddressing(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i + j));
  for (let i = 0; i <= a.length; i += 1) {
    dp[i]![0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    dp[0]![j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = dp[i - 1]![j]! + 1;
      const insertion = dp[i]![j - 1]! + 1;
      dp[i]![j] = Math.min(substitution, deletion, insertion);
    }
  }
  return dp[a.length]![b.length]!;
}

function hasBotNameCue(text: string): boolean {
  const tokens = normalizeForAddressing(text);
  if (tokens.length === 0) {
    return false;
  }
  for (const token of tokens.slice(0, 6)) {
    if (token === "thane") {
      return true;
    }
    if (token.length >= 4 && token.length <= 8 && editDistance(token, "thane") <= 2) {
      return true;
    }
  }
  return false;
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

async function shouldRespondToMessage(input: {
  env: BotEnv;
  payload: SlackEnvelope;
  externalWorkspaceId: string;
  channelId: string;
  messageTs: string;
  text: string;
  conversationKind: "public_channel" | "private_channel" | "group_dm" | "dm";
}): Promise<boolean> {
  if (input.conversationKind === "dm") {
    return true;
  }

  const install = await resolveSlackInstall({
    env: input.env,
    externalWorkspaceId: input.externalWorkspaceId
  });
  const botUserId = install.botUserId;
  const botMentioned = Boolean(botUserId && input.text.includes(`<@${botUserId}>`));
  if (botMentioned || hasBotNameCue(input.text)) {
    return true;
  }

  const threadTs = (input.payload.event as { thread_ts?: string } | undefined)?.thread_ts?.trim();
  if (threadTs && threadTs !== input.messageTs && botUserId) {
    const tokens = uniqueTokens(install.botToken, input.env.SLACK_BOT_TOKEN);
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
        if (isSlackAuthError(error)) {
          continue;
        }
        console.warn("slack_parent_message_lookup_failed", {
          externalWorkspaceId: input.externalWorkspaceId,
          channelId: input.channelId,
          threadTs,
          reason: error instanceof Error ? error.message : String(error)
        });
        break;
      }
    }
  }

  return false;
}

export async function handleSlackEvents(request: Request, env: BotEnv): Promise<Response> {
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

  const externalWorkspaceId = payload.team_id;
  if (!externalWorkspaceId) {
    return Response.json({ ok: true, ignored: true, reason: "missing_team_id" }, { status: 202 });
  }

  const registry = new OrgRegistry(env.DB);
  const workspaceRef = await registry.resolveOrCreateSlackWorkspace(
    env.DEFAULT_ORGANIZATION_ID
      ? {
          externalWorkspaceId,
          defaultOrganizationId: env.DEFAULT_ORGANIZATION_ID
        }
      : {
          externalWorkspaceId
        }
  );
  const organizationId = workspaceRef.organizationId;

  const ingestRepo = new D1TaskRepository(env.DB);
  const providerEventId =
    payload.event_id ??
    `${payload.event?.type ?? "unknown"}:${payload.event?.channel ?? "unknown"}:${payload.event?.ts ?? payload.event_time ?? "unknown"}`;
  const ingestInput = {
    id: crypto.randomUUID(),
    organizationId,
    provider: "slack",
    providerEventId,
    receivedAt: new Date().toISOString()
  } as const;
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

  let agentUsed = false;
  let tasksCreatedByAgent = 0;
  let taskActionTypes: ReturnType<typeof mapTaskActionTypesToSlackReactions> = [];
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
    taskActionTypes = mapTaskActionTypesToSlackReactions(agentRun.taskActionTypes);
    agentSummary = agentRun.finalSummary;

    if (shouldRespond && agentRun.replyText) {
      const install = await resolveSlackInstall({ env, externalWorkspaceId });
      const tokens = uniqueTokens(install.botToken, env.SLACK_BOT_TOKEN);
      if (tokens.length > 0) {
        const threadTs = (payload.event as { thread_ts?: string } | undefined)?.thread_ts?.trim();
        let sent = false;
        for (const token of tokens) {
          try {
            await postSlackMessage({
              botToken: token,
              channelId: event.channelId,
              text: agentRun.replyText,
              ...(threadTs && threadTs !== event.messageId ? { threadTs } : {})
            });
            sent = true;
            break;
          } catch (error) {
            if (isSlackAuthError(error)) {
              continue;
            }
            console.warn("slack_post_reply_failed", {
              externalWorkspaceId,
              channelId: event.channelId,
              messageTs: event.messageId,
              reason: error instanceof Error ? error.message : String(error)
            });
            break;
          }
        }
        if (!sent) {
          console.warn("slack_post_reply_failed", {
            externalWorkspaceId,
            channelId: event.channelId,
            messageTs: event.messageId,
            reason: "all_tokens_failed"
          });
        }
      }
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

  if (taskActionTypes.length > 0) {
    const install = await resolveSlackInstall({ env, externalWorkspaceId });
    const tokens = uniqueTokens(install.botToken, env.SLACK_BOT_TOKEN);
    if (tokens.length > 0) {
      for (const reaction of taskActionTypes) {
        let reacted = false;
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
            if (isSlackAuthError(error)) {
              continue;
            }
            console.warn("Failed to add task-event reaction", {
              externalWorkspaceId,
              channelId: event.channelId,
              messageTs: event.messageId,
              reaction,
              reason: error instanceof Error ? error.message : String(error)
            });
            break;
          }
        }
        if (!reacted) {
          console.warn("Failed to add task-event reaction", {
            externalWorkspaceId,
            channelId: event.channelId,
            messageTs: event.messageId,
            reaction,
            reason: "all_tokens_failed"
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
