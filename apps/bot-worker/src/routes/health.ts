export function healthcheck(): Response {
  return Response.json(
    {
      ok: true,
      service: "ask-thane-bot",
      timestamp: new Date().toISOString()
    },
    { status: 200 }
  );
}
