import "server-only"

import { z } from "zod"

import { BILLED_INVOICE_STATUSES } from "@/lib/financials/ledger-status"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { createCompleteBooksExport } from "@/lib/services/books/exports"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getVendor1099Report } from "@/lib/services/reports/vendor-1099"

/**
 * Sales tax billed, grouped by jurisdiction — and honest about what it cannot say.
 *
 * Two gaps are structural, not bugs to be tidied, and they are reported rather
 * than papered over because an accountant could otherwise read this table as a
 * return:
 *
 *  - **Jurisdiction is not captured anywhere.** `metadata.tax_jurisdiction` is
 *    read here and written by nothing in the codebase, so every invoice falls to
 *    "Unassigned". Typing the field would not change that; something has to
 *    *collect* a jurisdiction at invoicing first.
 *  - **Use tax is not computed at all.** Self-assessed use tax is a fact about
 *    purchases, and `vendor_bills` has no tax column — there is no input, so
 *    there is nothing to compute. The name of this summary is aspirational on
 *    that half.
 *
 * Both are noted in the C4.5 plan entry. Until a customer actually charges sales
 * tax, building the jurisdiction subsystem would produce a typed field that is
 * still always empty and a use-tax figure with nothing behind it.
 */
export async function buildSalesUseTaxSummary(input: { startDate: string; endDate: string; orgId?: string }) {
  const context = await requireOrgContext(input.orgId)
  await requireAuthorization({ permission: "books.tax", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "tax_summary", resourceId: context.orgId, logDecision: true })
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("invoices").select("id, issue_date, subtotal_cents, tax_cents, total_cents, metadata, project_id").eq("org_id", context.orgId).gte("issue_date", input.startDate).lte("issue_date", input.endDate).in("status", [...BILLED_INVOICE_STATUSES])
  if (error) throw new Error(`Failed to build sales/use-tax summary: ${error.message}`)
  const byJurisdiction = new Map<string, { taxableSalesCents: number; taxCents: number; invoiceCount: number }>()
  for (const invoice of data ?? []) {
    const metadata = invoice.metadata && typeof invoice.metadata === "object" && !Array.isArray(invoice.metadata) ? invoice.metadata : {}
    const jurisdiction = typeof metadata.tax_jurisdiction === "string" && metadata.tax_jurisdiction.trim() ? metadata.tax_jurisdiction.trim() : "Unassigned"
    const current = byJurisdiction.get(jurisdiction) ?? { taxableSalesCents: 0, taxCents: 0, invoiceCount: 0 }
    current.taxableSalesCents += Number(invoice.subtotal_cents ?? 0)
    current.taxCents += Number(invoice.tax_cents ?? 0)
    current.invoiceCount += 1
    byJurisdiction.set(jurisdiction, current)
  }
  const rows = Array.from(byJurisdiction, ([jurisdiction, totals]) => ({ jurisdiction, ...totals })).sort((left, right) =>
    left.jurisdiction.localeCompare(right.jurisdiction),
  )
  const unassignedCount = byJurisdiction.get("Unassigned")?.invoiceCount ?? 0
  return {
    startDate: input.startDate,
    endDate: input.endDate,
    rows,
    // Stated as findings, not a disclaimer nobody reads. An accountant seeing
    // "every invoice is Unassigned" knows to ask why; a table that just says
    // "Unassigned" looks like a data-entry oversight they should chase.
    limitations: [
      ...(unassignedCount > 0
        ? [
            `${unassignedCount} of ${rows.reduce((sum, row) => sum + row.invoiceCount, 0)} invoices carry no tax jurisdiction. Arc does not yet capture one at invoicing, so this grouping cannot be used to allocate tax between jurisdictions.`,
          ]
        : []),
      "Use tax on purchases is not included. Arc does not record tax charged on vendor bills, so self-assessed use tax cannot be computed from this ledger.",
    ],
    warning: "Summary only. Confirm contractor and resale treatment with a qualified tax professional before filing.",
  }
}

export async function createAccountantPackage(input: { periodId?: string; taxYear?: number; orgId?: string }) {
  if (!input.periodId && !input.taxYear) throw new Error("An accounting period or tax year is required")
  const context = await requireOrgContext(input.orgId)
  await requireAuthorization({ permission: "books.export", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "accountant_package", resourceId: context.orgId, logDecision: true })
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("accountant_packages").insert({ org_id: context.orgId, period_id: input.periodId ?? null, tax_year: input.taxYear ?? null, status: "generating", requested_by: context.userId }).select("id").single()
  if (error) throw new Error(`Failed to start accountant package: ${error.message}`)
  const packageId = z.object({ id: z.string().uuid() }).parse(data).id
  try {
    const [exportResult, vendor1099] = await Promise.all([
      createCompleteBooksExport({ exportType: "accountant", orgId: context.orgId }),
      input.taxYear ? getVendor1099Report({ year: input.taxYear, orgId: context.orgId }) : Promise.resolve(null),
    ])
    const manifest = { ...exportResult.manifest, books_export_id: exportResult.exportId, period_id: input.periodId ?? null, tax_year: input.taxYear ?? null, vendor_1099: vendor1099 ? { threshold_cents: vendor1099.threshold_cents, vendor_count: vendor1099.rows.length, exception_count: vendor1099.rows.filter((row) => row.meets_threshold && (!row.w9_on_file || !row.tax_id_last4)).length } : null }
    const update = await service.from("accountant_packages").update({ status: "ready", storage_path: exportResult.storagePath, content_hash: exportResult.contentHash, manifest, completed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }).eq("org_id", context.orgId).eq("id", packageId)
    if (update.error) throw new Error(update.error.message)
    await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.accountant_package_ready", entityType: "accountant_package", entityId: packageId, payload: { period_id: input.periodId ?? null, tax_year: input.taxYear ?? null }, channel: "notification" })
    return { packageId, ...exportResult, vendor1099 }
  } catch (packageError) {
    await service.from("accountant_packages").update({ status: "failed", error_message: packageError instanceof Error ? packageError.message : String(packageError) }).eq("org_id", context.orgId).eq("id", packageId)
    throw packageError
  }
}
