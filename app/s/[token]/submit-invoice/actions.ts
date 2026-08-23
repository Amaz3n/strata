"use server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createVendorBillFromPortal } from "@/lib/services/vendor-bills"
import { extractPayableInvoiceFromFile } from "@/lib/services/document-extraction"
import { vendorBillCreateSchema, type VendorBillCreate } from "@/lib/validation/vendor-bills"
import { deleteFilesObjects, uploadFilesObject } from "@/lib/storage/files-storage"

export interface SubmitInvoiceResult {
  success: boolean
  error?: string
  billId?: string
  overBudget?: boolean
}

export interface UploadInvoiceFileResult {
  success: boolean
  error?: string
  fileId?: string
  fileName?: string
}

export async function submitInvoiceAction({
  token,
  input,
}: {
  token: string
  input: VendorBillCreate
}): Promise<SubmitInvoiceResult> {
  try {
    const portalToken = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireProject: true,
      requireCompany: true,
      permission: "can_submit_invoices",
    })
    if (!portalToken.company_id) return { success: false, error: "Invalid portal type" }

    // Validate input
    const parsed = vendorBillCreateSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]
      return { success: false, error: firstError?.message ?? "Invalid input" }
    }

    // Create the vendor bill
    const bill = await createVendorBillFromPortal({
      input: parsed.data,
      orgId: portalToken.org_id,
      projectId: portalToken.project_id,
      companyId: portalToken.company_id,
      portalTokenId: portalToken.id,
    })

    return {
      success: true,
      billId: bill.id,
      // The service already worked this out against the remaining contract
      // balance and approved change orders. Recomputing it here as "this one
      // invoice versus the whole contract" called the second draw on a
      // three-draw contract over budget, and stayed silent on the one that
      // actually exceeded it.
      overBudget: bill.over_budget === true,
    }
  } catch (err) {
    console.error("Failed to submit invoice:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to submit invoice",
    }
  }
}

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB
const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/heic",
]

export async function uploadInvoiceFileAction({
  token,
  formData,
}: {
  token: string
  formData: FormData
}): Promise<UploadInvoiceFileResult> {
  try {
    const portalToken = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireProject: true,
      requireCompany: true,
      permission: "can_submit_invoices",
    })
    if (!portalToken.company_id) return { success: false, error: "Invalid portal type" }

    const file = formData.get("file") as File
    if (!file) {
      return { success: false, error: "No file provided" }
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return { success: false, error: "File size exceeds 25MB limit" }
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      return { success: false, error: "Invalid file type. Please upload a PDF or image." }
    }

    const supabase = createServiceSupabaseClient()

    // Generate unique storage path
    const timestamp = Date.now()
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
    const storagePath = `${portalToken.org_id}/${portalToken.project_id}/vendor-invoices/${portalToken.company_id}/${timestamp}_${safeName}`

    const fileBytes = new Uint8Array(await file.arrayBuffer())
    try {
      await uploadFilesObject({
        supabase,
        orgId: portalToken.org_id,
        path: storagePath,
        bytes: fileBytes,
        contentType: file.type,
        upsert: false,
      })
    } catch (uploadError) {
      console.error("Storage upload error:", uploadError)
      return { success: false, error: "Failed to upload file" }
    }

    // Create file record in database
    const { data: fileRecord, error: dbError } = await supabase
      .from("files")
      .insert({
        org_id: portalToken.org_id,
        project_id: portalToken.project_id,
        file_name: file.name,
        storage_path: storagePath,
        mime_type: file.type,
        size_bytes: file.size,
        visibility: "private",
        category: "financials",
        folder_path: "/financials",
        metadata: {
          uploaded_via_portal: true,
          portal_token_id: portalToken.id,
          company_id: portalToken.company_id,
          file_type: "vendor_invoice",
        },
      })
      .select("id, file_name")
      .single()

    if (dbError || !fileRecord) {
      // Try to clean up the uploaded file if db insert fails
      try {
        await deleteFilesObjects({
          supabase,
          orgId: portalToken.org_id,
          paths: [storagePath],
        })
      } catch (cleanupError) {
        console.warn("Storage cleanup error:", cleanupError)
      }
      console.error("DB insert error:", dbError)
      return { success: false, error: "Failed to save file record" }
    }

    return {
      success: true,
      fileId: fileRecord.id,
      fileName: fileRecord.file_name,
    }
  } catch (err) {
    console.error("Failed to upload invoice file:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to upload file",
    }
  }
}

export interface ScanPortalInvoiceResult {
  success: boolean
  error?: string
  data?: {
    billNumber: string | null
    billDate: string | null
    dueDate: string | null
    totalDollars: number | null
    description: string | null
    confidence: "high" | "medium" | "low"
    notes: string[]
    lines: Array<{ description: string; quantity: number | null; unit: string | null; amountDollars: number }>
  }
}

/**
 * Read a subcontractor's own invoice for them.
 *
 * Subs typing an invoice they are already uploading is pure duplicate work, and
 * the same scan already runs on the builder side. Deliberately narrower than the
 * internal path: the sub is an external party, so the result never carries a
 * vendor match, a duplicate verdict, or anything derived from the org's records.
 * They get their own document read back, nothing about anyone else's.
 */
export async function scanPortalInvoiceAction({
  token,
  formData,
}: {
  token: string
  formData: FormData
}): Promise<ScanPortalInvoiceResult> {
  try {
    const portalToken = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireProject: true,
      requireCompany: true,
      permission: "can_submit_invoices",
    })
    if (!portalToken.company_id) return { success: false, error: "Invalid portal type" }

    const file = formData.get("file")
    if (!(file instanceof File)) return { success: false, error: "No file provided" }

    // The portal knows the vendor before the scan, so prior corrections on this
    // vendor's invoices inform the read.
    const extraction = await extractPayableInvoiceFromFile(file, {
      orgId: portalToken.org_id,
      companyId: portalToken.company_id,
    })

    if (!extraction.billable) {
      return {
        success: false,
        error: extraction.notes[0] ?? "That does not look like an invoice.",
      }
    }

    return {
      success: true,
      data: {
        billNumber: extraction.billNumber,
        billDate: extraction.billDate,
        dueDate: extraction.dueDate,
        totalDollars: extraction.totalDollars,
        description: extraction.description,
        confidence: extraction.confidence,
        // Only the sub's own document is described back; the mismatch note is
        // useful to them, the duplicate note would leak the builder's ledger.
        notes: extraction.sumMismatch ? extraction.notes.slice(0, 1) : [],
        lines: extraction.lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          amountDollars: line.amountCents / 100,
        })),
      },
    }
  } catch (error) {
    console.warn("[PortalInvoiceScan] Scan failed", error)
    return { success: false, error: "Could not read that invoice. You can enter the details manually." }
  }
}
