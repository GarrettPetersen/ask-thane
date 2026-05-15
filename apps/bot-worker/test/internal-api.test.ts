import { afterEach, describe, expect, it, vi } from "vitest";
import { listOpenTasksViaApi, listOpenVisibleTasksViaApi } from "../src/services/internal-api";

describe("internal API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fails closed when API base URL is missing", async () => {
    await expect(
      listOpenTasksViaApi(
        {
          INTERNAL_API_BEARER_TOKEN: "token-only"
        },
        {
          workspaceId: "ws_1",
          assigneeId: "U1"
        }
      )
    ).rejects.toThrow("missing_tasks_api_base_url");
  });

  it("sends bearer auth header for open tasks route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [{ id: "task_1" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const tasks = await listOpenTasksViaApi(
      {
        TASKS_API_BASE_URL: "https://ask-thane-api.example.workers.dev",
        INTERNAL_API_BEARER_TOKEN: "internal-secret"
      },
      {
        workspaceId: "ws_1",
        assigneeId: "U1"
      }
    );

    expect(tasks).toEqual([{ id: "task_1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v1/tasks/open");
    expect(parsed.searchParams.get("workspace_id")).toBe("ws_1");
    expect(parsed.searchParams.get("assignee_id")).toBe("U1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer internal-secret");
  });

  it("formats open-visible ACL query parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tasks: [{ id: "task_2" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const tasks = await listOpenVisibleTasksViaApi(
      {
        TASKS_API_BASE_URL: "https://ask-thane-api.example.workers.dev/",
        INTERNAL_API_BEARER_TOKEN: "internal-secret"
      },
      {
        organizationId: "org_0",
        assigneeId: "U2",
        readableConversationSourceIds: ["conv_1", "conv_2"],
        allowUnscoped: true
      }
    );

    expect(tasks).toEqual([{ id: "task_2" }]);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v1/tasks/open-visible");
    expect(parsed.searchParams.get("organization_id")).toBe("org_0");
    expect(parsed.searchParams.get("assignee_id")).toBe("U2");
    expect(parsed.searchParams.get("readable_conversation_source_ids")).toBe("conv_1,conv_2");
    expect(parsed.searchParams.get("allow_unscoped")).toBe("true");
  });
});
