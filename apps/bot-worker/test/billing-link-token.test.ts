import { describe, expect, it } from "vitest";
import { createSignedBillingSubscribeUrl } from "../src/services/billing-link-token";

function base64UrlToText(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return new TextDecoder().decode(
    Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
  );
}

describe("billing link token", () => {
  it("mints signed billing tokens for subscribe links", async () => {
    const url = await createSignedBillingSubscribeUrl({
      env: {
        BILLING_LINK_SIGNING_SECRET: "secret_123",
        SUBSCRIPTION_PAGE_URL: "https://payments.askthane.com/subscribe"
      },
      organizationId: "org_1",
      workspaceId: "ws_1",
      selectedTier: "growth"
    });

    const parsed = new URL(url);
    const token = parsed.searchParams.get("billing_token");
    expect(token).toBeTruthy();
    expect(parsed.searchParams.get("autostart")).toBe("1");

    const payloadPart = token!.split(".")[0];
    const payload = JSON.parse(base64UrlToText(payloadPart)) as Record<string, unknown>;
    expect(payload.organizationId).toBe("org_1");
    expect(payload.workspaceId).toBe("ws_1");
    expect(payload.planTier).toBe("growth");
    expect(typeof payload.exp).toBe("number");
  });
});
