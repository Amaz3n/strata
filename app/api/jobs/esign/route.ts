import { NextRequest, NextResponse } from "next/server"
import { createHmac, randomBytes } from "crypto"

import { SignatureEmail } from "@/lib/emails/signature-email"
import { buildUnifiedSigningUrl } from "@/lib/esign/unified-contracts"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { recordESignEvent } from "@/lib/services/esign-events"
import { getOrgSenderEmail, renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

function requireDocumentSigningSecret() {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) throw new Error("Missing DOCUMENT_SIGNING_SECRET environment variable")
  return secret
}

function getReminderSettings(metadata: any) {
  const settings = metadata?.reminder_settings && typeof metadata.reminder_settings === "object"
    ? metadata.reminder_settings
    : {}
  return {
    enabled: settings.enabled === true,
    intervalDays: Math.max(1, Math.min(30, Number(settings.interval_days ?? 3) || 3)),
  }
}

async function issueSigningLink(supabase: any, orgId: string, requestId: string) {
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHmac("sha256", requireDocumentSigningSecret()).update(token).digest("hex")
  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from("document_signing_requests")
    .update({ token_hash: tokenHash, sent_at: nowIso, status: "sent" })
    .eq("org_id", orgId)
    .eq("id", requestId)

  if (error) throw new Error(`Failed to issue reminder link: ${error.message}`)
  return buildUnifiedSigningUrl(token)
}

async function sendAutomaticReminders(supabase: any) {
  const now = new Date()
  const { data: envelopes, error } = await supabase
    .from("envelopes")
    .select("id, org_id, document_id, status, metadata, documents!inner(title)")
    .in("status", ["sent", "partially_signed"])
    .limit(250)

  if (error) throw new Error(error.message)
  const reminderEnvelopes = (envelopes ?? []).filter((envelope: any) => getReminderSettings(envelope.metadata).enabled)
  if (reminderEnvelopes.length === 0) return { attempted: 0, sent: 0, failed: 0 }

  let attempted = 0
  let sent = 0
  let failed = 0
  for (const envelope of reminderEnvelopes) {
    const settings = getReminderSettings(envelope.metadata)
    const cutoff = new Date(now.getTime() - settings.intervalDays * 24 * 60 * 60 * 1000).toISOString()
    const { data: requests, error: requestsError } = await supabase
      .from("document_signing_requests")
      .select("id, org_id, envelope_id, sequence, required, status, sent_to_email, sent_at, viewed_at, envelope_recipients(name)")
      .eq("org_id", envelope.org_id)
      .eq("envelope_id", envelope.id)
      .in("status", ["sent", "viewed"])
      .order("sequence", { ascending: true })
      .order("created_at", { ascending: true })

    if (requestsError) {
      failed += 1
      continue
    }

    const pending = (requests ?? []).filter((request: any) => request.required !== false)
    const nextSequence = pending[0]?.sequence ?? null
    const currentRequests = nextSequence == null ? [] : pending.filter((request: any) => (request.sequence ?? 1) === nextSequence)
    for (const request of currentRequests) {
      const lastActiveAt = request.viewed_at ?? request.sent_at
      if (!request.sent_to_email || !lastActiveAt || lastActiveAt > cutoff) continue

      const { data: lastDelivery } = await supabase
        .from("esign_reminder_deliveries")
        .select("sent_at")
        .eq("org_id", envelope.org_id)
        .eq("signing_request_id", request.id)
        .eq("delivery_type", "automatic")
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (lastDelivery?.sent_at && lastDelivery.sent_at > cutoff) continue

      attempted += 1
      try {
        const signingLink = await issueSigningLink(supabase, envelope.org_id, request.id)
        const { data: org } = await supabase.from("orgs").select("name, logo_url, slug").eq("id", envelope.org_id).maybeSingle()
        const documentTitle = Array.isArray(envelope.documents)
          ? envelope.documents[0]?.title ?? "Document"
          : envelope.documents?.title ?? "Document"
        const recipientName = Array.isArray(request.envelope_recipients)
          ? request.envelope_recipients[0]?.name
          : request.envelope_recipients?.name
        const html = await renderEmailTemplate(
          SignatureEmail({
            documentTitle,
            signingLink,
            recipientName: recipientName ?? undefined,
            orgName: org?.name ?? null,
            orgLogoUrl: org?.logo_url ?? null,
            eventLabel: "Signature Reminder",
            headline: "Signature still needed",
            bodyText: "This is a reminder that your signature is still needed.",
            detailLabel: "Signature",
            detailText: "Open the document to review all pages, complete required fields, and sign electronically.",
            buttonText: "Review and Sign",
          }),
        )
        await sendEmail({
          to: [request.sent_to_email],
          subject: `Reminder: Signature requested - ${documentTitle}`,
          html,
          from: getOrgSenderEmail(org?.slug, org?.name),
        })
        await supabase.from("esign_reminder_deliveries").insert({
          org_id: envelope.org_id,
          envelope_id: envelope.id,
          signing_request_id: request.id,
          recipient_email: request.sent_to_email,
          delivery_type: "automatic",
          status: "sent",
        })
        sent += 1
      } catch (sendError: any) {
        failed += 1
        await supabase.from("esign_reminder_deliveries").insert({
          org_id: envelope.org_id,
          envelope_id: envelope.id,
          signing_request_id: request.id,
          recipient_email: request.sent_to_email,
          delivery_type: "automatic",
          status: "failed",
          error_message: sendError?.message ?? "Reminder failed",
        })
      }
    }
  }

  return { attempted, sent, failed }
}

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data: expiredEnvelopes, error: loadError } = await supabase
    .from("envelopes")
    .select("id, org_id, document_id, status")
    .in("status", ["sent", "partially_signed"])
    .not("expires_at", "is", null)
    .lte("expires_at", nowIso)
    .limit(250)

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 })
  }

  const envelopes = expiredEnvelopes ?? []
  const envelopeIds = envelopes.map((envelope) => envelope.id)
  if (envelopeIds.length > 0) {
    const { error: envelopeUpdateError } = await supabase
      .from("envelopes")
      .update({ status: "expired", updated_at: nowIso })
      .in("id", envelopeIds)
      .in("status", ["sent", "partially_signed"])

    if (envelopeUpdateError) {
      return NextResponse.json({ error: envelopeUpdateError.message }, { status: 500 })
    }

    const { error: requestUpdateError } = await supabase
      .from("document_signing_requests")
      .update({ status: "expired" })
      .in("envelope_id", envelopeIds)
      .in("status", ["draft", "sent", "viewed"])

    if (requestUpdateError) {
      return NextResponse.json({ error: requestUpdateError.message }, { status: 500 })
    }

    const documentIds = Array.from(new Set(envelopes.map((envelope) => envelope.document_id).filter(Boolean)))
    if (documentIds.length > 0) {
      await supabase
        .from("documents")
        .update({ status: "expired", updated_at: nowIso })
        .in("id", documentIds)
        .in("status", ["sent"])
    }

    await Promise.all(
      envelopes.map((envelope) =>
        recordESignEvent({
          supabase,
          orgId: envelope.org_id,
          eventType: "envelope_expired",
          envelopeId: envelope.id,
          documentId: envelope.document_id,
          payload: {
            previous_status: envelope.status,
            expired_at: nowIso,
            source: "api.jobs.esign",
          },
        }),
      ),
    )
  }

  try {
    const reminders = await sendAutomaticReminders(supabase)
    return NextResponse.json({ expired: envelopes.length, reminders })
  } catch (reminderError: any) {
    return NextResponse.json(
      { expired: envelopes.length, reminder_error: reminderError?.message ?? "Reminder job failed" },
      { status: 500 },
    )
  }

}

export const POST = withCronRun("esign", handler)
export const GET = POST
