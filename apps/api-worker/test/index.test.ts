import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const listOpenByAssigneeInOrganization = vi.fn();
const listOpenByAssigneeWithAcl = vi.fn();
const saveManyTasks = vi.fn();

vi.mock("@ask-thane/data", () => ({
  D1TaskRepository: class {
    saveMany = saveManyTasks;
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

function createAuthStartDbMock(rateRows: Array<{ id?: string; window_started_at?: string; count?: number } | null> = []) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const first = vi.fn(async () => rateRows.shift() ?? null);
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...args: unknown[]) => {
      calls.push({ sql, args });
      return sql.includes("FROM thane_cli_rate_limits") ? { first } : { run };
    })
  }));
  return { calls, first, prepare, run };
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

  it("allows browser preflight requests for Thane CLI endpoints", async () => {
    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/auth/start", {
        method: "OPTIONS",
        headers: { origin: "https://chat.askthane.com" }
      }),
      env
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://chat.askthane.com");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("starts Thane CLI auth by sending a verification email", async () => {
    const db = createAuthStartDbMock();
    const sendEmail = vi.fn(async () => ({ messageId: "email_1" }));
    const authEnv = {
      DB: { prepare: db.prepare },
      EMAIL: { send: sendEmail },
      BUILD_ENV: "production",
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
    expect(sendEmail).toHaveBeenCalledWith({
      from: "Thane <noreply@askthane.com>",
      to: "garrett@example.com",
      subject: "Your Thane Chat verification code",
      text: expect.stringContaining("Your Thane Chat verification code is ")
    });
    const authInsert = db.calls.find((call) => call.sql.includes("INSERT INTO thane_cli_auth_codes"));
    expect(authInsert?.args[1]).toBe("garrett@example.com");
    expect(authInsert?.args[2]).toBe("Garrett");
    expect(authInsert?.args[4]).toBe("email");
  });

  it("returns a Thane CLI dev verification code when email is not configured locally", async () => {
    const db = createAuthStartDbMock();
    const authEnv = {
      DB: { prepare: db.prepare },
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
    const authInsert = db.calls.find((call) => call.sql.includes("INSERT INTO thane_cli_auth_codes"));
    expect(authInsert?.args[4]).toBe("dev_code");
  });

  it("rejects Thane CLI auth start in production when email is not configured", async () => {
    const db = createAuthStartDbMock();
    const authEnv = {
      DB: { prepare: db.prepare },
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
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO thane_cli_auth_codes"))).toBe(false);
  });

  it("rate limits Thane CLI auth email sends before sending email", async () => {
    const db = createAuthStartDbMock([
      {
        id: "rl_email",
        window_started_at: new Date(Date.now() - 60_000).toISOString(),
        count: 5
      }
    ]);
    const sendEmail = vi.fn(async () => ({ messageId: "email_1" }));
    const authEnv = {
      DB: { prepare: db.prepare },
      EMAIL: { send: sendEmail },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/auth/start", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ email: "garrett@example.com" })
      }),
      authEnv
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "rate_limited" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO thane_cli_auth_codes"))).toBe(false);
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
      EMAIL: { send: vi.fn(async () => ({ messageId: "email_1" })) }
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

  it("starts Thane CLI MFA setup with QR code renderings", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const noMfa = vi.fn(async () => null);
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        if (sql.includes("FROM thane_cli_mfa_factors")) {
          return { first: noMfa };
        }
        return { run };
      })
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/mfa/setup/start", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("garrett@example.com")}` }
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      factorId: expect.stringMatching(/^mfa_/),
      secret: expect.stringMatching(/^[A-Z2-7]+$/),
      otpauthUrl: expect.stringContaining("otpauth://totp/Thane%20Chat:garrett%40example.com")
    });
    expect(body.qrSvg).toContain("<svg");
    expect(body.qrTerminal).toMatch(/[█▀▄]/);
    expect(calls.some((call) => call.sql.includes("INSERT INTO thane_cli_mfa_factors"))).toBe(true);
  });

  it("updates the hosted Thane CLI profile display name", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const run = vi.fn(async () => ({ meta: { changes: 2 } }));
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return { display_name: "G.P." };
      }
      return null;
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        return sql.includes("SELECT display_name") ? { first: first.bind({ sql }) } : { run };
      })
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/profile", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("garrett@example.com")}` },
        body: JSON.stringify({ displayName: " G.P. " })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      displayName: "G.P.",
      account: {
        email: "garrett@example.com",
        displayName: "G.P."
      }
    });
    const update = calls.find((call) => call.sql.includes("UPDATE thane_cli_workspace_members SET display_name"));
    expect(update?.args[0]).toBe("G.P.");
    expect(update?.args[2]).toBe("garrett@example.com");
  });

  it("updates only the active workspace display name when a workspace is provided", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return {
          id: "member_1",
          account_id: "acct_1",
          email: "garrett@example.com",
          display_name: "Garrett",
          handle: "garrett.m.petersen",
          role: "owner"
        };
      }
      if (sql.includes("FROM thane_cli_account_profiles")) {
        return { display_name: "Garrett Default" };
      }
      return null;
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        return sql.startsWith("SELECT") ? { first: first.bind({ sql }) } : { run };
      })
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/profile", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("garrett@example.com")}` },
        body: JSON.stringify({ displayName: " GP ", workspaceId: "wsp_1", scope: "workspace" })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      scope: "workspace",
      workspaceId: "wsp_1",
      displayName: "GP",
      workspaceDisplayName: "GP",
      account: {
        displayName: "Garrett Default"
      }
    });
    const update = calls.find((call) => call.sql.startsWith("UPDATE thane_cli_workspace_members SET display_name") && call.sql.includes("WHERE workspace_id = ? AND email = ?"));
    expect(update?.args).toEqual(["GP", expect.any(String), "wsp_1", "garrett@example.com"]);
    expect(calls.some((call) => call.sql.includes("UPDATE thane_cli_workspace_members SET display_name = ?, updated_at = ? WHERE email = ?"))).toBe(false);
  });

  it("updates the account default display name without rewriting workspace memberships", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        return { run };
      })
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/profile", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("garrett@example.com")}` },
        body: JSON.stringify({ displayName: " Garrett Petersen ", scope: "account" })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      scope: "account",
      displayName: "Garrett Petersen",
      accountDisplayName: "Garrett Petersen",
      account: {
        displayName: "Garrett Petersen"
      }
    });
    expect(calls.some((call) => call.sql.includes("thane_cli_account_profiles"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE thane_cli_workspace_members"))).toBe(false);
  });

  it("opens a hosted Thane Chat event stream for workspace members", async () => {
    const streamResponse = new Response('data: {"type":"connected"}\n\n', {
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    });
    const objectFetch = vi.fn(async () => streamResponse);
    const eventObject = { fetch: objectFetch };
    const idFromName = vi.fn((name: string) => name);
    const get = vi.fn(() => eventObject);
    const first = vi.fn(async () => ({
      id: "member_1",
      account_id: "acct_1",
      email: "garrett@example.com",
      display_name: "Garrett",
      handle: "garrett",
      role: "owner"
    }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        expect(sql).toContain("FROM thane_cli_workspace_members");
        expect(args).toEqual(["wsp_1", "garrett@example.com"]);
        return { first };
      })
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret",
      THANE_CHAT_EVENTS: { idFromName, get }
    } as never;

    const token = await signAuthToken("garrett@example.com");
    const res = await worker.fetch(
      new Request(`https://api.local/v1/thane-cli/events?workspaceId=wsp_1&authToken=${token}`, {
        headers: {
          accept: "text/event-stream",
          origin: "https://chat.askthane.com"
        }
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://chat.askthane.com");
    expect(idFromName).toHaveBeenCalledWith("wsp_1");
    expect(get).toHaveBeenCalledWith("wsp_1");
    expect(objectFetch).toHaveBeenCalledWith("https://thane-chat-events.local/stream", { method: "GET" });
  });

  it("includes reactions in Thane CLI sync responses", async () => {
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("SELECT display_name")) {
        return { display_name: "Owner" };
      }
      return null;
    });
    const all = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members m")) {
        return {
          results: [
            {
              id: "wsp_1",
              workspace_slug: "acme",
              workspace_name: "Acme",
              ascii_art: null,
              created_at: "2026-06-18T00:00:00.000Z",
              role: "owner"
            }
          ]
        };
      }
      if (sql.includes("FROM thane_cli_workspace_members") && !sql.includes("JOIN")) {
        return {
          results: [
            {
              id: "tcm_1",
              account_id: "acct_1",
              email: "owner@example.com",
              display_name: "Owner",
              handle: "owner",
              role: "owner",
              joined_at: "2026-06-18T00:00:00.000Z"
            },
            {
              id: "tcm_2",
              account_id: "acct_2",
              email: "alex@example.com",
              display_name: "Alex",
              handle: "alex",
              role: "member",
              joined_at: "2026-06-18T00:00:00.000Z"
            }
          ]
        };
      }
      if (sql.includes("FROM thane_cli_channels")) {
        return {
          results: [
            {
              id: "tcc_1",
              workspace_id: "wsp_1",
              name: "general",
              kind: "channel",
              visibility: "public",
              topic: "General",
              created_at: "2026-06-18T00:00:00.000Z"
            }
          ]
        };
      }
      if (sql.includes("FROM thane_cli_chat_messages")) {
        return {
          results: [
            {
              id: "tmsg_1",
              workspace_id: "wsp_1",
              channel_id: "tcc_1",
              author_member_id: "tcm_1",
              text: "hello",
              source: "chat",
              thread_root_id: null,
              created_at: "2026-06-18T00:00:00.000Z"
            }
          ]
        };
      }
      if (sql.includes("FROM thane_cli_message_reactions")) {
        return {
          results: [
            {
              message_id: "tmsg_1",
              emoji: "👍",
              created_at: "2026-06-18T00:01:00.000Z",
              handle: "alex"
            }
          ]
        };
      }
      return { results: [] };
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => (sql.includes("SELECT display_name") ? { first: first.bind({ sql }) } : { all: all.bind({ sql }) }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/sync?workspaceId=wsp_1", {
        headers: { Authorization: `Bearer ${await signAuthToken("owner@example.com")}` }
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account.displayName).toBe("Owner");
    expect(body.messages[0].reactions).toEqual([
      {
        emoji: "👍",
        by: "alex",
        createdAt: "2026-06-18T00:01:00.000Z"
      }
    ]);
  });

  it("creates Thane CLI workspace invite links", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const sendEmail = vi.fn(async () => ({ messageId: "email_1" }));
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspaces")) {
        return { id: "wsp_1", workspace_slug: "acme-inc", workspace_name: "Acme Inc", ascii_art: null };
      }
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return {
          id: "tcm_1",
          account_id: "acct_1",
          email: "owner@example.com",
          display_name: "Owner",
          handle: "owner",
          role: "owner"
        };
      }
      if (sql.includes("FROM thane_cli_channels")) {
        return {
          id: "tcc_1",
          workspace_id: "wsp_1",
          name: "general",
          visibility: "public",
          topic: "Default team chat",
          created_at: new Date().toISOString()
        };
      }
      return null;
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        calls.push({ sql, args });
        return { run, first: first.bind({ sql }) };
      })
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret",
      THANE_CLI_INVITE_BASE_URL: "https://api.askthane.com/invite",
      EMAIL: { send: sendEmail }
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/workspace-invites", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("owner@example.com")}` },
        body: JSON.stringify({
          workspaceId: "wsp_1",
          workspaceSlug: "Acme Inc",
          workspaceName: "Acme Inc",
          inviteeEmail: "alex@example.com",
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
        maxUses: 10,
        inviteeEmail: "alex@example.com",
        emailSent: true
      }
    });
    expect(body.invite.url).toContain("https://api.askthane.com/invite/");
    expect(body.invite.webUrl).toContain("https://chat.askthane.com/invite/");
    expect(body.invite.webUrl).toContain("email=alex%40example.com");
    expect(sendEmail).toHaveBeenCalledWith({
      from: "Thane <noreply@askthane.com>",
      to: "alex@example.com",
      subject: expect.stringContaining("invited you to Acme Inc"),
      text: expect.stringContaining("Accept in the web app:")
    });
    expect(sendEmail.mock.calls[0]?.[0].text).toContain("https://chat.askthane.com/invite/");
    expect(sendEmail.mock.calls[0]?.[0].text).toContain("thane invite-link accept https://api.askthane.com/invite/");
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO thane_cli_workspace_invites"));
    const inviteInsert = calls.find((call) => call.sql.includes("INSERT INTO thane_cli_workspace_invites"));
    expect(inviteInsert?.args[2]).toBe("wsp_1");
    expect(inviteInsert?.args[3]).toBe("acme-inc");
    expect(inviteInsert?.args[6]).toBe("owner@example.com");
    expect(inviteInsert?.args[10]).toBe("alex@example.com");
  });

  it("rejects Thane CLI workspace invite creation by non-admin members", async () => {
    const sendEmail = vi.fn(async () => ({ messageId: "email_1" }));
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspaces")) {
        return { id: "wsp_1", workspace_slug: "acme-inc", workspace_name: "Acme Inc", ascii_art: null };
      }
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return {
          id: "tcm_1",
          account_id: "acct_1",
          email: "member@example.com",
          display_name: "Member",
          handle: "member",
          role: "member"
        };
      }
      return null;
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ run, first: first.bind({ sql }) }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret",
      EMAIL: { send: sendEmail }
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/workspace-invites", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("member@example.com")}` },
        body: JSON.stringify({
          workspaceId: "wsp_1",
          workspaceSlug: "Acme Inc",
          workspaceName: "Acme Inc",
          inviteeEmail: "alex@example.com",
          role: "member",
          expiresInHours: 24
        })
      }),
      authEnv
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "workspace_admin_required" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO thane_cli_workspace_invites"));
  });

  it("rejects new private channels when a free Thane Chat workspace reaches the limit", async () => {
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return {
          id: "tcm_1",
          account_id: "acct_1",
          email: "owner@example.com",
          display_name: "Owner",
          handle: "owner",
          role: "owner"
        };
      }
      if (sql.includes("SELECT id, visibility FROM thane_cli_channels")) {
        return null;
      }
      if (sql.includes("SELECT plan_tier FROM thane_cli_workspaces")) {
        return { plan_tier: "free" };
      }
      if (sql.includes("COUNT(*) AS count FROM thane_cli_channels")) {
        return { count: 10 };
      }
      return null;
    });
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ run, first: first.bind({ sql }) }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/channels", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("owner@example.com")}` },
        body: JSON.stringify({
          workspaceId: "wsp_1",
          name: "private-plans",
          private: true
        })
      }),
      authEnv
    );

    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "thane_chat_private_channel_limit_reached",
      limit: 10
    });
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO thane_cli_channels"));
  });

  it("allows new private channels for cli_team Thane Chat workspaces", async () => {
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return {
          id: "tcm_1",
          account_id: "acct_1",
          email: "owner@example.com",
          display_name: "Owner",
          handle: "owner",
          role: "owner"
        };
      }
      if (sql.includes("SELECT id, visibility FROM thane_cli_channels")) {
        return null;
      }
      if (sql.includes("SELECT plan_tier FROM thane_cli_workspaces")) {
        return { plan_tier: "cli_team" };
      }
      if (sql.includes("COUNT(*) AS count FROM thane_cli_channels")) {
        return { count: 10 };
      }
      if (sql.includes("SELECT id, workspace_id, name, kind, visibility, topic, created_at")) {
        return {
          id: "tcc_2",
          workspace_id: "wsp_1",
          name: "private-plans",
          kind: "channel",
          visibility: "private",
          topic: null,
          created_at: "2026-06-18T00:00:00.000Z"
        };
      }
      return null;
    });
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ run, first: first.bind({ sql }) }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/channels", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("owner@example.com")}` },
        body: JSON.stringify({
          workspaceId: "wsp_1",
          name: "private-plans",
          private: true
        })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      channel: {
        id: "tcc_2",
        workspaceId: "wsp_1",
        name: "private-plans",
        visibility: "private"
      }
    });
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO thane_cli_channels"));
  });

  it.each([
    ["raw token", "token_123"],
    ["API invite URL", "https://api.askthane.com/invite/token_123"],
    ["web invite URL", "https://chat.askthane.com/invite/token_123"]
  ])("accepts valid Thane CLI workspace invite links from a %s", async (_label, inviteToken) => {
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
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("SELECT id, workspace_id")) {
        return inviteRow;
      }
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return {
          id: "tcm_1",
          account_id: "acct_1",
          email: "alex@example.com",
          display_name: "Alex",
          handle: "alex",
          role: "member"
        };
      }
      return null;
    });
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ run, first: first.bind({ sql }) }))
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
        body: JSON.stringify({ token: inviteToken })
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

  it("rejects invite acceptance for new members when a free Thane Chat workspace reaches the limit", async () => {
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
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("SELECT id, workspace_id")) {
        return inviteRow;
      }
      if (sql.includes("COUNT(*) AS count FROM thane_cli_workspace_members")) {
        return { count: 100 };
      }
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return null;
      }
      if (sql.includes("SELECT plan_tier FROM thane_cli_workspaces")) {
        return { plan_tier: "free" };
      }
      return null;
    });
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ run, first: first.bind({ sql }) }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/workspace-invites/accept", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("new@example.com")}` },
        body: JSON.stringify({ token: "token_123" })
      }),
      authEnv
    );

    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "thane_chat_member_limit_reached",
      limit: 100
    });
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE thane_cli_workspace_invites"));
  });

  it("rejects targeted invite acceptance from a different email", async () => {
    const inviteRow = {
      id: "inv_1",
      workspace_id: "wsp_1",
      workspace_slug: "acme",
      workspace_name: "Acme Inc",
      role: "member",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
      accepted_count: 0,
      max_uses: 1,
      invitee_email: "alex@example.com"
    };
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("SELECT id, workspace_id")) {
        return inviteRow;
      }
      return null;
    });
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ run, first: first.bind({ sql }) }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/workspace-invites/accept", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("different@example.com")}` },
        body: JSON.stringify({ token: "token_123" })
      }),
      authEnv
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "invite_email_mismatch" });
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE thane_cli_workspace_invites"));
  });

  it("creates Thane Chat billing links for workspace admins", async () => {
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return {
          id: "tcm_1",
          account_id: "acct_1",
          email: "owner@example.com",
          display_name: "Owner",
          handle: "owner",
          role: "owner"
        };
      }
      if (sql.includes("FROM thane_cli_workspaces")) {
        return {
          id: "wsp_1",
          workspace_slug: "acme",
          plan_tier: "free"
        };
      }
      return null;
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ first: first.bind({ sql }) }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret",
      BILLING_LINK_SIGNING_SECRET: "billing-secret",
      THANE_PAYMENTS_BASE_URL: "https://payments.askthane.com"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/billing/link", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("owner@example.com")}` },
        body: JSON.stringify({ workspaceId: "wsp_1", returnUrl: "https://chat.askthane.com/" })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      billing: {
        workspaceId: "wsp_1",
        planTier: "free",
        targetPlanTier: "cli_team"
      }
    });
    expect(body.billing.checkoutUrl).toContain("https://payments.askthane.com/subscribe?");
    expect(body.billing.checkoutUrl).toContain("plan_tier=cli_team");
    expect(body.billing.checkoutUrl).toContain("billing_token=");
    expect(body.billing.portalUrl).toContain("billing_token=");
  });

  it("rejects Thane Chat billing links for non-admin members", async () => {
    const first = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members")) {
        return {
          id: "tcm_1",
          account_id: "acct_1",
          email: "member@example.com",
          display_name: "Member",
          handle: "member",
          role: "member"
        };
      }
      return null;
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({ first: first.bind({ sql }) }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret",
      BILLING_LINK_SIGNING_SECRET: "billing-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/billing/link", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("member@example.com")}` },
        body: JSON.stringify({ workspaceId: "wsp_1" })
      }),
      authEnv
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "workspace_admin_required" });
  });

  it("enables native Ask Thane for workspace admins", async () => {
    const first = vi.fn(async function (this: { sql?: string; args?: unknown[] }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members") && sql.includes("email = ?")) {
        if (this.args?.[1] === "thane@askthane.com") {
          return {
            id: "tcm_thane",
            account_id: "acct_thane",
            email: "thane@askthane.com",
            display_name: "Ask Thane",
            handle: "thane",
            role: "member"
          };
        }
        return {
          id: "tcm_owner",
          account_id: "acct_owner",
          email: "owner@example.com",
          display_name: "Owner",
          handle: "owner",
          role: "owner"
        };
      }
      if (sql.includes("FROM thane_cli_workspace_members") && sql.includes("id = ?")) {
        return {
          id: "tcm_thane",
          account_id: "acct_thane",
          email: "thane@askthane.com",
          display_name: "Ask Thane",
          handle: "thane",
          role: "member"
        };
      }
      if (sql.includes("FROM thane_cli_ask_thane_integrations")) {
        return {
          workspace_id: "wsp_1",
          enabled: 1,
          bot_member_id: "tcm_thane",
          linked_account_email: "owner@example.com",
          connected_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:00:00.000Z",
          last_event_at: "2026-06-18T00:00:00.000Z"
        };
      }
      return null;
    });
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => ({ run, first: first.bind({ sql, args }) }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/ask-thane/enable", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("owner@example.com")}` },
        body: JSON.stringify({ workspaceId: "wsp_1" })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      integration: {
        workspaceId: "wsp_1",
        enabled: true,
        botUserId: "tcm_thane",
        linkedAccountEmail: "owner@example.com"
      }
    });
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO thane_cli_ask_thane_integrations"));
  });

  it("posts a native Ask Thane reply when mentioned in Thane Chat", async () => {
    const insertedMessages: Array<{ args: unknown[] }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Native Ask Thane reply." } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const first = vi.fn(async function (this: { sql?: string; args?: unknown[] }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members") && sql.includes("email = ?")) {
        if (this.args?.[1] === "thane@askthane.com") {
          return {
            id: "tcm_thane",
            account_id: "acct_thane",
            email: "thane@askthane.com",
            display_name: "Ask Thane",
            handle: "thane",
            role: "member"
          };
        }
        return {
          id: "tcm_owner",
          account_id: "acct_owner",
          email: "owner@example.com",
          display_name: "Owner",
          handle: "owner",
          role: "owner"
        };
      }
      if (sql.includes("SELECT id, workspace_name, workspace_slug")) {
        return { id: "wsp_1", workspace_name: "Acme", workspace_slug: "acme" };
      }
      if (sql.includes("SELECT id, name, kind, visibility FROM thane_cli_channels")) {
        return { id: "tcc_1", name: "general", kind: "channel", visibility: "public" };
      }
      if (sql.includes("FROM thane_cli_ask_thane_integrations")) {
        return {
          workspace_id: "wsp_1",
          enabled: 1,
          bot_member_id: "tcm_thane",
          linked_account_email: "owner@example.com",
          connected_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:00:00.000Z",
          last_event_at: null
        };
      }
      if (sql.includes("FROM thane_cli_workspace_members") && sql.includes("id = ?")) {
        return {
          id: "tcm_thane",
          account_id: "acct_thane",
          email: "thane@askthane.com",
          display_name: "Ask Thane",
          handle: "thane",
          role: "member"
        };
      }
      return null;
    });
    const all = vi.fn(async function (this: { sql?: string }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_chat_messages")) {
        return {
          results: [
            {
              id: "tmsg_user",
              text: "hello @thane",
              created_at: "2026-06-18T00:00:00.000Z",
              thread_root_id: null,
              handle: "owner"
            }
          ]
        };
      }
      return { results: [] };
    });
    const run = vi.fn(async function (this: { sql?: string; args?: unknown[] }) {
      if ((this.sql ?? "").includes("INSERT INTO thane_cli_chat_messages")) {
        insertedMessages.push({ args: this.args ?? [] });
      }
      return { meta: { changes: 1 } };
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        run: run.bind({ sql, args }),
        first: first.bind({ sql }),
        all: all.bind({ sql })
      }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret",
      OPENAI_API_KEY: "sk-test",
      DEFAULT_LLM_MODEL: "gpt-4.1-mini"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("owner@example.com")}` },
        body: JSON.stringify({ workspaceId: "wsp_1", channelId: "tcc_1", text: "hello @thane", source: "chat" })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.askThaneReply).toMatchObject({ text: "Native Ask Thane reply." });
    expect(insertedMessages).toHaveLength(2);
    expect(insertedMessages[1]?.args[4]).toBe("Native Ask Thane reply.");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("extracts tasks passively from native Thane Chat messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reasoning_summary: "assigned native task",
                    tasks: [
                      {
                        title: "Review onboarding notes",
                        description: "Look over the draft before launch.",
                        assignee_user_id: "danika",
                        assignee_name: "Danika",
                        urgency: "medium",
                        difficulty: "medium",
                        status: "incomplete",
                        confidence: 0.92,
                        due_at: null
                      }
                    ]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const first = vi.fn(async function (this: { sql?: string; args?: unknown[] }) {
      const sql = this.sql ?? "";
      if (sql.includes("FROM thane_cli_workspace_members") && sql.includes("email = ?")) {
        return {
          id: "tcm_owner",
          account_id: "acct_owner",
          email: "owner@example.com",
          display_name: "Owner",
          handle: "owner",
          role: "owner"
        };
      }
      if (sql.includes("SELECT id, workspace_name, workspace_slug")) {
        return { id: "wsp_1", workspace_name: "Acme", workspace_slug: "acme" };
      }
      if (sql.includes("SELECT id, name, kind, visibility FROM thane_cli_channels")) {
        return { id: "tcc_1", name: "general", kind: "channel", visibility: "public" };
      }
      if (sql.includes("SELECT plan_tier FROM thane_cli_workspaces")) {
        return { plan_tier: "cli_team" };
      }
      if (sql.includes("COUNT(*) AS count FROM thane_cli_workspace_members")) {
        return { count: 2 };
      }
      if (sql.includes("SUM(total_cost_usd)")) {
        return { total: 0 };
      }
      if (sql.includes("SELECT external_user_id FROM users")) {
        return { external_user_id: this.args?.[2] ?? null };
      }
      return null;
    });
    const run = vi.fn(async function (this: { sql?: string; args?: unknown[] }) {
      return { meta: { changes: 1 } };
    });
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        run: run.bind({ sql, args }),
        first: first.bind({ sql, args }),
        all: vi.fn(async () => ({ results: [] }))
      }))
    }));
    const authEnv = {
      DB: { prepare },
      BUILD_ENV: "production",
      THANE_CLI_AUTH_SECRET: "test-secret",
      OPENAI_API_KEY: "sk-test",
      DEFAULT_LLM_MODEL: "gpt-4.1-mini"
    } as never;

    const res = await worker.fetch(
      new Request("https://api.local/v1/thane-cli/messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${await signAuthToken("owner@example.com")}` },
        body: JSON.stringify({
          workspaceId: "wsp_1",
          channelId: "tcc_1",
          text: "@danika please review the onboarding notes",
          source: "chat"
        })
      }),
      authEnv
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, passiveTaskCount: 1 });
    expect(saveManyTasks).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Review onboarding notes",
        assignee: expect.objectContaining({
          platform: "thane_cli",
          platformUserId: "danika",
          displayName: "Danika"
        }),
        assigner: expect.objectContaining({
          platform: "thane_cli",
          platformUserId: "owner",
          displayName: "Owner"
        })
      })
    ]);
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
      max_uses: null,
      invitee_email: "alex@example.com"
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
    expect(html).toContain("Accept in Thane Chat");
    expect(html).toContain("https://chat.askthane.com/invite/token_123?email=alex%40example.com");
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
