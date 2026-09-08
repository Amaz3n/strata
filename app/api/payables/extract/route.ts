import { NextResponse } from "next/server"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { payableFileDuplicateWarning } from "@/lib/services/payable-file-duplicates"
import { createFileFromUpload } from "@/lib/services/files"
import { extractPayableInvoiceFromFile } from "@/lib/services/document-extraction"
import { invoiceFileError, payableIntakeError } from "@/lib/payables/intake"

export const maxDuration = 180

/** Fetch avoids the browser's serialized Server Action queue. Persist and read
 * the same bytes concurrently, and return the file ID even when AI fails. */
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin")
    if (origin && origin !== new URL(request.url).origin) return NextResponse.json({ error: "Invalid origin" }, { status: 403 })
    const form = await request.formData()
    const invoice = form.get("invoice")
    const projectId = z.string().uuid().nullable().parse(form.get("projectId"))
    const companyId = z.string().uuid().nullable().parse(form.get("companyId"))
    if (!(invoice instanceof File)) throw new Error("Choose an invoice")
    const error = invoiceFileError(invoice)
    if (error) return NextResponse.json({ error }, { status: 400 })
    const ctx = await requireOrgContext()
    await requireAuthorization({ ...ctx, permission: "bill.write", projectId: projectId ?? undefined,
      resourceType: projectId ? "project" : "vendor_bill", resourceId: projectId ?? "new" })
    const [upload, extraction] = await Promise.allSettled([
      createFileFromUpload({ allowDuplicateContent: true, file: invoice, projectId, category: "financials", visibility: "private" }),
      extractPayableInvoiceFromFile(invoice, { orgId: ctx.orgId, projectId, companyId }),
    ])
    if (upload.status === "rejected") throw upload.reason
    const duplicateWarning = await payableFileDuplicateWarning(ctx.supabase, ctx.orgId, upload.value.checksum)
    if (extraction.status === "fulfilled" && duplicateWarning) { extraction.value.duplicateSuspected = true; extraction.value.duplicateReason = duplicateWarning }
    return NextResponse.json({ fileId: upload.value.id,
      ...(extraction.status === "fulfilled" ? { ok: true, data: extraction.value } : { ok: false, error: payableIntakeError(extraction.reason) }),
    })
  } catch (error) {
    console.error("Invoice extraction failed", error)
    return NextResponse.json({ error: payableIntakeError(error) }, { status: 400 })
  }
}
