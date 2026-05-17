import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

function makeDbStub() {
  const run = vi.fn(async () => ({ meta: { changes: 1 } }));
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return { prepare, bind, run };
}

function makeMetricsDbStub() {
  const prepare = vi.fn((sql: string) => {
    const first = async () => {
      if (sql.includes("(SELECT COUNT(*) FROM organizations)")) {
        return {
          organizations: 2,
          workspaces: 4,
          users: 10,
          tasks: 20,
          installs: 3
        };
      }
      return { count_before: 0 };
    };
    return {
      first,
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes("COUNT(*) AS count_before FROM organizations")) {
            return { count_before: 1 };
          }
          if (sql.includes("COUNT(*) AS count_before FROM workspaces")) {
            return { count_before: 2 };
          }
          if (sql.includes("COUNT(*) AS count_before FROM users")) {
            return { count_before: 6 };
          }
          if (sql.includes("COUNT(*) AS count_before FROM tasks")) {
            return { count_before: 12 };
          }
          if (sql.includes("COUNT(*) AS count_before FROM slack_workspace_installs")) {
            return { count_before: 1 };
          }
          return { count_before: 0, args };
        },
        all: async () => {
          if (sql.includes("FROM organizations")) {
            return { results: [{ day: "2026-05-14", new_count: 1 }] };
          }
          if (sql.includes("FROM workspaces")) {
            return { results: [{ day: "2026-05-14", new_count: 2 }] };
          }
          if (sql.includes("FROM users")) {
            return { results: [{ day: "2026-05-14", new_count: 4 }] };
          }
          if (sql.includes("FROM tasks")) {
            return { results: [{ day: "2026-05-14", new_count: 8 }] };
          }
          if (sql.includes("FROM slack_workspace_installs")) {
            return { results: [{ day: "2026-05-14", new_count: 2 }] };
          }
          return { results: [] };
        }
      })
    };
  });
  return { prepare };
}

describe("@ask-thane/landing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves health", async () => {
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) }
    };
    const res = await worker.fetch(new Request("https://site.local/health"), env as never);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "ask-thane-landing"
    });
  });

  it("validates email for waitlist", async () => {
    const db = makeDbStub();
    const env = {
      DB: db,
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) }
    };
    const res = await worker.fetch(
      new Request("https://site.local/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" })
      }),
      env as never
    );
    expect(res.status).toBe(400);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("accepts json waitlist submissions and writes to DB", async () => {
    const db = makeDbStub();
    const env = {
      DB: db,
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) }
    };
    const res = await worker.fetch(
      new Request("https://site.local/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "  hello@example.com ",
          name: "  Garrett ",
          company: " Ask Thane ",
          notes: "Interested"
        })
      }),
      env as never
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(db.prepare).toHaveBeenCalledTimes(1);
    const bindArgs = db.bind.mock.calls[0] ?? [];
    expect(bindArgs[1]).toBe("hello@example.com");
    expect(bindArgs[2]).toBe("Garrett");
    expect(bindArgs[3]).toBe("Ask Thane");
    expect(bindArgs[4]).toBe("Interested");
  });

  it("accepts form waitlist submissions", async () => {
    const db = makeDbStub();
    const env = {
      DB: db,
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) }
    };
    const form = new FormData();
    form.set("email", "form@example.com");
    form.set("name", "Danika");
    const res = await worker.fetch(
      new Request("https://site.local/api/waitlist", {
        method: "POST",
        body: form
      }),
      env as never
    );
    expect(res.status).toBe(200);
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it("falls through to static assets for unknown routes", async () => {
    const assetResponse = new Response("asset page", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };

    const req = new Request("https://site.local/");
    const res = await worker.fetch(req, env as never);
    expect(fetchAssets).toHaveBeenCalledWith(req);
    expect(await res.text()).toBe("asset page");
  });

  it("serves public metrics with cumulative series", async () => {
    const env = {
      DB: makeMetricsDbStub(),
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) }
    };
    const res = await worker.fetch(new Request("https://site.local/api/public-metrics?days=30"), env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.organizations).toBe(2);
    expect(body.summary.tasks).toBe(20);
    expect(Array.isArray(body.series.dates)).toBe(true);
    expect(body.series.organizations.cumulative.at(-1)).toBeGreaterThanOrEqual(1);
  });

  it("rewrites /dashboard to static dashboard asset", async () => {
    const assetResponse = new Response("<html>dashboard</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };
    const req = new Request("https://site.local/dashboard");
    const res = await worker.fetch(req, env as never);
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    const calledRequest = fetchAssets.mock.calls[0]?.[0] as Request;
    expect(new URL(calledRequest.url).pathname).toBe("/dashboard.html");
    expect(await res.text()).toContain("dashboard");
  });

  it("serves privacy policy page through static assets", async () => {
    const assetResponse = new Response("<html>privacy</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };

    const req = new Request("https://site.local/privacy.html");
    const res = await worker.fetch(req, env as never);
    expect(fetchAssets).toHaveBeenCalledWith(req);
    expect(await res.text()).toContain("privacy");
  });

  it("serves terms page through static assets", async () => {
    const assetResponse = new Response("<html>terms</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };

    const req = new Request("https://site.local/terms.html");
    const res = await worker.fetch(req, env as never);
    expect(fetchAssets).toHaveBeenCalledWith(req);
    expect(await res.text()).toContain("terms");
  });
});
