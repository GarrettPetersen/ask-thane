import { D1TaskRepository } from "@ask-thane/data";

interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "ask-thane-api" });
    }

    if (url.pathname === "/v1/tasks/open") {
      const workspaceId = url.searchParams.get("workspace_id") || "";
      const assigneeId = url.searchParams.get("assignee_id") || "";

      if (!workspaceId || !assigneeId) {
        return Response.json(
          { error: "workspace_id and assignee_id are required" },
          { status: 400 }
        );
      }

      const repo = new D1TaskRepository(env.DB);
      const tasks = await repo.listOpenByAssignee(workspaceId, assigneeId);
      return Response.json({ tasks });
    }

    if (url.pathname === "/v1/tasks/open-visible") {
      const organizationId = url.searchParams.get("organization_id") || "";
      const assigneeId = url.searchParams.get("assignee_id") || "";
      const readableConversationSourceIds = (url.searchParams.get("readable_conversation_source_ids") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const allowUnscoped = url.searchParams.get("allow_unscoped") === "true";

      if (!organizationId || !assigneeId) {
        return Response.json(
          { error: "organization_id and assignee_id are required" },
          { status: 400 }
        );
      }

      const repo = new D1TaskRepository(env.DB);
      const tasks = await repo.listOpenByAssigneeWithAcl({
        organizationId,
        assigneeId,
        readableConversationSourceIds,
        allowUnscoped
      });
      return Response.json({ tasks });
    }

    return new Response("Not Found", { status: 404 });
  }
};
