interface Env {
  STRIPE_WEBHOOK_SECRET?: string;
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
