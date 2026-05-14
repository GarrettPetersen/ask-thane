interface Env {
  STRIPE_WEBHOOK_SECRET?: string;
  BUILD_ENV?: string;
  BUILD_GIT_SHA?: string;
  BUILD_DEPLOYED_AT?: string;
}

function verifyStripeSignature(_request: Request, _secret?: string): boolean {
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "ask-thane-payments" });
    }

    if (url.pathname === "/build-info") {
      return Response.json({
        ok: true,
        service: "ask-thane-payments",
        environment: env.BUILD_ENV ?? "unknown",
        gitSha: env.BUILD_GIT_SHA ?? "unknown",
        deployedAt: env.BUILD_DEPLOYED_AT ?? "unknown"
      });
    }

    if (url.pathname === "/webhooks/stripe" && request.method === "POST") {
      const isValid = verifyStripeSignature(request, env.STRIPE_WEBHOOK_SECRET);
      if (!isValid) {
        return Response.json({ error: "invalid_signature" }, { status: 400 });
      }

      return Response.json({ ok: true, received: true }, { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  }
};
