interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "ask-thane-landing" }, { status: 200 });
    }

    return env.ASSETS.fetch(request);
  }
};
