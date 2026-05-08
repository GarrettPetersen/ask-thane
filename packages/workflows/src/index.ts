import type { LlmClient } from "@ask-thane/ai";
import type { TaskRepository } from "@ask-thane/data";
import type { MessageEvent, TaskRecord } from "@ask-thane/domain";

export interface TaskIngestionDependencies {
  llm: LlmClient;
  tasks: TaskRepository;
}

function withTaskDefaults(task: TaskRecord, event: MessageEvent): TaskRecord {
  return {
    ...task,
    id: task.id || crypto.randomUUID(),
    workspaceId: task.workspaceId || event.workspaceId,
    channelId: task.channelId || event.channelId,
    sourceMessageId: task.sourceMessageId || event.messageId,
    assigner: task.assigner || event.author,
    createdAt: task.createdAt || new Date().toISOString(),
    status: task.status || "incomplete",
    urgency: task.urgency || "medium",
    difficulty: task.difficulty || "medium",
    confidence: Number.isFinite(task.confidence) ? task.confidence : 0.5
  };
}

export async function ingestMessageForTasks(
  event: MessageEvent,
  deps: TaskIngestionDependencies
): Promise<TaskRecord[]> {
  const extraction = await deps.llm.extractTasksFromConversation(event);
  const normalized = extraction.tasks.map((task) => withTaskDefaults(task, event));

  if (normalized.length > 0) {
    await deps.tasks.saveMany(normalized);
  }

  return normalized;
}
