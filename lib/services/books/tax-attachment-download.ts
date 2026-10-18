import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "./access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { taxAdjustmentLinesSchema } from "./tax-adjustment-lines"
import { stageVerifiedTaxAttachment } from "./tax-attachments"

export class TaxAttachmentDownloadError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function downloadTaxWorkpaperAttachment(workpaperId: string, lineId: string, signal?: AbortSignal) {
  if (!z.string().uuid().safeParse(workpaperId).success || !z.string().uuid().safeParse(lineId).success) throw new TaxAttachmentDownloadError(400, "Invalid attachment request")
  const context = await requireOrgContext()
  try {
    await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "tax_workpaper", resourceId: workpaperId, logDecision: true })
  } catch { throw new TaxAttachmentDownloadError(403, "Accounting access is required") }
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("books_tax_adjustment_workpapers").select("org_id,lines").eq("org_id", context.orgId).eq("id", workpaperId).maybeSingle()
  if (error) throw new TaxAttachmentDownloadError(500, "Could not load attachment evidence")
  if (!data || data.org_id !== context.orgId) throw new TaxAttachmentDownloadError(404, "Attachment not found")
  const parsed = taxAdjustmentLinesSchema.safeParse(data.lines)
  if (!parsed.success) throw new TaxAttachmentDownloadError(409, "Stored attachment evidence is invalid")
  const line = parsed.data.find(row => row.id === lineId)
  if (!line?.evidence_file_id) throw new TaxAttachmentDownloadError(404, "Attachment not found")
  const proof = line.evidence_snapshot
  if (!proof || proof.org_id !== context.orgId || proof.file_id !== line.evidence_file_id) throw new TaxAttachmentDownloadError(409, "Original attachment identity is unavailable; prepare a replacement")
  try {
    const body = await stageVerifiedTaxAttachment(service, context.orgId, proof, signal)
    return { body, name: proof.file_name, size: proof.size_bytes, checksum: proof.checksum }
  } catch { throw new TaxAttachmentDownloadError(409, "Original attachment is unavailable or differs from saved evidence") }
}
