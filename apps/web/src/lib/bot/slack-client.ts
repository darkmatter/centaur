import * as crypto from "node:crypto";

const SLACK_TIMESTAMP_MAX_AGE_S = 60 * 5; // 5 minutes

/**
 * Verify a Slack request signature (v0 scheme).
 *
 * Mirrors the Python implementation in src/api/app.py `_verify_slack_signature`.
 * See https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string,
): { valid: boolean; reason: string } {
  if (!signingSecret) return { valid: false, reason: "signing_secret_missing" };
  if (!timestamp) return { valid: false, reason: "timestamp_missing" };
  if (!signature) return { valid: false, reason: "signature_missing" };

  const timestampInt = Number(timestamp);
  if (!Number.isFinite(timestampInt)) return { valid: false, reason: "timestamp_invalid" };
  if (Math.abs(Date.now() / 1000 - timestampInt) > SLACK_TIMESTAMP_MAX_AGE_S) {
    return { valid: false, reason: "timestamp_stale" };
  }

  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex");
  const expected = `v0=${hmac}`;

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return { valid: false, reason: "signature_mismatch" };
    }
  } catch {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true, reason: "ok" };
}
