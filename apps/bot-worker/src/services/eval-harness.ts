import { D1TaskRepository } from "@ask-thane/data";
import { inferSlackConversationKind } from "@ask-thane/integrations";
import { runConversationalAgent } from "./agent-runtime";
import { ConversationAccessResolver } from "./conversation-access";
import { SlackInstallStore } from "./slack-install-store";
import type { BotEnv } from "./task-inference";

interface EvalCase {
  id: string;
  text: string;
  channelId?: string;
  authorExternalUserId: string;
  expected?: {
    minCreated?: number;
    maxCreated?: number;
    expectActions?: Array<"create" | "mark_done" | "mark_cancelled" | "mark_blocked" | "reopen" | "merge_into" | "edit">;
  };
}

interface ReplayRequest {
  workspaceId: string;
  externalWorkspaceId: string;
  organizationId: string;
  cases: EvalCase[];
}

function normalizeCase(input: EvalCase): EvalCase {
  return {
    ...input,
    channelId: input.channelId?.trim() || "C_EVAL"
  };
}

function scoreCase(result: {
  createdCount: number;
  actionTypes: string[];
},
expected?: EvalCase["expected"]): { passed: boolean; reasons: string[] } {
  if (!expected) {
    return { passed: true, reasons: [] };
  }

  const reasons: string[] = [];
  if (typeof expected.minCreated === "number" && result.createdCount < expected.minCreated) {
    reasons.push(`created_count_below_min:${result.createdCount}<${expected.minCreated}`);
  }
  if (typeof expected.maxCreated === "number" && result.createdCount > expected.maxCreated) {
    reasons.push(`created_count_above_max:${result.createdCount}>${expected.maxCreated}`);
  }
  if (expected.expectActions && expected.expectActions.length > 0) {
    for (const action of expected.expectActions) {
      if (!result.actionTypes.includes(action)) {
        reasons.push(`missing_action:${action}`);
      }
    }
  }

  return { passed: reasons.length === 0, reasons };
}

export async function runEvalReplay(env: BotEnv, payload: ReplayRequest): Promise<Record<string, unknown>> {
  const resolver = new ConversationAccessResolver(env.DB);
  const repo = new D1TaskRepository(env.DB);
  const installs = new SlackInstallStore(env.DB);

  const install = (await installs.listWorkspaceInstalls()).find((row) => row.workspaceId === payload.workspaceId);
  if (!install) {
    return { ok: false, error: "workspace_not_installed" };
  }

  const perCase: Array<Record<string, unknown>> = [];
  let passed = 0;

  for (const rawCase of payload.cases) {
    const c = normalizeCase(rawCase);
    const nowIso = new Date().toISOString();
    const kind = inferSlackConversationKind(c.channelId ?? "C_EVAL", undefined);

    const source = await resolver.upsertSlackConversationSource({
      organizationId: payload.organizationId,
      workspaceId: payload.workspaceId,
      channelId: c.channelId ?? "C_EVAL",
      conversationKind: kind.conversationKind,
      isPublic: kind.isPublic,
      nowIso
    });

    await resolver.ensureSlackConversationMembership({
      organizationId: payload.organizationId,
      workspaceId: payload.workspaceId,
      conversationSourceId: source.id,
      platformUserId: c.authorExternalUserId,
      nowIso
    });

    const run = await runConversationalAgent({
      env,
      organizationId: payload.organizationId,
      workspaceId: payload.workspaceId,
      externalWorkspaceId: payload.externalWorkspaceId,
      conversationSourceId: source.id,
      event: {
        workspaceId: payload.workspaceId,
        channelId: c.channelId ?? "C_EVAL",
        messageId: `${Date.now()}.${Math.floor(Math.random() * 1000)}`,
        text: c.text,
        author: {
          platform: "slack",
          platformUserId: c.authorExternalUserId
        },
        occurredAt: nowIso
      },
      interactionMode: "passive_ingest"
    });

    const scoring = scoreCase(
      {
        createdCount: run.createdTaskIds.length,
        actionTypes: run.taskActionTypes
      },
      c.expected
    );

    if (scoring.passed) {
      passed += 1;
    }

    // Cleanup eval-created tasks and related actions to avoid polluting production stats.
    if (run.createdTaskIds.length > 0) {
      const placeholders = run.createdTaskIds.map(() => "?").join(", ");
      await env.DB
        .prepare(`DELETE FROM task_actions WHERE task_id IN (${placeholders})`)
        .bind(...run.createdTaskIds)
        .run();
      await env.DB
        .prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`)
        .bind(...run.createdTaskIds)
        .run();
      await env.DB
        .prepare(`DELETE FROM resource_acl WHERE resource_type = 'task' AND resource_id IN (${placeholders})`)
        .bind(...run.createdTaskIds)
        .run();
    }

    perCase.push({
      id: c.id,
      text: c.text,
      createdTaskCount: run.createdTaskIds.length,
      actionTypes: run.taskActionTypes,
      summary: run.finalSummary ?? null,
      passed: scoring.passed,
      reasons: scoring.reasons
    });
  }

  return {
    ok: true,
    total: payload.cases.length,
    passed,
    failed: payload.cases.length - passed,
    cases: perCase
  };
}
