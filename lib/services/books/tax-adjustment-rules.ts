import { z } from "zod"
import { booksDigest } from "@/lib/services/books/hash"
import type { cashProfitAndLossFromSnapshot } from "@/lib/services/books/cash-profit-loss"

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value, "Invalid tax workpaper date")
export { taxAdjustmentLineSchema, taxAdjustmentLinesSchema, totalTaxAdjustments } from "./tax-adjustment-lines"
import { totalTaxAdjustments, taxWorkpaperEvidenceSchema } from "./tax-adjustment-lines"
function safe(value: bigint) { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error("Tax workpaper exceeds safe integer cents"); return result }
/** Hash economic evidence, not capture time, labels or the changing MVCC token. */
export function cashTaxWorkpaperBasis(report: ReturnType<typeof cashProfitAndLossFromSnapshot>, sourceRevision: string) {
  z.string().regex(/^[a-f0-9]{64}$/).parse(sourceRevision)
  date.parse(report.startDate); date.parse(report.endDate)
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean).sort((a,b) => booksDigest(a).localeCompare(booksDigest(b)))
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["capturedAt", "databaseSnapshot", "documentLabel", "projectName", "companyName", "costCodeName"].includes(key)).map(([key,value]) => [key,clean(value)]))
    return value
  }
  const snapshot = { version: 1, basis: "cash" as const, start_date: report.startDate, end_date: report.endDate,
    net_income_cents: report.netIncomeCents, cash_movement_cents: report.netCashMovementCents,
    sales_tax_cents: report.salesTaxCollectedCents, capitalized_purchases_cents: report.capitalizedPurchasesCents,
    source_revision: sourceRevision, evidence: clean(report.sourceEvidence) }
  return { snapshot, digest: booksDigest(snapshot) }
}
export function reconcileTaxWorkpaper(input: { basis: ReturnType<typeof cashTaxWorkpaperBasis>; batch: { org_id: string; status: string; period_start: string; period_end: string; base_digest: string; base_snapshot: { net_income_cents: number }; lines: unknown; preparation_notes?: string; prepared_by: string; reviewed_by: string | null }; orgId: string }) {
  const { batch, basis } = input
  if (booksDigest(batch.base_snapshot) !== batch.base_digest) throw new Error("Stored tax workpaper basis failed integrity verification")
  if (batch.org_id !== input.orgId || batch.status !== "approved" || batch.period_start !== basis.snapshot.start_date || batch.period_end !== basis.snapshot.end_date) throw new Error("Tax workpaper is not approved for this organization and exact period")
  if (!batch.reviewed_by || batch.reviewed_by === batch.prepared_by) throw new Error("Tax workpaper requires a separate reviewer")
  if (batch.base_digest !== basis.digest || batch.base_snapshot.net_income_cents !== basis.snapshot.net_income_cents) throw new Error("Underlying cash books changed; prepare and review a replacement tax workpaper")
  taxWorkpaperEvidenceSchema.parse(batch)
  const adjustments = totalTaxAdjustments(batch.lines)
  for (const line of adjustments.lines) if (line.evidence_file_id && (!line.evidence_snapshot || line.evidence_snapshot.org_id !== input.orgId)) throw new Error("Tax attachment lacks frozen scoped evidence; prepare a replacement")
  return { ...adjustments, bookIncomeCents: basis.snapshot.net_income_cents, adjustedIncomeCents: safe(BigInt(basis.snapshot.net_income_cents) + BigInt(adjustments.totalCents)) }
}
