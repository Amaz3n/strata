"use server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { validatePortalToken } from "@/lib/services/portal-access"
import { createVendorBillFromPortal } from "@/lib/services/vendor-bills"
import { vendorBillCreateSchema, type VendorBillCreate } from "@/lib/validation/vendor-bills"

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
    // Validate the portal token
    const portalToken = await validatePortalToken(token)
    if (!portalToken) {
      return { success: false, error: "Invalid or expired portal access" }
    }

    // Ensure this is a sub portal with company_id
    if (portalToken.portal_type !== "sub" || !portalToken.company_id) {
      return { success: false, error: "Invalid portal type" }
    }

    // Check permission
    if (!portalToken.permissions.can_submit_invoices) {
      return { success: false, error: "You do not have permission to submit invoices" }
    }

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
      overBudget: bill.commitment_total_cents
        ? (bill.total_cents ?? 0) > (bill.commitment_total_cents ?? 0)
        : false,
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
    // Validate the portal token
    const portalToken = await validatePortalToken(token)
    if (!portalToken) {
      return { success: false, error: "Invalid or expired portal access" }
    }

    // Ensure this is a sub portal with company_id
    if (portalToken.portal_type !== "sub" || !portalToken.company_id) {
      return { success: false, error: "Invalid portal type" }
    }

    // Check permission
    if (!portalToken.permissions.can_submit_invoices) {
      return { success: false, error: "You do not have permission to upload files" }
    }

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

    // Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("project-files")
      .upload(storagePath, file, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
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
      await supabase.storage.from("project-files").remove([storagePath])
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
