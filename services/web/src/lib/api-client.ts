import { CentaurClient } from "@centaur/api-client";

const API_URL = process.env.CENTAUR_API_URL || "http://api:8000";
const API_KEY = process.env.WEB_API_KEY || process.env.API_SECRET_KEY || "";

export const centaur = new CentaurClient({ apiUrl: API_URL, apiKey: API_KEY });
export const api = centaur.http;
export { API_URL, API_KEY };
