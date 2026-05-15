import type { BotEnv } from "./task-inference";

export interface WorkspaceBillingPolicy {
  planTier: string;
  monthlyBasePriceUsd: number;
  includedActiveUsers: number;
  perUserOverageUsd: number;
  includedAiCostUsd: number;
  aiOverageMultiplier: number;
  hardCapActiveUsers: number | null;
  activeUserWindowDays: number;
  overageEnabled: boolean;
  isEnabled: boolean;
}

export interface ActiveUserGateResult {
  allowed: boolean;
  reason?: "free_tier_active_user_limit_reached";
  policy: WorkspaceBillingPolicy;
  activeUsersCount: number;
  countedUserIsAlreadyActive: boolean;
}

export interface FreeTierAiSpendGateResult {
  allowed: boolean;
  reason?: "free_tier_ai_spend_limit_reached";
  policy: WorkspaceBillingPolicy;
  monthlySpendUsd: number;
  monthlyCapUsd: number;
  monthStartIso: string;
  resetsAtIso: string;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function asBoolInt(value: unknown, fallback: boolean): boolean {
  const parsed = asInt(value);
  if (parsed === null) {
    return fallback;
  }
  return parsed === 1;
}

function normalizePlanTier(rawPlanTier: string): string {
  const planTier = rawPlanTier.trim().toLowerCase();
  if (!planTier) {
    return "free";
  }
  // Backward-compatible aliases from earlier workspace/org plan names.
  if (planTier === "starter") {
    return "team";
  }
  if (planTier === "pro") {
    return "growth";
  }
  if (planTier === "business" || planTier === "enterprise") {
    return "scale";
  }
  return planTier;
}

function asNonEmpty(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function defaultPolicyForPlanTier(rawPlanTier: string): WorkspaceBillingPolicy {
  const planTier = normalizePlanTier(rawPlanTier);
  if (planTier === "free") {
    return {
      planTier: "free",
      monthlyBasePriceUsd: 0,
      includedActiveUsers: 10,
      perUserOverageUsd: 0,
      includedAiCostUsd: 0,
      aiOverageMultiplier: 1,
      hardCapActiveUsers: 10,
      activeUserWindowDays: 30,
      overageEnabled: false,
      isEnabled: true
    };
  }
  if (planTier === "team") {
    return {
      planTier: "team",
      monthlyBasePriceUsd: 99,
      includedActiveUsers: 25,
      perUserOverageUsd: 3,
      includedAiCostUsd: 20,
      aiOverageMultiplier: 1.35,
      hardCapActiveUsers: null,
      activeUserWindowDays: 30,
      overageEnabled: true,
      isEnabled: true
    };
  }
  if (planTier === "growth") {
    return {
      planTier: "growth",
      monthlyBasePriceUsd: 299,
      includedActiveUsers: 100,
      perUserOverageUsd: 2,
      includedAiCostUsd: 120,
      aiOverageMultiplier: 1.3,
      hardCapActiveUsers: null,
      activeUserWindowDays: 30,
      overageEnabled: true,
      isEnabled: true
    };
  }
  if (planTier === "scale") {
    return {
      planTier: "scale",
      monthlyBasePriceUsd: 699,
      includedActiveUsers: 300,
      perUserOverageUsd: 1.25,
      includedAiCostUsd: 400,
      aiOverageMultiplier: 1.25,
      hardCapActiveUsers: null,
      activeUserWindowDays: 30,
      overageEnabled: true,
      isEnabled: true
    };
  }
  if (planTier === "scale_plus") {
    return {
      planTier: "scale_plus",
      monthlyBasePriceUsd: 1499,
      includedActiveUsers: 1000,
      perUserOverageUsd: 1,
      includedAiCostUsd: 1000,
      aiOverageMultiplier: 1.2,
      hardCapActiveUsers: null,
      activeUserWindowDays: 30,
      overageEnabled: true,
      isEnabled: true
    };
  }
  return {
    planTier,
    monthlyBasePriceUsd: 99,
    includedActiveUsers: 10,
    perUserOverageUsd: 3,
    includedAiCostUsd: 20,
    aiOverageMultiplier: 1.35,
    hardCapActiveUsers: null,
    activeUserWindowDays: 30,
    overageEnabled: true,
    isEnabled: true
  };
}

function subtractDaysIso(baseIso: string, days: number): string {
  const base = new Date(baseIso);
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(base.valueOf() - ms).toISOString();
}

function monthBoundsUtc(baseIso: string): { monthStartIso: string; nextMonthStartIso: string } {
  const base = new Date(baseIso);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const monthStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const nextMonthStart = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return {
    monthStartIso: monthStart.toISOString(),
    nextMonthStartIso: nextMonthStart.toISOString()
  };
}

function asReal(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export async function resolveWorkspaceBillingPolicy(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
}): Promise<WorkspaceBillingPolicy> {
  const row = await input.env.DB
    .prepare(
      `SELECT
         COALESCE(NULLIF(w.plan_tier, ''), NULLIF(o.plan_tier, ''), 'free') AS effective_plan_tier,
         bws.included_active_users,
         bws.hard_cap_active_users,
         bws.active_user_window_days,
         bws.overage_enabled,
         bws.is_enabled,
         bws.metadata_json
       FROM workspaces w
       JOIN organizations o ON o.id = w.organization_id
       LEFT JOIN billing_workspace_settings bws
         ON bws.organization_id = w.organization_id
        AND bws.workspace_id = w.id
       WHERE w.organization_id = ?
         AND w.id = ?
       LIMIT 1`
    )
    .bind(input.organizationId, input.workspaceId)
    .first<Record<string, unknown>>();

  const base = defaultPolicyForPlanTier(String(row?.effective_plan_tier ?? "free"));
  const included = asInt(row?.included_active_users);
  const hardCapRaw = asInt(row?.hard_cap_active_users);
  const windowDays = asInt(row?.active_user_window_days);
  const metadata = (() => {
    if (!row?.metadata_json || typeof row.metadata_json !== "string") {
      return {} as Record<string, unknown>;
    }
    try {
      return JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  const monthlyBasePriceUsd = asReal(metadata.monthly_base_price_usd);
  const perUserOverageUsd = asReal(metadata.per_user_overage_usd);
  const includedAiCostUsd = asReal(metadata.included_ai_cost_usd);
  const aiOverageMultiplier = asReal(metadata.ai_overage_multiplier);

  return {
    ...base,
    ...(monthlyBasePriceUsd !== null ? { monthlyBasePriceUsd: Math.max(monthlyBasePriceUsd, 0) } : {}),
    ...(included !== null ? { includedActiveUsers: Math.max(included, 0) } : {}),
    ...(perUserOverageUsd !== null ? { perUserOverageUsd: Math.max(perUserOverageUsd, 0) } : {}),
    ...(includedAiCostUsd !== null ? { includedAiCostUsd: Math.max(includedAiCostUsd, 0) } : {}),
    ...(aiOverageMultiplier !== null ? { aiOverageMultiplier: Math.max(aiOverageMultiplier, 1) } : {}),
    ...(hardCapRaw !== null ? { hardCapActiveUsers: Math.max(hardCapRaw, 0) } : {}),
    ...(windowDays !== null ? { activeUserWindowDays: Math.max(windowDays, 1) } : {}),
    overageEnabled: asBoolInt(row?.overage_enabled, base.overageEnabled),
    isEnabled: asBoolInt(row?.is_enabled, base.isEnabled)
  };
}

export function resolveModelForWorkspaceTier(input: {
  env: BotEnv;
  planTier: string;
  usage: "agent" | "digest";
}): string {
  const normalizedTier = normalizePlanTier(input.planTier);
  const defaultModel = asNonEmpty(input.env.DEFAULT_LLM_MODEL);
  const freeModel = asNonEmpty(input.env.FREE_TIER_LLM_MODEL);
  const paidModel = asNonEmpty(input.env.PAID_TIER_LLM_MODEL);
  const paidDigestModel = asNonEmpty(input.env.PAID_TIER_DIGEST_LLM_MODEL);
  const teamModel = asNonEmpty(input.env.TEAM_TIER_LLM_MODEL);
  const growthModel = asNonEmpty(input.env.GROWTH_TIER_LLM_MODEL);
  const scaleModel = asNonEmpty(input.env.SCALE_TIER_LLM_MODEL);
  const scalePlusModel = asNonEmpty(input.env.SCALE_PLUS_TIER_LLM_MODEL);

  if (normalizedTier === "free") {
    return freeModel ?? defaultModel ?? "gpt-4.1-mini";
  }

  const tierModel =
    normalizedTier === "team"
      ? teamModel
      : normalizedTier === "growth"
        ? growthModel
        : normalizedTier === "scale"
          ? scaleModel
          : normalizedTier === "scale_plus"
            ? scalePlusModel
            : null;

  if (input.usage === "digest") {
    return paidDigestModel ?? tierModel ?? paidModel ?? defaultModel ?? "gpt-5.4-mini";
  }

  return tierModel ?? paidModel ?? defaultModel ?? "gpt-5.4-mini";
}

export async function estimateWorkspaceMonthlyBill(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  monthStartIso: string;
  monthEndIso: string;
  asOfIso?: string;
}): Promise<{
  policy: WorkspaceBillingPolicy;
  activeUsers: number;
  participantOverageUsers: number;
  participantOverageUsd: number;
  aiEstimatedCostUsd: number;
  aiOverageUsd: number;
  monthlyBasePriceUsd: number;
  estimatedMonthlyTotalUsd: number;
}> {
  const policy = await resolveWorkspaceBillingPolicy({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId
  });
  const activeUsers = await countBillableActiveUsersForWorkspace({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    ...(input.asOfIso ? { asOfIso: input.asOfIso } : {})
  });
  const participantOverageUsers = Math.max(activeUsers - policy.includedActiveUsers, 0);
  const participantOverageUsd = participantOverageUsers * policy.perUserOverageUsd;

  const aiRow = await input.env.DB
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS ai_cost_usd
       FROM llm_usage_events
       WHERE organization_id = ?
         AND workspace_id = ?
         AND created_at >= ?
         AND created_at <= ?`
    )
    .bind(input.organizationId, input.workspaceId, input.monthStartIso, input.monthEndIso)
    .first<Record<string, unknown>>();
  const aiEstimatedCostUsd = asReal(aiRow?.ai_cost_usd) ?? 0;
  const aiOverageBaseUsd = Math.max(aiEstimatedCostUsd - policy.includedAiCostUsd, 0);
  const aiOverageUsd = aiOverageBaseUsd * policy.aiOverageMultiplier;

  const estimatedMonthlyTotalUsd = policy.monthlyBasePriceUsd + participantOverageUsd + aiOverageUsd;
  return {
    policy,
    activeUsers,
    participantOverageUsers,
    participantOverageUsd,
    aiEstimatedCostUsd,
    aiOverageUsd,
    monthlyBasePriceUsd: policy.monthlyBasePriceUsd,
    estimatedMonthlyTotalUsd
  };
}

export async function countBillableActiveUsersForWorkspace(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  asOfIso?: string;
  activeWindowDays?: number;
}): Promise<number> {
  const asOfIso = input.asOfIso ?? new Date().toISOString();
  const activeWindowDays = Math.max(input.activeWindowDays ?? 30, 1);
  const cutoffIso = subtractDaysIso(asOfIso, activeWindowDays);

  const row = await input.env.DB
    .prepare(
      `SELECT COUNT(*) AS active_users
       FROM workspace_user_activity
       WHERE organization_id = ?
         AND workspace_id = ?
         AND is_billable = 1
         AND is_deactivated = 0
         AND last_activity_at >= ?
         AND last_activity_at <= ?`
    )
    .bind(input.organizationId, input.workspaceId, cutoffIso, asOfIso)
    .first<Record<string, unknown>>();

  return Number(row?.active_users ?? 0);
}

async function isUserAlreadyActive(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  externalUserId: string;
  asOfIso: string;
  activeWindowDays: number;
}): Promise<boolean> {
  const cutoffIso = subtractDaysIso(input.asOfIso, input.activeWindowDays);
  const row = await input.env.DB
    .prepare(
      `SELECT id
       FROM workspace_user_activity
       WHERE organization_id = ?
         AND workspace_id = ?
         AND external_user_id = ?
         AND is_billable = 1
         AND is_deactivated = 0
         AND last_activity_at >= ?
         AND last_activity_at <= ?
       LIMIT 1`
    )
    .bind(
      input.organizationId,
      input.workspaceId,
      input.externalUserId,
      cutoffIso,
      input.asOfIso
    )
    .first<Record<string, unknown>>();
  return Boolean(row?.id);
}

export async function evaluateActiveUserGateForTaskWrite(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  externalUserId: string;
  nowIso?: string;
}): Promise<ActiveUserGateResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const policy = await resolveWorkspaceBillingPolicy({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId
  });

  if (!policy.isEnabled) {
    return {
      allowed: true,
      policy,
      activeUsersCount: 0,
      countedUserIsAlreadyActive: false
    };
  }

  const countedUserIsAlreadyActive = await isUserAlreadyActive({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    externalUserId: input.externalUserId,
    asOfIso: nowIso,
    activeWindowDays: policy.activeUserWindowDays
  });

  const activeUsersCount = await countBillableActiveUsersForWorkspace({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    asOfIso: nowIso,
    activeWindowDays: policy.activeUserWindowDays
  });

  if (countedUserIsAlreadyActive || policy.hardCapActiveUsers === null) {
    return {
      allowed: true,
      policy,
      activeUsersCount,
      countedUserIsAlreadyActive
    };
  }

  if (activeUsersCount >= policy.hardCapActiveUsers) {
    return {
      allowed: false,
      reason: "free_tier_active_user_limit_reached",
      policy,
      activeUsersCount,
      countedUserIsAlreadyActive
    };
  }

  return {
    allowed: true,
    policy,
    activeUsersCount,
    countedUserIsAlreadyActive
  };
}

export async function evaluateFreeTierAiSpendGateForTaskWrite(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  nowIso?: string;
}): Promise<FreeTierAiSpendGateResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const policy = await resolveWorkspaceBillingPolicy({
    env: input.env,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId
  });

  const parsedCap = asReal(input.env.FREE_TIER_MONTHLY_AI_CAP_USD);
  const monthlyCapUsd = parsedCap !== null && parsedCap > 0 ? parsedCap : 10;
  const { monthStartIso, nextMonthStartIso } = monthBoundsUtc(nowIso);

  if (policy.planTier !== "free") {
    return {
      allowed: true,
      policy,
      monthlySpendUsd: 0,
      monthlyCapUsd,
      monthStartIso,
      resetsAtIso: nextMonthStartIso
    };
  }

  const spendRow = await input.env.DB
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS month_cost_usd
       FROM llm_usage_events
       WHERE organization_id = ?
         AND workspace_id = ?
         AND created_at >= ?
         AND created_at < ?`
    )
    .bind(input.organizationId, input.workspaceId, monthStartIso, nextMonthStartIso)
    .first<Record<string, unknown>>();

  const monthlySpendUsd = Math.max(asReal(spendRow?.month_cost_usd) ?? 0, 0);
  if (monthlySpendUsd > monthlyCapUsd) {
    return {
      allowed: false,
      reason: "free_tier_ai_spend_limit_reached",
      policy,
      monthlySpendUsd,
      monthlyCapUsd,
      monthStartIso,
      resetsAtIso: nextMonthStartIso
    };
  }

  return {
    allowed: true,
    policy,
    monthlySpendUsd,
    monthlyCapUsd,
    monthStartIso,
    resetsAtIso: nextMonthStartIso
  };
}

export async function recordWorkspaceUserActivity(input: {
  env: BotEnv;
  organizationId: string;
  workspaceId: string;
  userId?: string | null;
  externalUserId: string;
  eventType: string;
  activityAt?: string;
  sourceConversationSourceId?: string;
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const nowIso = input.activityAt ?? new Date().toISOString();
  await input.env.DB
    .prepare(
      `INSERT INTO workspace_user_activity (
         id, organization_id, workspace_id, user_id, external_user_id, first_activity_at, last_activity_at,
         last_event_type, last_conversation_source_id, last_source_message_id, is_billable, is_deactivated,
         deactivated_at, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?)
       ON CONFLICT(organization_id, workspace_id, external_user_id)
       DO UPDATE SET
         user_id = COALESCE(excluded.user_id, workspace_user_activity.user_id),
         last_activity_at = excluded.last_activity_at,
         last_event_type = excluded.last_event_type,
         last_conversation_source_id = excluded.last_conversation_source_id,
         last_source_message_id = excluded.last_source_message_id,
         is_billable = 1,
         is_deactivated = 0,
         deactivated_at = NULL,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`
    )
    .bind(
      crypto.randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.userId ?? null,
      input.externalUserId,
      nowIso,
      nowIso,
      input.eventType,
      input.sourceConversationSourceId ?? null,
      input.sourceMessageId ?? null,
      JSON.stringify(input.metadata ?? {}),
      nowIso,
      nowIso
    )
    .run();
}

export async function markWorkspaceUsersDeactivated(input: {
  db: D1Database;
  organizationId: string;
  workspaceId: string;
  activeExternalUserIds: string[];
  nowIso?: string;
}): Promise<void> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (input.activeExternalUserIds.length === 0) {
    await input.db
      .prepare(
        `UPDATE workspace_user_activity
         SET is_deactivated = 1,
             deactivated_at = COALESCE(deactivated_at, ?),
             updated_at = ?
         WHERE organization_id = ?
           AND workspace_id = ?`
      )
      .bind(nowIso, nowIso, input.organizationId, input.workspaceId)
      .run();
    return;
  }

  const placeholders = input.activeExternalUserIds.map(() => "?").join(", ");
  await input.db
    .prepare(
      `UPDATE workspace_user_activity
       SET is_deactivated = 1,
           deactivated_at = COALESCE(deactivated_at, ?),
           updated_at = ?
       WHERE organization_id = ?
         AND workspace_id = ?
         AND external_user_id NOT IN (${placeholders})`
    )
    .bind(nowIso, nowIso, input.organizationId, input.workspaceId, ...input.activeExternalUserIds)
    .run();
}
