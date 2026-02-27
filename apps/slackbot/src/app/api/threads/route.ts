/** Proxy /api/threads → FastAPI /api/threads */

const API_URL = process.env.AI_V2_API_URL || "http://localhost:8000";
const API_KEY = process.env.AI_V2_API_KEY || "";

export async function GET() {
  const res = await fetch(`${API_URL}/api/threads`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    cache: "no-store",
  });
  const data = await res.json();
  return Response.json(data);
}
