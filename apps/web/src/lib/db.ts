import { Pool } from "pg";

// Requires DATABASE_URL env var (e.g. postgresql://tempo:tempo_dev@postgres:5432/ai_v2)
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
  }
  return pool;
}
