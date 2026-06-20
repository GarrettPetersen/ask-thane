import type { TaskActionType } from "@ask-thane/domain";

const ACTION_TO_REACTION: Record<TaskActionType, string> = {
  create: "memo",
  mark_done: "white_check_mark",
  mark_cancelled: "x",
  mark_blocked: "warning",
  reopen: "arrows_counterclockwise",
  merge_into: "twisted_rightwards_arrows",
  edit: "pencil2"
};

const REACTION_ORDER: TaskActionType[] = [
  "create",
  "mark_done",
  "mark_cancelled",
  "mark_blocked",
  "reopen",
  "merge_into",
  "edit"
];

export function mapTaskActionTypesToSlackReactions(actionTypes: TaskActionType[]): string[] {
  const actionSet = new Set(actionTypes);
  const reactions: string[] = [];

  for (const actionType of REACTION_ORDER) {
    if (actionSet.has(actionType)) {
      reactions.push(ACTION_TO_REACTION[actionType]);
    }
  }

  return reactions;
}

const ACTION_TO_THANE_CHAT_REACTION: Record<TaskActionType, string> = {
  create: "📝",
  mark_done: "✅",
  mark_cancelled: "❌",
  mark_blocked: "⚠️",
  reopen: "🔄",
  merge_into: "🔀",
  edit: "✏️"
};

export function mapTaskActionTypesToThaneChatReactions(actionTypes: TaskActionType[]): string[] {
  const actionSet = new Set(actionTypes);
  const reactions: string[] = [];

  for (const actionType of REACTION_ORDER) {
    if (actionSet.has(actionType)) {
      reactions.push(ACTION_TO_THANE_CHAT_REACTION[actionType]);
    }
  }

  return reactions;
}

const EVENT_TO_REACTION: Record<string, string> = {
  feedback_recorded: "mag",
  note_written: "spiral_note_pad",
  permission_waiver_requested: "lock",
  notification_cadence_updated: "alarm_clock",
  follow_up_scheduled: "spiral_calendar_pad"
};

export function mapAgentEventTypesToSlackReactions(eventTypes: string[]): string[] {
  const reactions: string[] = [];
  const seen = new Set<string>();

  for (const eventType of eventTypes) {
    const reaction = EVENT_TO_REACTION[eventType];
    if (!reaction || seen.has(reaction)) {
      continue;
    }
    seen.add(reaction);
    reactions.push(reaction);
  }

  return reactions;
}
