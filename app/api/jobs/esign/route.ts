import { NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { recordESignEvent } from "@/lib/services/esign-events"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

function getReminderSettings(metadata: any) {
  const settings = metadata?.reminder_settings && typeof metadata.reminder_settings === "object"
    ? metadata.reminder_settings
    : {}
  return {
    enabled: settings.enabled === true,
    intervalDays: Math.max(1, Math.min(30, Number(settings.interval_days ?? 3) || 3)),
  }
}

async function sendAutomaticReminders(supabase: any) {
  const now = new Date()
  const reminderEnvelopes: any[] = []
  let cursor: string | null = null
  while (true) {
    let query = supabase.from("envelopes")
      .select("id, org_id, document_id, status, metadata")
      .in("status", ["sent", "partially_signed"])
      .eq("metadata->reminder_settings->>enabled", "true")
      .order("id", { ascending: true }).limit(250)
    if (cursor) query = query.gt("id", cursor)
    const { data: page, error } = await query
    if (error) throw new Error(error.message)
    reminderEnvelopes.push(...(page ?? []))
    if (!page || page.length < 250) break
    cursor = page[page.length - 1].id
  }

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

      const { data: lastDelivery, error: deliveryError } = await supabase
        .from("esign_reminder_deliveries")
        .select("sent_at")
        .eq("org_id", envelope.org_id)
        .eq("signing_request_id", request.id)
        .eq("delivery_type", "automatic")
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (deliveryError) { failed += 1; continue }
      if (lastDelivery?.sent_at && lastDelivery.sent_at > cutoff) continue

      attempted += 1
      try {
        const deliveryKey = `${request.id}:${lastDelivery?.sent_at ?? request.sent_at}`
        const queued = await enqueueOutboxJob({
          orgId: envelope.org_id,
          jobType: "send_esign_reminder",
          payload: { signing_request_id: request.id, envelope_id: envelope.id, delivery_key: deliveryKey },
          dedupeByPayloadKeys: ["delivery_key"],
        })
        if (!queued.enqueued && queued.reason !== "duplicate") throw new Error("Could not queue signing reminder")
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

  return { attempted, queued: sent, failed }
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
    return NextResponse.json(
      { ok: reminders.failed === 0, expired: envelopes.length, reminders },
      { status: reminders.failed === 0 ? 200 : 207 },
    )
  } catch (reminderError: any) {
    return NextResponse.json(
      { expired: envelopes.length, reminder_error: reminderError?.message ?? "Reminder job failed" },
      { status: 500 },
    )
  }

}

export const POST = withCronRun("esign", handler)
export const GET = POST
