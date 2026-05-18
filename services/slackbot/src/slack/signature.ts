import { createHmac, timingSafeEqual } from 'node:crypto'

export type SlackSignatureVerification =
  | { ok: true }
  | { ok: false; status: 400 | 401; reason: string }

export function verifySlackSignature(opts: {
  rawBody: string
  signingSecret?: string
  signature: string | null
  timestamp: string | null
  nowSeconds?: number
  maxAgeSeconds?: number
}): SlackSignatureVerification {
  if (!opts.signingSecret) {
    return { ok: false, status: 401, reason: 'missing_signing_secret' }
  }
  if (!opts.signature || !opts.timestamp) {
    return { ok: false, status: 401, reason: 'missing_signature_headers' }
  }

  const ts = Number(opts.timestamp)
  if (!Number.isFinite(ts)) {
    return { ok: false, status: 400, reason: 'invalid_signature_timestamp' }
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const maxAge = opts.maxAgeSeconds ?? 60 * 5
  if (Math.abs(now - ts) > maxAge) {
    return { ok: false, status: 401, reason: 'stale_signature_timestamp' }
  }

  const base = `v0:${opts.timestamp}:${opts.rawBody}`
  const expected = `v0=${createHmac('sha256', opts.signingSecret).update(base).digest('hex')}`

  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(opts.signature)
  if (expectedBytes.length !== actualBytes.length) {
    return { ok: false, status: 401, reason: 'invalid_signature' }
  }
  if (!timingSafeEqual(expectedBytes, actualBytes)) {
    return { ok: false, status: 401, reason: 'invalid_signature' }
  }

  return { ok: true }
}
