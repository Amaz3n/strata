import "server-only"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { extractPayableInvoiceFromFile } from "@/lib/services/document-extraction"
import { downloadFilesObject } from "@/lib/storage/files-storage"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { payableFileDuplicateWarning } from "@/lib/services/payable-file-duplicates"
import { recordAudit } from "@/lib/services/audit"
import { payableIntakeError, type IntakeRow } from "@/lib/payables/intake"

export function intakeRow(bill: any): IntakeRow {
  const intake = bill.metadata.intake
  const expired = ["reading", "checking"].includes(intake.stage) && intake.lease_until && Date.parse(intake.lease_until) < Date.now()
  return { id: bill.id, billId: bill.id, name: intake.name, stage: expired ? "failed" : intake.stage,
    warning: intake.duplicate_reason,
    progress: intake.progress, billNumber: bill.bill_number ?? intake.preview?.billNumber,

    error: expired ? "The scan timed out. Retry using the saved PDF." : intake.error, vendor: bill.metadata.vendor_name ?? intake.preview?.vendor, amount: bill.total_cents || intake.preview?.amount || null }
}

/** The outbox and immediate runner share a lease. All writes compare the revision,
 * so a human editing a draft always wins over a late extraction result. */
export async function processPayableIntake(billId: string, orgId: string, originalFile?: File) {
  const db = createServiceSupabaseClient()
  const { data: bill, error } = await db.from("vendor_bills").select("*").eq("org_id", orgId).eq("id", billId).maybeSingle()
  if (error) throw error
  if (!bill) throw new Error("Invoice draft is not available yet")
  const intake = bill?.metadata?.intake
  if (!bill || !intake || bill.metadata.creation_state !== "draft" || ["ready", "failed"].includes(intake.stage)) return
  if (intake.lease_until && Date.parse(intake.lease_until) > Date.now()) throw new Error("Invoice scan is already running")
  let revision = bill.updated_at
  let metadata: Record<string, any> = { ...bill.metadata, intake: { ...intake, stage: "reading", progress: "Loading PDF", lease_until: new Date(Date.now() + 150_000).toISOString() } }
  async function write(patch: Record<string, unknown> = {}, markConflict = true) {
    const { data, error } = await db.from("vendor_bills").update({ ...patch, metadata })
      .eq("org_id", orgId).eq("id", billId).eq("updated_at", revision).eq("status", "pending").eq("metadata->>creation_state", "draft")
      .select("updated_at").maybeSingle()
    if (error) throw error
    if (!data) {
      if (!markConflict) return false
      const { data: current } = await db.from("vendor_bills").select("metadata,updated_at")
        .eq("org_id", orgId).eq("id", billId).maybeSingle()
      if (current?.metadata?.intake && current.metadata.creation_state === "draft") {
        await db.from("vendor_bills").update({ metadata: { ...current.metadata, intake: {
          ...current.metadata.intake, stage: "failed", lease_until: null,
          error: "This draft changed while scanning. Your edits were kept; review the invoice manually.",
        } } }).eq("org_id", orgId).eq("id", billId).eq("updated_at", current.updated_at)
      }
      return false
    }
    revision = data.updated_at
    return true
  }
  if (!(await write({}, false))) return
  try {
    await attachFileWithServiceRole({ orgId, fileId: bill.file_id, projectId: bill.project_id, entityType: "vendor_bill", entityId: billId, linkRole: "invoice", createdBy: intake.actor_id })
    let file = originalFile
    if (!file) {
      const { data: stored, error: fileError } = await db.from("files").select("storage_path,file_name,mime_type")
        .eq("org_id", orgId).eq("id", bill.file_id).single()
      if (fileError || !stored) throw new Error("The saved invoice could not be loaded")
      const bytes = await downloadFilesObject({ supabase: db, orgId, path: stored.storage_path })
      file = new File([new Uint8Array(bytes)], stored.file_name, { type: stored.mime_type })
    }
    metadata = { ...metadata, intake: { ...metadata.intake, progress: "Reading PDF" } }
    if (!(await write())) return
    let superseded = false
    let scanTimer: ReturnType<typeof setTimeout> | undefined
    const scan = await Promise.race([extractPayableInvoiceFromFile(file, { orgId, projectId: bill.project_id, entityId: billId,
      onPartial: async (value) => {
        if (superseded || !value || typeof value !== "object") return
        const partial = value as Record<string, unknown>
        const preview = { billNumber: typeof partial.bill_number === "string" ? partial.bill_number : null, vendor: typeof partial.vendor_name === "string" ? partial.vendor_name : null,
          amount: typeof partial.total === "number" && Number.isFinite(partial.total) ? Math.round(partial.total * 100) : null }
        if (JSON.stringify(metadata.intake.preview) === JSON.stringify(preview)) return
        const progress = typeof partial.total === "number" ? "Reading line items" : typeof partial.vendor_name === "string" ? "Reading invoice amount" : "Identifying vendor"
        metadata = { ...metadata, intake: { ...metadata.intake, preview, progress } }
        superseded = !(await write())
      },
    }), new Promise<never>((_, reject) => { scanTimer = setTimeout(() => { superseded = true; reject(new Error("The scan timed out. Retry using the saved PDF.")) }, 110_000) })]).finally(() => clearTimeout(scanTimer))
    if (superseded) return
    metadata = { ...metadata, intake: { ...metadata.intake, stage: "checking" } }
    if (!(await write())) return
    if (!scan.billable) throw new Error(scan.notes[0] || "This document does not appear to be an invoice. Review it manually.")
    const fileDuplicate = await payableFileDuplicateWarning(db, orgId, metadata.intake.checksum, billId)
    metadata = {
      ...metadata,
      vendor_name: scan.vendorName,
      description: scan.description,
      extraction_confidence: scan.confidence,
      extraction_provenance: scan.provenance,
      extraction_lines: scan.lines,
      needs_review_reason: scan.duplicateSuspected ? "possible_duplicate" : "invoice_scan",
      intake: { ...metadata.intake, stage: "ready", lease_until: null, error: null,
        notes: scan.notes, duplicate_reason: scan.duplicateReason || fileDuplicate, completed_at: new Date().toISOString() },
    }
    const applied = await write({ company_id: scan.vendorId, bill_number: scan.billNumber,
      total_cents: scan.totalDollars == null ? 0 : Math.round(scan.totalDollars * 100),
      bill_date: scan.billDate, due_date: scan.dueDate })
    if (applied) await recordAudit({ orgId, actorId: intake.actor_id, action: "update", entityType: "vendor_bill", entityId: billId,
      after: { source: "invoice_intake", creation_state: "draft", extraction_model: scan.model } })
  } catch (error) {
    metadata = { ...metadata, intake: { ...metadata.intake, stage: "failed", lease_until: null,
      error: payableIntakeError(error) } }
    // A concurrent human save must never be replaced, including on failure.
    await write()
  }
}
