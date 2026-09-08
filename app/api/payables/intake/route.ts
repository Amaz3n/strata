import { after, NextResponse } from "next/server"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { createFileFromUpload } from "@/lib/services/files"
import { enqueueOutboxJob, completeOutboxJob } from "@/lib/services/outbox"
import { processPayableIntake, intakeRow } from "@/lib/services/payable-intake"
import { invoiceFileError, payableIntakeError } from "@/lib/payables/intake"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { payableFileDuplicateWarning } from "@/lib/services/payable-file-duplicates"
import { recordAudit } from "@/lib/services/audit"

export const maxDuration = 180

async function contextFor(projectId: string | null) {
  const ctx = await requireOrgContext()
  await requireAuthorization({ ...ctx, permission: "bill.write", projectId: projectId ?? undefined,
    resourceType: projectId ? "project" : "vendor_bill", resourceId: projectId ?? "new" })
  if (projectId) {
    const { data, error } = await ctx.supabase.from("projects").select("id").eq("org_id", ctx.orgId).eq("id", projectId).maybeSingle()
    if (error || !data) throw new Error("Project not found")
  }
  return ctx
}

export async function GET(request: Request) {
  try {
    const projectId = z.string().uuid().nullable().parse(new URL(request.url).searchParams.get("projectId"))
    const { supabase, orgId, userId } = await contextFor(projectId)
    let query = supabase.from("vendor_bills").select("id,total_cents,bill_number,metadata")
      .eq("org_id", orgId).eq("metadata->intake->>actor_id", userId)
      .eq("metadata->>creation_state", "draft").order("created_at", { ascending: false }).limit(100)
    query = projectId ? query.eq("project_id", projectId) : query.is("project_id", null)
    const { data, error } = await query
    if (error) throw error
    return NextResponse.json({ rows: (data ?? []).map(intakeRow) }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Could not load invoice intake" }, { status: 403 })
  }
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin")
    if (origin && origin !== new URL(request.url).origin) return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
    if (Number(request.headers.get("content-length")) > 22 * 1024 * 1024) return NextResponse.json({ error: "Invoice is too large" }, { status: 413 })
    const form = await request.formData()
    const projectId = z.string().uuid().nullable().parse(form.get("projectId"))
    const id = z.string().uuid().parse(form.get("id"))
    const { supabase, orgId, userId } = await contextFor(projectId)
    // A retried network request reuses its bill ID, never creates a second bill.
    const { data: found, error: existingError } = await supabase.from("vendor_bills").select("id,total_cents,bill_number,metadata,project_id,updated_at")
      .eq("org_id", orgId).eq("id", id).maybeSingle()
    if (existingError) throw existingError
    let existing = found
    if (existing) {
      if (existing.project_id !== projectId || existing.metadata?.intake?.actor_id !== userId) throw new Error("Invoice unavailable")
      if (existing.metadata.creation_state !== "draft") throw new Error("This bill is no longer a draft")
      const expired = existing.metadata.intake.lease_until && Date.parse(existing.metadata.intake.lease_until) < Date.now()
      if (existing.metadata.intake.stage === "failed" || expired) {
        const { data: reset, error: resetError } = await supabase.from("vendor_bills")
          .update({ metadata: { ...existing.metadata, intake: { ...existing.metadata.intake, stage: "queued", progress: "Queued for scanning", error: null, lease_until: null } } })
          .eq("org_id", orgId).eq("id", id).eq("updated_at", existing.updated_at).select("id,total_cents,bill_number,metadata,project_id,updated_at").maybeSingle()
        if (resetError || !reset) throw new Error("The draft changed. Refresh and try again.")
        existing = reset
      }
      if (existing.metadata.intake.stage === "queued") {
        const recovery = await enqueueOutboxJob({ orgId, jobType: "process_payable_intake", payload: { bill_id: id, revision: existing.updated_at }, dedupeByPayloadKeys: ["bill_id", "revision"] })
        if (!recovery.enqueued && recovery.reason !== "duplicate") throw new Error("Could not queue saved draft")
        after(async () => {
          try { await processPayableIntake(id, orgId); if (recovery.enqueued) await completeOutboxJob(recovery.id) }
          catch (error) { console.error("Saved invoice deferred to outbox", error) }
        })
      }
      return NextResponse.json({ row: intakeRow(existing) })
    }
    const invoice = form.get("invoice")
    if (!(invoice instanceof File)) throw new Error("Choose an invoice")
    const validationError = invoiceFileError(invoice)
    if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
    const uploaded = await createFileFromUpload({ allowDuplicateContent: true, file: invoice, projectId, category: "financials", visibility: "private" })
    // Queue first: any draft that becomes visible already has durable recovery.
    const job = await enqueueOutboxJob({ orgId, jobType: "process_payable_intake", payload: { bill_id: id },
      dedupeByPayloadKeys: ["bill_id"], runAt: new Date(Date.now() + 180_000).toISOString() })
    if (!job.enqueued && job.reason !== "duplicate") throw new Error("Background scanning is unavailable")
    const duplicateWarning = await payableFileDuplicateWarning(supabase, orgId, uploaded.checksum, id)
    const metadata = { creation_state: "draft", source: "invoice_intake", internal_upload: true,
      intake: { actor_id: userId, name: invoice.name, stage: "queued", duplicate_reason: duplicateWarning, checksum: uploaded.checksum } }
    const { data: bill, error } = await supabase.from("vendor_bills").insert({ id, org_id: orgId, project_id: projectId,
      total_cents: 0, currency: "usd", status: "pending", file_id: uploaded.id, metadata })
      .select("id,total_cents,bill_number,metadata").single()
    if (error || !bill) throw error ?? new Error("Could not save draft")
    await attachFileWithServiceRole({ orgId, fileId: uploaded.id, projectId, entityType: "vendor_bill", entityId: id, linkRole: "invoice", createdBy: userId })
    after(async () => {
      try {
        await processPayableIntake(id, orgId, invoice)
        if (job.enqueued) await completeOutboxJob(job.id)
      } catch (error) { console.error("Immediate invoice scan deferred to outbox", error) }
    })
    await recordAudit({ orgId, actorId: userId, action: "insert", entityType: "vendor_bill", entityId: id, after: bill })
    return NextResponse.json({ row: intakeRow(bill) })
  } catch (error) {
    console.error("Invoice intake failed", error)
    return NextResponse.json({ error: payableIntakeError(error) }, { status: 400 })
  }
}
