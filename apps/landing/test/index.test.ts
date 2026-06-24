import { existsSync, readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const publicDir = new URL("../public/", import.meta.url);
const utilityHtmlFiles = new Set(["chat-app.html", "chat-session-bridge.html"]);

function websiteHtmlFiles(): string[] {
  return readdirSync(publicDir).filter((file) => file.endsWith(".html") && !utilityHtmlFiles.has(file));
}

function extractMetaContent(html: string, attribute: "name" | "property", value: string): string | null {
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<meta\\s+${attribute}="${escapedValue}"\\s+content="([^"]+)"\\s*/?>`, "i"));
  return match?.[1] ?? null;
}

function extractCanonical(html: string): string | null {
  const match = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"\s*\/?>/i);
  return match?.[1] ?? null;
}

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
      if (sql.includes("COUNT(*) AS count FROM thane_cli_workspaces")) {
        return { count: 5 };
      }
      if (sql.includes("COUNT(*) AS count FROM (SELECT email, MIN(created_at) AS first_seen_at")) {
        return { count: 11 };
      }
      if (sql.includes("COUNT(*) AS count FROM thane_cli_chat_messages")) {
        return { count: 42 };
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
          if (sql.includes("COUNT(*) AS count_before FROM thane_cli_workspaces")) {
            return { count_before: 3 };
          }
          if (sql.includes("COUNT(*) AS count_before FROM (SELECT email, MIN(created_at) AS first_seen_at")) {
            return { count_before: 8 };
          }
          if (sql.includes("COUNT(*) AS count_before FROM thane_cli_chat_messages")) {
            return { count_before: 30 };
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
          if (sql.includes("FROM thane_cli_workspaces")) {
            return { results: [{ day: "2026-05-14", new_count: 2 }] };
          }
          if (sql.includes("SELECT substr(first_seen_at, 1, 10) AS day")) {
            return { results: [{ day: "2026-05-14", new_count: 3 }] };
          }
          if (sql.includes("FROM thane_cli_chat_messages")) {
            return { results: [{ day: "2026-05-14", new_count: 12 }] };
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

  it("defines social sharing metadata for every public html page", () => {
    const htmlFiles = websiteHtmlFiles();

    expect(htmlFiles.length).toBeGreaterThan(0);

    for (const file of htmlFiles) {
      const html = readFileSync(new URL(file, publicDir), "utf8");
      const canonical = extractCanonical(html);
      const ogImage = extractMetaContent(html, "property", "og:image");
      const twitterImage = extractMetaContent(html, "name", "twitter:image");

      expect(canonical, `${file} canonical`).toMatch(/^https:\/\/(?:askthane\.com|chat\.askthane\.com)\//);
      expect(extractMetaContent(html, "property", "og:type"), `${file} og:type`).toBe("website");
      expect(extractMetaContent(html, "property", "og:site_name"), `${file} og:site_name`).toBe("Thane");
      expect(extractMetaContent(html, "property", "og:title"), `${file} og:title`).toBeTruthy();
      expect(extractMetaContent(html, "property", "og:description"), `${file} og:description`).toBeTruthy();
      expect(extractMetaContent(html, "property", "og:url"), `${file} og:url`).toBe(canonical);
      expect(ogImage, `${file} og:image`).toMatch(/^https:\/\/askthane\.com\/social\/[-a-z]+\.png$/);
      expect(extractMetaContent(html, "property", "og:image:secure_url"), `${file} secure image`).toBe(ogImage);
      expect(extractMetaContent(html, "property", "og:image:type"), `${file} image type`).toBe("image/png");
      expect(extractMetaContent(html, "property", "og:image:width"), `${file} image width`).toBe("1200");
      expect(extractMetaContent(html, "property", "og:image:height"), `${file} image height`).toBe("630");
      expect(extractMetaContent(html, "property", "og:image:alt"), `${file} image alt`).toBeTruthy();
      expect(extractMetaContent(html, "name", "twitter:card"), `${file} twitter card`).toBe("summary_large_image");
      expect(extractMetaContent(html, "name", "twitter:title"), `${file} twitter title`).toBeTruthy();
      expect(extractMetaContent(html, "name", "twitter:description"), `${file} twitter description`).toBeTruthy();
      expect(twitterImage, `${file} twitter image`).toBe(ogImage);
      expect(extractMetaContent(html, "name", "twitter:image:alt"), `${file} twitter image alt`).toBeTruthy();

      const imagePath = new URL(new URL(ogImage ?? "").pathname.slice(1), publicDir);
      expect(existsSync(imagePath), `${file} image exists`).toBe(true);
      const png = readFileSync(imagePath);
      expect(png.subarray(1, 4).toString("ascii"), `${file} png signature`).toBe("PNG");
      expect(png.readUInt32BE(16), `${file} png width`).toBe(1200);
      expect(png.readUInt32BE(20), `${file} png height`).toBe(630);
    }
  });

  it("loads the Thane Chat shortcut on every public website page", () => {
    const htmlFiles = websiteHtmlFiles();

    expect(htmlFiles.length).toBeGreaterThan(0);

    for (const file of htmlFiles) {
      const html = readFileSync(new URL(file, publicDir), "utf8");
      expect(html, `${file} chat shortcut`).toContain('<script src="/chat-shortcut.js" defer></script>');
    }

    expect(readFileSync(new URL("chat-app.html", publicDir), "utf8")).not.toContain("/chat-shortcut.js");
    expect(readFileSync(new URL("chat-session-bridge.html", publicDir), "utf8")).not.toContain("/chat-shortcut.js");
    expect(existsSync(new URL("chat-shortcut.js", publicDir))).toBe(true);
    expect(readFileSync(new URL("chat-shortcut.js", publicDir), "utf8")).toContain('<svg class="thane-chat-shortcut-icon"');
    expect(existsSync(new URL("chat-session-bridge.html", publicDir))).toBe(true);
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

  it("serves build metadata", async () => {
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
      BUILD_ENV: "test",
      BUILD_GIT_SHA: "sha_123",
      BUILD_DEPLOYED_AT: "2026-06-20T00:00:00Z"
    };
    const res = await worker.fetch(new Request("https://site.local/build-info"), env as never);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "ask-thane-landing",
      environment: "test",
      gitSha: "sha_123",
      deployedAt: "2026-06-20T00:00:00Z"
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

  it("serves the landing page at the apex root", async () => {
    const assetResponse = new Response("landing page", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };

    const res = await worker.fetch(new Request("https://askthane.com/"), env as never);
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    const calledRequest = fetchAssets.mock.calls[0]?.[0] as Request;
    expect(new URL(calledRequest.url).pathname).toBe("/index.html");
    expect(await res.text()).toBe("landing page");
  });

  it("serves the hosted chat app from the chat custom domain", async () => {
    const assetResponse = new Response("<html>chat app</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };

    const res = await worker.fetch(new Request("https://chat.askthane.com/workspaces"), env as never);
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    const calledRequest = fetchAssets.mock.calls[0]?.[0] as Request;
    expect(new URL(calledRequest.url).pathname).toBe("/chat-app.html");
    expect(await res.text()).toContain("chat app");
  });

  it("serves web invite routes from the chat custom domain", async () => {
    const assetResponse = new Response("<html>chat app invite</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };

    const res = await worker.fetch(new Request("https://chat.askthane.com/invite/token_123"), env as never);
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    const calledRequest = fetchAssets.mock.calls[0]?.[0] as Request;
    expect(new URL(calledRequest.url).pathname).toBe("/chat-app.html");
    expect(await res.text()).toContain("chat app invite");
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
    expect(body.summary.thaneCli).toEqual({
      workspaces: 5,
      accounts: 11,
      messages: 42
    });
    expect(Array.isArray(body.series.dates)).toBe(true);
    expect(body.series.organizations.cumulative.at(-1)).toBeGreaterThanOrEqual(1);
    expect(body.series.thaneCliMessages.cumulative.at(-1)).toBeGreaterThanOrEqual(30);
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

  it("rewrites /install to static install chooser asset", async () => {
    const assetResponse = new Response("<html>install</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };
    const req = new Request("https://site.local/install");
    const res = await worker.fetch(req, env as never);
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    const calledRequest = fetchAssets.mock.calls[0]?.[0] as Request;
    expect(new URL(calledRequest.url).pathname).toBe("/install.html");
    expect(await res.text()).toContain("install");
  });

  it("rewrites /chat to static Thane Chat asset", async () => {
    const assetResponse = new Response("<html>chat</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };
    const req = new Request("https://site.local/chat");
    const res = await worker.fetch(req, env as never);
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    const calledRequest = fetchAssets.mock.calls[0]?.[0] as Request;
    expect(new URL(calledRequest.url).pathname).toBe("/chat.html");
    expect(await res.text()).toContain("chat");
  });

  it("rewrites /chat/install to static Thane Chat install asset", async () => {
    const assetResponse = new Response("<html>chat-install</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };
    const req = new Request("https://site.local/chat/install");
    const res = await worker.fetch(req, env as never);
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    const calledRequest = fetchAssets.mock.calls[0]?.[0] as Request;
    expect(new URL(calledRequest.url).pathname).toBe("/chat-install.html");
    expect(await res.text()).toContain("chat-install");
  });

  it("rewrites /ask-thane to static Ask Thane asset", async () => {
    const assetResponse = new Response("<html>ask-thane</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };
    const req = new Request("https://site.local/ask-thane");
    const res = await worker.fetch(req, env as never);
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    const calledRequest = fetchAssets.mock.calls[0]?.[0] as Request;
    expect(new URL(calledRequest.url).pathname).toBe("/ask-thane.html");
    expect(await res.text()).toContain("ask-thane");
  });

  it("rewrites /ask-thane/install to static Ask Thane install asset", async () => {
    const assetResponse = new Response("<html>ask-thane-install</html>", { status: 200 });
    const fetchAssets = vi.fn(async () => assetResponse);
    const env = {
      DB: makeDbStub(),
      ASSETS: { fetch: fetchAssets }
    };
    const req = new Request("https://site.local/ask-thane/install");
    const res = await worker.fetch(req, env as never);
    expect(fetchAssets).toHaveBeenCalledTimes(1);
    const calledRequest = fetchAssets.mock.calls[0]?.[0] as Request;
    expect(new URL(calledRequest.url).pathname).toBe("/ask-thane-install.html");
    expect(await res.text()).toContain("ask-thane-install");
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
