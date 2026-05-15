import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const listOpenByAssignee = vi.fn();
const listOpenByAssigneeWithAcl = vi.fn();

vi.mock("@ask-thane/data", () => ({
  D1TaskRepository: class {
    listOpenByAssignee = listOpenByAssignee;
    listOpenByAssigneeWithAcl = listOpenByAssigneeWithAcl;
  }
}));

describe("@ask-thane/api-worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves health", async () => {
    const res = await worker.fetch(new Request("https://api.local/health"), { DB: {} } as never);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "ask-thane-api"
    });
  });

  it("validates required params for open tasks endpoint", async () => {
    const res = await worker.fetch(new Request("https://api.local/v1/tasks/open"), { DB: {} } as never);
    expect(res.status).toBe(400);
  });

  it("returns open tasks", async () => {
    listOpenByAssignee.mockResolvedValueOnce([{ id: "task_1" }]);
    const res = await worker.fetch(
      new Request("https://api.local/v1/tasks/open?workspace_id=ws_1&assignee_id=U1"),
      { DB: {} } as never
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      tasks: [{ id: "task_1" }]
    });
    expect(listOpenByAssignee).toHaveBeenCalledWith("ws_1", "U1");
  });

  it("returns ACL-visible open tasks", async () => {
    listOpenByAssigneeWithAcl.mockResolvedValueOnce([{ id: "task_2" }]);
    const res = await worker.fetch(
      new Request(
        "https://api.local/v1/tasks/open-visible?organization_id=org_0&assignee_id=U1&readable_conversation_source_ids=conv_1,conv_2&allow_unscoped=true"
      ),
      { DB: {} } as never
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
});
