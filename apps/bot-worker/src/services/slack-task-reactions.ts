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
