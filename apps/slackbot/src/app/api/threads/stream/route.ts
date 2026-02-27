/** Proxy /api/threads/stream?key=... → FastAPI /api/threads/stream?key=... as SSE */

const API_URL = process.env.AI_V2_API_URL || "http://localhost:8000";
const API_KEY = process.env.AI_V2_API_KEY || "";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key") || "";

  const upstream = await fetch(
    `${API_URL}/api/threads/stream?key=${encodeURIComponent(key)}`,
    {
      headers: { Authorization: `Bearer ${API_KEY}` },
      cache: "no-store",
    }
  );

  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { error: `Stream not available: ${key}` },
      { status: upstream.status }
    );
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
