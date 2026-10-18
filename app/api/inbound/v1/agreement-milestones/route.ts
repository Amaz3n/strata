import { NextResponse, type NextRequest } from "next/server"

import { INBOUND_SIGNATURE_HEADER, INBOUND_TIMESTAMP_HEADER } from "@/lib/inbound/signature"
import { MILESTONE_REPORT_MAX_BYTES, receiveMilestoneReport } from "@/lib/services/agreement-milestones"
import { enforceAuthRateLimit, RateLimitError } from "@/lib/services/auth-rate-limit"

/**
 * Lender and title companies post milestone updates here, server to server.
 * Headers: x-arc-source (the feed's public id), x-arc-timestamp and
 * x-arc-signature (HMAC of `${timestamp}.${body}` with the feed's secret), and
 * optionally x-arc-delivery. The sender's unique id for the update is
 * `delivery_id` in the signed body (the header, when sent, must match it), so a
 * captured report cannot be replayed as a new delivery. Reconciliation and the
 * delivery log live in `receiveMilestoneReport`.
 *
 * Public: listed in PUBLIC_API_ROUTES in proxy.ts; the signature is the gate.
 */
export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MILESTONE_REPORT_MAX_BYTES) return NextResponse.json({ error: "payload_too_large" }, { status: 413 })
  // The throttle fails open like every auth throttle: the signature is the gate.
  const throttled = await enforceAuthRateLimit("agreement_milestone_report", request.headers.get("x-arc-source") ?? "unknown").then(
    () => false,
    (error: unknown) => error instanceof RateLimitError,
  )
  if (throttled) return NextResponse.json({ error: "too_many_requests" }, { status: 429 })
  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody, "utf8") > MILESTONE_REPORT_MAX_BYTES) return NextResponse.json({ error: "payload_too_large" }, { status: 413 })
  try {
    const receipt = await receiveMilestoneReport({
      sourcePublicId: request.headers.get("x-arc-source"),
      deliveryId: request.headers.get("x-arc-delivery"),
      timestamp: request.headers.get(INBOUND_TIMESTAMP_HEADER),
      signature: request.headers.get(INBOUND_SIGNATURE_HEADER),
      rawBody,
    })
    return NextResponse.json(receipt.body, { status: receipt.status })
  } catch (error) {
    if (error instanceof Error && error.message.includes("TOKEN_ENCRYPTION_KEY")) {
      return NextResponse.json({ error: "unavailable" }, { status: 503 })
    }
    throw error
  }
}
