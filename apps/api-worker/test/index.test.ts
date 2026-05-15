import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const listOpenByAssigneeInOrganization = vi.fn();
const listOpenByAssigneeWithAcl = vi.fn();

vi.mock("@ask-thane/data", () => ({
  D1TaskRepository: class {
    listOpenByAssigneeInOrganization = listOpenByAssigneeInOrganization;
    listOpenByAssigneeWithAcl = listOpenByAssigneeWithAcl;
  }
}));

describe("@ask-thane/api-worker", () => {
  const env = {
    DB: {},
    INTERNAL_API_BEARER_TOKEN: "test-internal-token"
  } as never;

  const authHeaders = {
    Authorization: "Bearer test-internal-token",
    "x-organization-id": "org_0"
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves health", async () => {
    const res = await worker.fetch(new Request("https://api.local/health"), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "ask-thane-api"
    });
  });

  it("validates required params for open tasks endpoint", async () => {
    const res = await worker.fetch(
      new Request("https://api.local/v1/tasks/open", { headers: authHeaders }),
      env
    );
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests to task endpoints", async () => {
    const res = await worker.fetch(new Request("https://api.local/v1/tasks/open"), env);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects task requests without authenticated org scope header", async () => {
    const res = await worker.fetch(
      new Request("https://api.local/v1/tasks/open?workspace_id=ws_1&assignee_id=U1", {
        headers: {
          Authorization: "Bearer test-internal-token"
        }
      }),
      env
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "missing organization scope" });
  });

  it("returns open tasks", async () => {
    listOpenByAssigneeInOrganization.mockResolvedValueOnce([{ id: "task_1" }]);
    const res = await worker.fetch(
      new Request("https://api.local/v1/tasks/open?organization_id=org_0&workspace_id=ws_1&assignee_id=U1", {
        headers: authHeaders
      }),
      env
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      tasks: [{ id: "task_1" }]
    });
    expect(listOpenByAssigneeInOrganization).toHaveBeenCalledWith("org_0", "ws_1", "U1");
  });

  it("rejects org mismatch for open task requests", async () => {
    const res = await worker.fetch(
      new Request("https://api.local/v1/tasks/open?organization_id=org_other&workspace_id=ws_1&assignee_id=U1", {
        headers: authHeaders
      }),
      env
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "organization scope mismatch" });
  });

  it("returns ACL-visible open tasks", async () => {
    listOpenByAssigneeWithAcl.mockResolvedValueOnce([{ id: "task_2" }]);
    const res = await worker.fetch(
      new Request(
        "https://api.local/v1/tasks/open-visible?organization_id=org_0&assignee_id=U1&readable_conversation_source_ids=conv_1,conv_2&allow_unscoped=true",
        { headers: authHeaders }
      ),
      env
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      tasks: [{ id: "task_2" }]
    });
    expect(listOpenByAssigneeWithAcl).toHaveBeenCalledWith({
      organizationId: "org_0",
      assigneeId: "U1",
      readableConversationSourceIds: ["conv_1", "conv_2"],
      allowUnscoped: true
    });
  });

  it("rejects org mismatch for open-visible requests", async () => {
    const res = await worker.fetch(
      new Request(
        "https://api.local/v1/tasks/open-visible?organization_id=org_other&assignee_id=U1&readable_conversation_source_ids=conv_1",
        { headers: authHeaders }
      ),
      env
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "organization scope mismatch" });
  });
});
