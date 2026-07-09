import { createHmac, timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"

import { findOrgIdByInboundRecipients } from "@/lib/services/payables-email-ingest"
import { enqueueOutboxJob } from "@/lib/services/outbox"

/**
 * Resend inbound-email webhook (`email.received`) for the bills address
 * (`<org-slug>@bills.<domain>`). Verifies the svix signature, resolves the org
 * from the recipient slug, and enqueues a durable outbox job — the actual
 * fetch/extract/create work happens in the process-outbox cron so this
 * endpoint stays fast and retries survive crashes.
 *
 * This route is public (no session cookie) and MUST stay in PUBLIC_API_ROUTES
 * in proxy.ts or Resend gets 307'd to the sign-in page.
 */

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60

function verifySvixSignature(args: {
  secret: string
  id: string | null
  timestamp: string | null
  signature: string | null
  payload: string
}): boolean {
  const { secret, id, timestamp, signature, payload } = args
  if (!id || !timestamp || !signature) return false

  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) return false
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) return false

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  const expected = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${payload}`).digest("base64")
  const expectedBuffer = Buffer.from(expected)

  // Header format: "v1,<base64> v1,<base64> ..."
  return signature.split(" ").some((candidate) => {
    const [version, value] = candidate.split(",")
    if (version !== "v1" || !value) return false
    const candidateBuffer = Buffer.from(value)
    return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer)
  })
}

export async function POST(request: Request) {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET
  if (!secret) {
    console.error("resend-inbound: RESEND_INBOUND_WEBHOOK_SECRET is not configured")
    return NextResponse.json({ error: "Not configured" }, { status: 503 })
  }

  const payload = await request.text()
  const verified = verifySvixSignature({
    secret,
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
    payload,
  })
  if (!verified) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let event: { type?: string; data?: Record<string, unknown> }
  try {
    event = JSON.parse(payload)
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ received: true })
  }

  const data = event.data ?? {}
  const emailId = typeof data.email_id === "string" ? data.email_id : null
  if (!emailId) {
    return NextResponse.json({ error: "Missing email_id" }, { status: 400 })
  }

  const to = Array.isArray(data.to) ? (data.to as string[]) : typeof data.to === "string" ? [data.to] : []
  const receivedFor = Array.isArray(data.received_for) ? (data.received_for as string[]) : []
  const org = await findOrgIdByInboundRecipients([...to, ...receivedFor])
  if (!org) {
    // Unknown slug (typo, spam probe). Acknowledge so Resend doesn't retry.
    console.warn("resend-inbound: no org matched recipients", { to, receivedFor })
    return NextResponse.json({ received: true, routed: false })
  }

  await enqueueOutboxJob({
    orgId: org.orgId,
    jobType: "process_inbound_bill_email",
    payload: {
      email_id: emailId,
      from: typeof data.from === "string" ? data.from : null,
      subject: typeof data.subject === "string" ? data.subject : null,
    },
    dedupeByPayloadKeys: ["email_id"],
  })

  return NextResponse.json({ received: true, routed: true })
}
