import { NextResponse } from "next/server"

import { INBOUND_SIGNATURE_HEADER, INBOUND_TIMESTAMP_HEADER } from "@/lib/inbound/signature"
import { enforceAuthRateLimit, RateLimitError } from "@/lib/services/auth-rate-limit"
import { receiveLeadDelivery } from "@/lib/services/lead-intake"
import { LEAD_SUBMISSION_MAX_BYTES } from "@/lib/validation/lead-intake"

/**
 * Website lead deliveries, server to server. The builder's site signs
 * `${x-arc-timestamp}.${body}` with the source's secret (hex HMAC-SHA256 in
 * `x-arc-signature`) and sends an `Idempotency-Key`. Every signed delivery is
 * logged before it is filed, so the answer is a 2xx unless the sender must fix
 * something: 401 signature, 404 unknown or disabled source, 409 a reused key
 * with a different body, 413 too large, 422 a submission Arc cannot file (also
 * shown to the builder's sales operators), 429 slow down.
 *
 * Public (no session): it is in PUBLIC_API_ROUTES in proxy.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > LEAD_SUBMISSION_MAX_BYTES) return NextResponse.json({ error: "Submission too large" }, { status: 413 })

  // The throttle fails open like every auth throttle: the signature is the gate.
  const throttled = await enforceAuthRateLimit("lead_intake", sourceId).then(
    () => false,
    (error: unknown) => error instanceof RateLimitError,
  )
  if (throttled) return NextResponse.json({ error: "Too many deliveries. Slow down and retry." }, { status: 429 })

  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody) > LEAD_SUBMISSION_MAX_BYTES) {
    return NextResponse.json({ error: "Submission too large" }, { status: 413 })
  }

  const result = await receiveLeadDelivery({
    publicId: sourceId,
    rawBody,
    timestamp: request.headers.get(INBOUND_TIMESTAMP_HEADER),
    signature: request.headers.get(INBOUND_SIGNATURE_HEADER),
    idempotencyKey: request.headers.get("idempotency-key"),
  })
  return NextResponse.json(result.body, { status: result.status })
}
