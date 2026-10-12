import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Signed server-to-server inbound deliveries (website leads, lender/title
 * milestones). The sender signs `${timestamp}.${rawBody}` with the per-org
 * secret and sends `x-arc-timestamp` (unix seconds) and `x-arc-signature`
 * (hex HMAC-SHA256). Secrets live encrypted with `encryptIntegrationSecret`;
 * a rotated secret stays valid for its grace window, so callers pass every
 * secret that is currently accepted.
 */

export const INBOUND_TIMESTAMP_HEADER = "x-arc-timestamp"
export const INBOUND_SIGNATURE_HEADER = "x-arc-signature"

const DEFAULT_TOLERANCE_SECONDS = 5 * 60

export function signInboundPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
}

export function verifyInboundSignature(input: {
  secrets: string[]
  timestamp: string | null
  signature: string | null
  rawBody: string
  now: Date
  toleranceSeconds?: number
}): { ok: true } | { ok: false; reason: "missing_signature" | "stale_timestamp" | "bad_signature" } {
  const { secrets, timestamp, signature, rawBody, now } = input
  if (!timestamp || !signature) return { ok: false, reason: "missing_signature" }

  const seconds = Number(timestamp)
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (!/^\d+$/.test(timestamp) || !Number.isFinite(seconds) || Math.abs(now.getTime() / 1000 - seconds) > tolerance) {
    return { ok: false, reason: "stale_timestamp" }
  }

  const provided = signature.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(provided)) return { ok: false, reason: "bad_signature" }
  const providedBuffer = Buffer.from(provided, "hex")

  const matches = secrets.some((secret) => {
    const expected = Buffer.from(signInboundPayload(secret, timestamp, rawBody), "hex")
    return expected.length === providedBuffer.length && timingSafeEqual(expected, providedBuffer)
  })
  return matches ? { ok: true } : { ok: false, reason: "bad_signature" }
}
