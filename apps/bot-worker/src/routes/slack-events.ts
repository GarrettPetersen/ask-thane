import { D1TaskRepository } from "@ask-thane/data";
import {
  inferSlackConversationKind,
  normalizeSlackEvent,
  normalizeSlackMembershipEvent,
  type SlackEnvelope
} from "@ask-thane/integrations";
import { inferAndPersistTasks, type BotEnv } from "../services/task-inference";
import { ConversationAccessResolver } from "../services/conversation-access";
import { OrgRegistry } from "../services/org-registry";
import { verifySlackRequestSignature } from "../services/slack-signature";

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
  await resolver.upsertSlackConversationSource({
    organizationId,
    workspaceId: workspaceRef.workspaceId,
    channelId: event.channelId,
    conversationKind: conversationMeta.conversationKind,
    isPublic: conversationMeta.isPublic,
    nowIso: event.occurredAt
  });

  const tasks = await inferAndPersistTasks(
    {
      ...event,
      workspaceId: workspaceRef.workspaceId
    },
    env
  );
  await ingestRepo.markIngestEventProcessed(organizationId, "slack", providerEventId, new Date().toISOString());

  return Response.json({ ok: true, taskCount: tasks.length }, { status: 200 });
}
