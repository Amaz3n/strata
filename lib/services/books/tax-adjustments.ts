import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { booksDigest } from "@/lib/services/books/hash"
import { taxWorkpaperEvidenceSchema } from "@/lib/services/books/tax-adjustment-lines"
import { taxAttachmentFromFile } from "@/lib/services/books/tax-attachment-rules"
import { verifyTaxAttachmentBytes } from "@/lib/services/books/tax-attachments"
import { cashProfitAndLossFromSnapshot } from "@/lib/services/books/cash-profit-loss"
import { cashTaxWorkpaperBasis, taxAdjustmentLinesSchema, reconcileTaxWorkpaper, totalTaxAdjustments } from "@/lib/services/books/tax-adjustment-rules"

async function access(permission: "books.read" | "books.adjust") {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission, userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "tax_workpaper", resourceId: context.orgId, logDecision: true })
  return context
}
async function capture(orgId: string, startDate: string, endDate: string) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service.rpc("capture_books_tax_workpaper_context", { p_org_id: orgId, p_period_end: endDate })
  if (error) throw new Error(`Failed to capture tax workpaper basis: ${error.message}`)
  const report = cashProfitAndLossFromSnapshot(orgId, startDate, endDate, data)
  const revision = z.object({ taxSourceRevision: z.string() }).parse(data).taxSourceRevision
  return { service, data, basis: cashTaxWorkpaperBasis(report, revision) }
}
export async function prepareTaxWorkpaper(input: { startDate: string; endDate: string; lines: unknown; idempotencyKey: string; supersedesId?: string | null; preparationNotes?: string }) {
  const context = await access("books.adjust")
  const evidence = taxWorkpaperEvidenceSchema.parse({ lines: input.lines, preparation_notes: input.preparationNotes })
  const { service, data: snapshot, basis } = await capture(context.orgId, input.startDate, input.endDate)
  const files = z.object({ tables: z.object({ files: z.array(z.record(z.unknown())) }) }).parse(snapshot).tables.files
  for (const line of evidence.lines) {
    if (!line.evidence_file_id) { line.evidence_snapshot = null; continue }
    const file = files.find(file => file.id === line.evidence_file_id)
    if (!file) throw new Error("Tax attachment file is outside captured organization")
    // Freeze server-observed metadata; never accept a client-supplied checksum.
    line.evidence_snapshot = taxAttachmentFromFile(context.orgId, file)
    await verifyTaxAttachmentBytes(service, context.orgId, line.evidence_snapshot)
  }
  const { data, error } = await service.rpc("prepare_books_tax_workpaper", { p_org_id: context.orgId, p_actor_id: context.userId,
    p_period_start: input.startDate, p_period_end: input.endDate, p_base_digest: basis.digest, p_base_snapshot: basis.snapshot,
    p_lines: evidence.lines, p_preparation_notes: evidence.preparation_notes, p_idempotency_key: z.string().min(10).max(200).parse(input.idempotencyKey), p_supersedes_id: input.supersedesId ?? null })
  if (error) throw new Error(`Failed to prepare tax workpaper: ${error.message}`)
  return z.string().uuid().parse(data)
}
const batchSchema = z.object({ id: z.string().uuid(), org_id: z.string().uuid(), status: z.string(), period_start: z.string(), period_end: z.string(), base_digest: z.string(), base_snapshot: z.object({ net_income_cents: z.number().int().safe() }).passthrough(), lines: taxAdjustmentLinesSchema, preparation_notes: z.string().default(""), prepared_by: z.string().uuid(), reviewed_by: z.string().uuid().nullable(), reviewed_at: z.string().nullable().optional(), review_notes: z.string().nullable().optional(), closed_by: z.string().uuid().nullable().optional(), closed_at: z.string().nullable().optional(), close_reason: z.string().nullable().optional() }).superRefine((batch,context) => {
  if (!taxWorkpaperEvidenceSchema.safeParse(batch).success) context.addIssue({ code: z.ZodIssueCode.custom, message: "Tax workpaper lacks preparation evidence" })
})
export async function getTaxWorkpaperWorkspace(startDate: string, endDate: string) {
  const context = await access("books.read")
  const { data, basis } = await capture(context.orgId, startDate, endDate)
  const snapshot = z.object({ tables: z.object({ books_tax_adjustment_workpapers: z.array(batchSchema), files: z.array(z.record(z.unknown())) }) }).parse(data)
  const attachmentOptions = snapshot.tables.files.flatMap(file => {
    try { const proof = taxAttachmentFromFile(context.orgId, file); return [{ id: proof.file_id, name: proof.file_name, versionId: proof.document_version_id }] }
    catch { return [] }
  }).sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const workpapers = snapshot.tables.books_tax_adjustment_workpapers
    .filter(batch => batch.period_start === startDate && batch.period_end === endDate)
    .map(batch => {
      if (booksDigest(batch.base_snapshot) !== batch.base_digest) throw new Error("Stored tax workpaper basis failed integrity verification")
      return { id: batch.id, status: batch.status, prepared_by: batch.prepared_by, reviewed_by: batch.reviewed_by,
        reviewed_at: batch.reviewed_at, review_notes: batch.review_notes, preparation_notes: batch.preparation_notes,
        closed_by: batch.closed_by, closed_at: batch.closed_at, close_reason: batch.close_reason,
        current: batch.base_digest === basis.digest, ...totalTaxAdjustments(batch.lines) }
    })
    .sort((a,b) => a.id.localeCompare(b.id))
  return { startDate, endDate, userId: context.userId, bookIncomeCents: basis.snapshot.net_income_cents, workpapers, attachmentOptions }
}
export async function withdrawTaxWorkpaper(input: { id: string; reason: string }) {
  const context = await access("books.adjust")
  const { data, error } = await createServiceSupabaseClient().rpc("withdraw_books_tax_workpaper", {
    p_org_id: context.orgId, p_id: z.string().uuid().parse(input.id), p_actor_id: context.userId,
    p_reason: z.string().trim().min(10).max(2000).parse(input.reason),
  })
  if (error) throw new Error(`Failed to withdraw tax workpaper: ${error.message}`)
  return z.string().uuid().parse(data)
}
export async function reviewTaxWorkpaper(input: { id: string; notes: string }) {
  const context = await access("books.adjust")
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("books_tax_adjustment_workpapers").select("*").eq("org_id", context.orgId).eq("id", z.string().uuid().parse(input.id)).single()
  if (error) throw new Error(`Failed to load tax workpaper: ${error.message}`)
  const batch = batchSchema.parse(data)
  for (const line of batch.lines) if (line.evidence_file_id) {
    if (!line.evidence_snapshot) throw new Error("Tax attachment lacks frozen evidence; prepare a replacement")
    await verifyTaxAttachmentBytes(service, context.orgId, line.evidence_snapshot)
  }
  const { basis } = await capture(context.orgId, batch.period_start, batch.period_end)
  const reviewed = await service.rpc("review_books_tax_workpaper", { p_org_id: context.orgId, p_id: batch.id, p_actor_id: context.userId, p_current_base_digest: basis.digest, p_notes: z.string().trim().min(10).max(2000).parse(input.notes) })
  if (reviewed.error && /changed before review/i.test(reviewed.error.message)) throw new Error("The books changed after this workpaper was prepared. Withdraw it and prepare a replacement from the current books.")
  if (reviewed.error) throw new Error(`Failed to review tax workpaper: ${reviewed.error.message}`)
  return batch.id
}
export async function buildTaxWorkpaperReport(startDate: string, endDate: string) {
  const context = await access("books.read")
  const { data, basis } = await capture(context.orgId, startDate, endDate)
  const snapshot = z.object({ tables: z.object({ books_tax_adjustment_workpapers: z.array(batchSchema) }) }).parse(data)
  const batches = snapshot.tables.books_tax_adjustment_workpapers.filter(batch => batch.status === "approved" && batch.period_start === startDate && batch.period_end === endDate)
  if (batches.length !== 1) throw new Error("Prepare and review exactly one tax workpaper for this exact reporting period")
  if (!batches[0].reviewed_at || !batches[0].review_notes || batches[0].review_notes.trim().length < 10) throw new Error("Tax workpaper has incomplete review evidence")
  for (const line of batches[0].lines) if (line.evidence_file_id) {
    if (!line.evidence_snapshot) throw new Error("Tax attachment lacks frozen evidence; prepare a replacement")
    await verifyTaxAttachmentBytes(createServiceSupabaseClient(), context.orgId, line.evidence_snapshot)
  }
  return { preparationNotes: batches[0].preparation_notes, reviewNotes: batches[0].review_notes, preparedBy: batches[0].prepared_by, reviewedBy: batches[0].reviewed_by, reviewedAt: batches[0].reviewed_at, startDate, endDate, workpaperId: batches[0].id, baseDigest: basis.digest, ...reconcileTaxWorkpaper({ orgId: context.orgId, basis, batch: batches[0] }) }
}
