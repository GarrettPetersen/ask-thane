import type { BotEnv } from "./task-inference";

export async function getOpsSummary(env: BotEnv): Promise<Record<string, unknown>> {
  const now = new Date();
  const since24 = new Date(now.valueOf() - 24 * 60 * 60 * 1000).toISOString();

  const [orgCounts, taskCounts, ingestStats, llmStats, feedbackStats] = await Promise.all([
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM organizations) AS organizations,
         (SELECT COUNT(*) FROM workspaces) AS workspaces,
         (SELECT COUNT(*) FROM users) AS users`
    ).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS tasks_total,
         SUM(CASE WHEN status IN ('incomplete', 'in_progress', 'blocked') THEN 1 ELSE 0 END) AS tasks_open,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS tasks_done
       FROM tasks`
    ).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS ingest_events_24h,
         SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) AS ingest_backlog,
         SUM(CASE WHEN provider = 'slack' THEN 1 ELSE 0 END) AS slack_events_24h,
         SUM(CASE WHEN provider = 'slack_poll' THEN 1 ELSE 0 END) AS slack_poll_events_24h
       FROM ingest_events
       WHERE received_at >= ?`
    )
      .bind(since24)
      .first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS llm_calls_24h,
         SUM(prompt_tokens) AS prompt_tokens_24h,
         SUM(completion_tokens) AS completion_tokens_24h,
         SUM(total_tokens) AS total_tokens_24h
       FROM llm_usage_events
       WHERE created_at >= ?`
    )
      .bind(since24)
      .first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS feedback_items_24h,
         SUM(CASE WHEN feedback_type = 'not_a_task' THEN 1 ELSE 0 END) AS not_a_task_24h,
         SUM(CASE WHEN feedback_type = 'wrong_assignee' THEN 1 ELSE 0 END) AS wrong_assignee_24h
       FROM task_feedback
       WHERE created_at >= ?`
    )
      .bind(since24)
      .first<Record<string, unknown>>()
  ]);

  const recentFailures = await env.DB
    .prepare(
      `SELECT provider, provider_event_id, provider_message_id, received_at
       FROM ingest_events
       WHERE processed_at IS NULL
       ORDER BY received_at DESC
       LIMIT 25`
    )
    .all<Record<string, unknown>>();

  return {
    ok: true,
    generatedAt: now.toISOString(),
    since24h: since24,
    counts: {
      organizations: Number(orgCounts?.organizations ?? 0),
      workspaces: Number(orgCounts?.workspaces ?? 0),
      users: Number(orgCounts?.users ?? 0),
      tasksTotal: Number(taskCounts?.tasks_total ?? 0),
      tasksOpen: Number(taskCounts?.tasks_open ?? 0),
      tasksDone: Number(taskCounts?.tasks_done ?? 0)
    },
    ingest: {
      events24h: Number(ingestStats?.ingest_events_24h ?? 0),
      backlog: Number(ingestStats?.ingest_backlog ?? 0),
      slackEvents24h: Number(ingestStats?.slack_events_24h ?? 0),
      slackPollEvents24h: Number(ingestStats?.slack_poll_events_24h ?? 0)
    },
    llm: {
      calls24h: Number(llmStats?.llm_calls_24h ?? 0),
      promptTokens24h: Number(llmStats?.prompt_tokens_24h ?? 0),
      completionTokens24h: Number(llmStats?.completion_tokens_24h ?? 0),
      totalTokens24h: Number(llmStats?.total_tokens_24h ?? 0)
    },
    feedback: {
      total24h: Number(feedbackStats?.feedback_items_24h ?? 0),
      notATask24h: Number(feedbackStats?.not_a_task_24h ?? 0),
      wrongAssignee24h: Number(feedbackStats?.wrong_assignee_24h ?? 0)
    },
    recentUnprocessedIngest: recentFailures.results ?? []
  };
}

export async function getWorkspaceOpsSummary(env: BotEnv, workspaceId: string): Promise<Record<string, unknown>> {
  const now = new Date();
  const since24 = new Date(now.valueOf() - 24 * 60 * 60 * 1000).toISOString();

  const [taskCounts, digestStats, followUpStats, llmStats, feedbackStats] = await Promise.all([
    env.DB
      .prepare(
        `SELECT
           COUNT(*) AS tasks_total,
           SUM(CASE WHEN status IN ('incomplete', 'in_progress', 'blocked') THEN 1 ELSE 0 END) AS tasks_open,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS tasks_done
         FROM tasks
         WHERE workspace_id = ?`
      )
      .bind(workspaceId)
      .first<Record<string, unknown>>(),
    env.DB
      .prepare(
        `SELECT
           COUNT(*) AS digests_24h,
           COALESCE(SUM(task_count), 0) AS digest_task_mentions_24h
         FROM digest_deliveries
         WHERE workspace_id = ?
           AND sent_at >= ?`
      )
      .bind(workspaceId, since24)
      .first<Record<string, unknown>>(),
    env.DB
      .prepare(
        `SELECT
           COUNT(*) AS followups_24h,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS followups_failed_total
         FROM follow_up_jobs
         WHERE workspace_id = ?
           AND created_at >= ?`
      )
      .bind(workspaceId, since24)
      .first<Record<string, unknown>>(),
    env.DB
      .prepare(
        `SELECT
           COUNT(*) AS llm_calls_24h,
           SUM(total_tokens) AS llm_tokens_24h
         FROM llm_usage_events
         WHERE workspace_id = ?
           AND created_at >= ?`
      )
      .bind(workspaceId, since24)
      .first<Record<string, unknown>>(),
    env.DB
      .prepare(
        `SELECT
           COUNT(*) AS feedback_24h
         FROM task_feedback
         WHERE workspace_id = ?
           AND created_at >= ?`
      )
      .bind(workspaceId, since24)
      .first<Record<string, unknown>>()
  ]);

  return {
    ok: true,
    workspaceId,
    generatedAt: now.toISOString(),
    since24h: since24,
    tasks: {
      total: Number(taskCounts?.tasks_total ?? 0),
      open: Number(taskCounts?.tasks_open ?? 0),
      done: Number(taskCounts?.tasks_done ?? 0)
    },
    digests: {
      sent24h: Number(digestStats?.digests_24h ?? 0),
      taskMentions24h: Number(digestStats?.digest_task_mentions_24h ?? 0)
    },
    followUps: {
      created24h: Number(followUpStats?.followups_24h ?? 0),
      failedTotal: Number(followUpStats?.followups_failed_total ?? 0)
    },
    llm: {
      calls24h: Number(llmStats?.llm_calls_24h ?? 0),
      tokens24h: Number(llmStats?.llm_tokens_24h ?? 0)
    },
    feedback: {
      total24h: Number(feedbackStats?.feedback_24h ?? 0)
    }
  };
}
