import { D1TaskRepository } from "@ask-thane/data";

interface Env {
  DB: D1Database;
  INTERNAL_API_BEARER_TOKEN?: string;
  BUILD_ENV?: string;
  BUILD_GIT_SHA?: string;
  BUILD_DEPLOYED_AT?: string;
}

function isAuthorizedRequest(request: Request, env: Env): boolean {
  const expectedToken = env.INTERNAL_API_BEARER_TOKEN?.trim();
  if (!expectedToken) {
    return false;
  }
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return false;
  }
  const providedToken = authHeader.slice("bearer ".length).trim();
  return providedToken.length > 0 && providedToken === expectedToken;
}

function readAuthorizedOrganizationId(request: Request): string | null {
  const organizationId = request.headers.get("x-organization-id")?.trim();
  if (!organizationId) {
    return null;
  }
  return organizationId;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "ask-thane-api" });
    }

    if (url.pathname === "/build-info") {
      return Response.json({
        ok: true,
        service: "ask-thane-api",
        environment: env.BUILD_ENV ?? "unknown",
        gitSha: env.BUILD_GIT_SHA ?? "unknown",
        deployedAt: env.BUILD_DEPLOYED_AT ?? "unknown"
      });
    }

    if (url.pathname.startsWith("/v1/tasks/") && !isAuthorizedRequest(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const authorizedOrganizationId =
      url.pathname.startsWith("/v1/tasks/") ? readAuthorizedOrganizationId(request) : null;
    if (url.pathname.startsWith("/v1/tasks/") && !authorizedOrganizationId) {
      return Response.json({ error: "missing organization scope" }, { status: 403 });
    }

    if (url.pathname === "/v1/tasks/open") {
      const workspaceId = url.searchParams.get("workspace_id") || "";
      const assigneeId = url.searchParams.get("assignee_id") || "";
      const organizationId = url.searchParams.get("organization_id")?.trim();

      if (!workspaceId || !assigneeId) {
        return Response.json(
          { error: "workspace_id and assignee_id are required" },
          { status: 400 }
        );
      }

      if (organizationId && organizationId !== authorizedOrganizationId) {
        return Response.json({ error: "organization scope mismatch" }, { status: 403 });
      }

      const repo = new D1TaskRepository(env.DB);
      const tasks = await repo.listOpenByAssigneeInOrganization(
        authorizedOrganizationId!,
        workspaceId,
        assigneeId
      );
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

      if (organizationId !== authorizedOrganizationId) {
        return Response.json({ error: "organization scope mismatch" }, { status: 403 });
      }

      const repo = new D1TaskRepository(env.DB);
      const tasks = await repo.listOpenByAssigneeWithAcl({
        organizationId: authorizedOrganizationId!,
        assigneeId,
        readableConversationSourceIds,
        allowUnscoped
      });
      return Response.json({ tasks });
    }

    return new Response("Not Found", { status: 404 });
  }
};
