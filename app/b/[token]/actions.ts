"use server"

import { bidPortalPinSchema, bidPortalSubmissionInputSchema } from "@/lib/validation/bid-portal"
import { portalRfiInputSchema, rfiResponseInputSchema } from "@/lib/validation/rfis"
import {
  acknowledgeBidAddendum,
  submitBidFromPortal,
  validateBidPortalPin,
  validateBidPortalToken,
  type BidPortalSubmission,
} from "@/lib/services/bid-portal"
import { createPortalRfi, addRfiResponse, listRfiResponses } from "@/lib/services/rfis"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { deleteFilesObjects, uploadFilesObject } from "@/lib/storage/files-storage"

export async function verifyBidPortalPinAction({
  token,
  pin,
}: {
  token: string
  pin: string
}) {
  const parsed = bidPortalPinSchema.safeParse(pin)
  if (!parsed.success) {
    return { valid: false }
  }
  return validateBidPortalPin({ token, pin: parsed.data })
}

export interface SubmitBidResult {
  success: boolean
  error?: string
  submission?: BidPortalSubmission
}

export async function submitBidAction({
  token,
  input,
}: {
  token: string
  input: unknown
}): Promise<SubmitBidResult> {
  try {
    const parsed = bidPortalSubmissionInputSchema.safeParse(input)
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]
      return { success: false, error: firstError?.message ?? "Invalid input" }
    }

    const access = await validateBidPortalToken(token)
    if (!access) {
      return { success: false, error: "Invalid or expired bid link" }
    }

    const submission = await submitBidFromPortal({ access, input: parsed.data })

    return { success: true, submission }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to submit bid",
    }
  }
}

export async function acknowledgeBidAddendumAction({
  token,
  addendumId,
}: {
  token: string
  addendumId: string
}) {
  const access = await validateBidPortalToken(token)
  if (!access) {
    return { success: false, error: "Invalid or expired bid link" }
  }

  try {
    const result = await acknowledgeBidAddendum({ access, addendumId })
    return { success: true, acknowledged_at: result.acknowledged_at }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to acknowledge addendum",
    }
  }
}

export interface UploadBidFileResult {
  success: boolean
  error?: string
  fileId?: string
  fileName?: string
}

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB
const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]

export async function uploadBidFileAction({
  token,
  formData,
}: {
  token: string
  formData: FormData
}): Promise<UploadBidFileResult> {
  try {
    const access = await validateBidPortalToken(token)
    if (!access) {
      return { success: false, error: "Invalid or expired bid link" }
    }

    const file = formData.get("file") as File
    if (!file) {
      return { success: false, error: "No file provided" }
    }

    if (file.size > MAX_FILE_SIZE) {
      return { success: false, error: "File size exceeds 25MB limit" }
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return { success: false, error: "Invalid file type" }
    }

    const supabase = createServiceSupabaseClient()

    const timestamp = Date.now()
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_")
    const storagePath = `${access.org_id}/${access.project.id}/bid-submissions/${access.bid_invite_id}/${timestamp}_${safeName}`

    const fileBytes = Buffer.from(await file.arrayBuffer())
    try {
      await uploadFilesObject({
        supabase,
        orgId: access.org_id,
        path: storagePath,
        bytes: fileBytes,
        contentType: file.type,
        upsert: false,
      })
    } catch (uploadError) {
      console.error("Storage upload error:", uploadError)
      return { success: false, error: "Failed to upload file" }
    }

    const { data: fileRecord, error: dbError } = await supabase
      .from("files")
      .insert({
        org_id: access.org_id,
        project_id: access.project.id,
        file_name: file.name,
        storage_path: storagePath,
        mime_type: file.type,
        size_bytes: file.size,
        visibility: "private",
        metadata: {
          uploaded_via_portal: true,
          bid_invite_id: access.bid_invite_id,
          bid_package_id: access.bidPackage.id,
          file_type: "bid_attachment",
        },
      })
      .select("id, file_name")
      .single()

    if (dbError || !fileRecord) {
      try {
        await deleteFilesObjects({ supabase, orgId: access.org_id, paths: [storagePath] })
      } catch (cleanupError) {
        console.error("Storage cleanup error:", cleanupError)
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
    console.error("Failed to upload bid file:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to upload file",
    }
  }
}

export async function createBidPortalRfiAction({ token, input }: { token: string; input: unknown }) {
  const access = await validateBidPortalToken(token)
  if (!access) return { success: false, error: "Invalid or expired bid link" as const }

  const parsed = portalRfiInputSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? "Invalid input" as const }
  }

  try {
    const created = await createPortalRfi({
      orgId: access.org_id,
      projectId: access.project.id,
      companyId: access.invite.company?.id ?? null,
      contactId: access.invite.contact?.id ?? null,
      subject: parsed.data.subject,
      question: parsed.data.question,
      priority: parsed.data.priority,
      dueDate: parsed.data.due_date ?? null,
    })
    return { success: true, rfi: created }
  } catch (error) {
    return { success: false, error: (error as Error)?.message ?? "Failed to create RFI" as const }
  }
}

export async function listBidPortalRfiResponsesAction({ token, rfiId }: { token: string; rfiId: string }) {
  const access = await validateBidPortalToken(token)
  if (!access) throw new Error("Invalid or expired bid link")

  const supabase = createServiceSupabaseClient()
  const { data: rfi } = await supabase
    .from("rfis")
    .select("id, org_id, project_id, assigned_company_id")
    .eq("id", rfiId)
    .eq("org_id", access.org_id)
    .eq("project_id", access.project.id)
    .maybeSingle()
  if (!rfi) throw new Error("RFI not found")
  if (rfi.assigned_company_id && access.invite.company?.id && rfi.assigned_company_id !== access.invite.company.id) {
    throw new Error("Access denied")
  }

  return listRfiResponses({ orgId: access.org_id, rfiId })
}

export async function addBidPortalRfiResponseAction({ token, input }: { token: string; input: unknown }) {
  const access = await validateBidPortalToken(token)
  if (!access) return { success: false, error: "Invalid or expired bid link" as const }

  const parsed = rfiResponseInputSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? "Invalid input" as const }
  }

  try {
    const result = await addRfiResponse({
      orgId: access.org_id,
      input: {
        ...parsed.data,
        responder_contact_id: access.invite.contact?.id ?? parsed.data.responder_contact_id ?? null,
        responder_user_id: null,
        portal_token_id: null,
        created_via_portal: true,
      },
    })
    return { success: true, result }
  } catch (error) {
    return { success: false, error: (error as Error)?.message ?? "Failed to add response" as const }
  }
}
