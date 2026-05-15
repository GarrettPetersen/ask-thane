import type { TaskRecord } from "@ask-thane/domain";
import type { BotEnv } from "./task-inference";

type TasksApiEnv = Pick<BotEnv, "TASKS_API_BASE_URL" | "INTERNAL_API_BEARER_TOKEN">;

interface OpenTasksResponse {
  tasks: TaskRecord[];
}

interface ListOpenTasksInput {
  workspaceId: string;
  assigneeId: string;
}

interface ListOpenVisibleTasksInput {
  organizationId: string;
  assigneeId: string;
  readableConversationSourceIds: string[];
  allowUnscoped?: boolean;
}

function getTasksApiConfig(env: TasksApiEnv): { baseUrl: string; bearerToken: string } {
  const baseUrl = env.TASKS_API_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("missing_tasks_api_base_url");
  }
  const bearerToken = env.INTERNAL_API_BEARER_TOKEN?.trim();
  if (!bearerToken) {
    throw new Error("missing_internal_api_bearer_token");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), bearerToken };
}

async function fetchTasksApiJson(
  env: TasksApiEnv,
  path: string,
  query: Record<string, string | undefined>
): Promise<OpenTasksResponse> {
  const { baseUrl, bearerToken } = getTasksApiConfig(env);
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${bearerToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`tasks_api_request_failed:${response.status}`);
  }
  return (await response.json()) as OpenTasksResponse;
}

export async function listOpenTasksViaApi(
  env: TasksApiEnv,
  input: ListOpenTasksInput
): Promise<TaskRecord[]> {
  const payload = await fetchTasksApiJson(env, "/v1/tasks/open", {
    workspace_id: input.workspaceId,
    assignee_id: input.assigneeId
  });
  return payload.tasks;
}

export async function listOpenVisibleTasksViaApi(
  env: TasksApiEnv,
  input: ListOpenVisibleTasksInput
): Promise<TaskRecord[]> {
  const payload = await fetchTasksApiJson(env, "/v1/tasks/open-visible", {
    organization_id: input.organizationId,
    assignee_id: input.assigneeId,
    readable_conversation_source_ids: input.readableConversationSourceIds.join(","),
    allow_unscoped: input.allowUnscoped ? "true" : undefined
  });
  return payload.tasks;
}
