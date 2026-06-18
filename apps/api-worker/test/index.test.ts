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

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}

async function signAuthToken(email: string): Promise<string> {
  const payload = base64UrlEncode(
    JSON.stringify({
      email,
      purpose: "auth",
      exp: Math.floor(Date.now() / 1000) + 60
    })
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = base64UrlEncode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return `${payload}.${signature}`;
}

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
    vi.unstubAllGlobals();
  });

  it("serves health", async () => {
    const res = await worker.fetch(new Request("https://api.local/health"), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "ask-thane-api"
    });
  });

  it("starts Thane CLI auth by sending a verification email", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const fetchEmail = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchEmail);
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      RESEND_API_KEY: "resend_test",
      THANE_CLI_AUTH_SECRET: "test-secret",
      THANE_CLI_EMAIL_FROM: "Thane <noreply@askthane.com>"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/auth/start", {
        method: "POST",
        body: JSON.stringify({ email: " Garrett@Example.com ", displayName: "Garrett" })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      email: "garrett@example.com",
      delivery: "email"
    });
    expect(fetchEmail).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO thane_cli_auth_codes"));
    expect(bind.mock.calls[0]?.[1]).toBe("garrett@example.com");
    expect(bind.mock.calls[0]?.[2]).toBe("Garrett");
    expect(bind.mock.calls[0]?.[4]).toBe("email");
  });

  it("returns a Thane CLI dev verification code when email is not configured locally", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "local",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/auth/start", {
        method: "POST",
        body: JSON.stringify({ email: "dev@example.com" })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      email: "dev@example.com",
      delivery: "dev_code"
    });
    expect(body.verificationCode).toMatch(/^\d{6}$/);
    expect(bind.mock.calls[0]?.[4]).toBe("dev_code");
  });

  it("rejects Thane CLI auth start in production when email is not configured", async () => {
    const prepare = vi.fn();
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/auth/start", {
        method: "POST",
        body: JSON.stringify({ email: "garrett@example.com" })
      }),
      authEnv
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "email_not_configured" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("verifies Thane CLI auth codes and returns an account", async () => {
    const first = vi.fn(async () => ({
      id: "auth_1",
      display_name: "Garrett",
      expires_at: new Date(Date.now() + 60_000).toISOString()
    }));
    const noMfa = vi.fn(async () => null);
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => {
        if (sql.includes("SELECT id, display_name")) {
          return { first };
        }
        if (sql.includes("FROM thane_cli_mfa_factors")) {
          return { first: noMfa };
        }
        return { run };
      })
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret",
      RESEND_API_KEY: "resend_test"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/auth/verify", {
        method: "POST",
        body: JSON.stringify({ email: "garrett@example.com", code: "123456" })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      account: {
        email: "garrett@example.com",
        displayName: "Garrett"
      }
    });
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE thane_cli_auth_codes"));
  });

  it("creates Thane CLI workspace invite links", async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret",
      THANE_CLI_INVITE_BASE_URL: "https://api.askthane.com/invite"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/workspace-invites", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("owner@example.com")}` },
        body: JSON.stringify({
          workspaceId: "wsp_1",
          workspaceSlug: "Acme Inc",
          workspaceName: "Acme Inc",
          role: "member",
          expiresInHours: 24,
          maxUses: 10
        })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      invite: {
        workspace: { id: "wsp_1", slug: "acme-inc", name: "Acme Inc" },
        role: "member",
        maxUses: 10
      }
    });
    expect(body.invite.url).toContain("https://api.askthane.com/invite/");
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO thane_cli_workspace_invites"));
    expect(bind.mock.calls[0]?.[2]).toBe("wsp_1");
    expect(bind.mock.calls[0]?.[3]).toBe("acme-inc");
    expect(bind.mock.calls[0]?.[6]).toBe("owner@example.com");
  });

  it("accepts valid Thane CLI workspace invite links", async () => {
    const inviteRow = {
      id: "inv_1",
      workspace_id: "wsp_1",
      workspace_slug: "acme",
      workspace_name: "Acme Inc",
      role: "member",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
      accepted_count: 0,
      max_uses: null
    };
    const first = vi.fn(async () => inviteRow);
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => (sql.includes("SELECT id, workspace_id") ? { first } : { run }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/workspace-invites/accept", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("alex@example.com")}` },
        body: JSON.stringify({ token: "https://api.askthane.com/invite/token_123" })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      acceptedBy: "alex@example.com",
      workspace: {
        id: "wsp_1",
        slug: "acme",
        name: "Acme Inc",
        role: "member"
      }
    });
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE thane_cli_workspace_invites"));
  });

  it("renders browser-friendly Thane CLI invite pages", async () => {
    const inviteRow = {
      id: "inv_1",
      workspace_id: "wsp_1",
      workspace_slug: "acme",
      workspace_name: "Acme Inc",
      role: "member",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
      accepted_count: 0,
      max_uses: null
    };
    const first = vi.fn(async () => inviteRow);
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({ first }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(new Request("https://api.askthane.com/invite/token_123"), authEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Join Acme Inc");
    expect(html).toContain("npm install -g @ask-thane/thane-cli");
    expect(html).toContain("thane init");
    expect(html).toContain("thane invite-link accept https://api.askthane.com/invite/token_123");
  });

  it("renders browser-friendly Thane CLI invite errors", async () => {
    const first = vi.fn(async () => null);
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({ first }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(new Request("https://api.askthane.com/invite/not-real-token"), authEnv);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Invite unavailable");
    expect(html).toContain("fresh link");
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
