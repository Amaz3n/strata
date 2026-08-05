import "server-only"

import { z } from "zod"

import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * 1099 totals from what Arc actually paid.
 *
 * `companies` already carried the tax side — `is_1099_eligible`, W-9 state, TIN
 * verification, backup withholding — but nothing ever accumulated payments
 * against it, so January was a manual reconstruction from bank statements.
 *
 * Reversals subtract. A payment that was returned was not income to the vendor,
 * and reporting it would overstate what they received on a form the IRS also
 * receives.
 */

const yearSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  /** IRS reporting threshold for 1099-NEC; below it, no form is required. */
  minimumCents: z.number().int().min(0).default(60_000),
})

export interface Vendor1099Total {
  companyId: string
  companyName: string
  /** Legal filing name when it differs from the trade name Arc knows them by. */
  filingName: string | null
  taxEntityType: string | null
  taxIdLast4: string | null
  is1099Eligible: boolean
  w9OnFile: boolean
  backupWithholding: boolean
  tinVerificationStatus: string | null
  paidCents: number
  reversedCents: number
  reportableCents: number
  paymentCount: number
  /** True when the vendor is reportable but Arc cannot file without more data. */
  blockedForFiling: boolean
  blockingReasons: string[]
}

/**
 * Totals by vendor for a calendar year.
 *
 * Counts what settled, by settlement date rather than bill date — the form
 * reports what the vendor received in the year, not what they invoiced.
 */
export async function getVendor1099Totals(
  input: { year: number; minimumCents?: number },
  orgId?: string,
): Promise<Vendor1099Total[]> {
  const parsed = yearSchema.parse({ year: input.year, minimumCents: input.minimumCents ?? 60_000 })
  const context = await requireOrgContext(orgId)
  await requirePermission("financials.export", context)
  const supabase = createServiceSupabaseClient()

  const periodStart = `${parsed.year}-01-01T00:00:00.000Z`
  const periodEnd = `${parsed.year + 1}-01-01T00:00:00.000Z`

  // Paged: a production builder's AP year runs to tens of thousands of payments,
  // and a silently truncated tax total is worse than no total at all.
  const payments: Array<{ id: string; amount_cents: number; bill_id: string | null }> = []
  const pageSize = 1_000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("payments")
      .select("id,amount_cents,bill_id")
      .eq("org_id", context.orgId)
      .not("bill_id", "is", null)
      .in("status", ["succeeded", "completed"])
      .gte("received_at", periodStart)
      .lt("received_at", periodEnd)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`Unable to load vendor payments: ${error.message}`)
    payments.push(...(data ?? []))
    if ((data ?? []).length < pageSize) break
  }
  if (payments.length === 0) return []

  const billIds = [...new Set(payments.map((payment) => payment.bill_id).filter((id): id is string => Boolean(id)))]
  const companyByBill = new Map<string, string>()
  for (let index = 0; index < billIds.length; index += 500) {
    const { data } = await supabase
      .from("vendor_bills")
      .select("id,company_id")
      .eq("org_id", context.orgId)
      .in("id", billIds.slice(index, index + 500))
    for (const bill of data ?? []) if (bill.company_id) companyByBill.set(bill.id, bill.company_id)
  }

  // Reversals subtract from the year they reversed in, matching how the payment
  // itself was counted.
  const { data: reversals } = await supabase
    .from("payment_reversals")
    .select("payment_id,amount_cents")
    .eq("org_id", context.orgId)
    .in("status", ["pending", "succeeded"])
    .gte("created_at", periodStart)
    .lt("created_at", periodEnd)
  const reversedByPayment = new Map<string, number>()
  for (const reversal of reversals ?? []) {
    reversedByPayment.set(reversal.payment_id, (reversedByPayment.get(reversal.payment_id) ?? 0) + Number(reversal.amount_cents))
  }

  const totals = new Map<string, { paid: number; reversed: number; count: number }>()
  for (const payment of payments) {
    const companyId = payment.bill_id ? companyByBill.get(payment.bill_id) : null
    if (!companyId) continue
    const current = totals.get(companyId) ?? { paid: 0, reversed: 0, count: 0 }
    current.paid += Number(payment.amount_cents)
    current.reversed += reversedByPayment.get(payment.id) ?? 0
    current.count += 1
    totals.set(companyId, current)
  }
  if (totals.size === 0) return []

  const companyIds = [...totals.keys()]
  const companies: Array<Record<string, unknown>> = []
  for (let index = 0; index < companyIds.length; index += 500) {
    const { data } = await supabase
      .from("companies")
      .select("id,name,filing_name,tax_entity_type,tax_id_last4,is_1099_eligible,w9_received_at,backup_withholding,tin_verification_status,tax_exempt")
      .eq("org_id", context.orgId)
      .in("id", companyIds.slice(index, index + 500))
    companies.push(...(data ?? []))
  }

  return companies
    .flatMap((company) => {
      const total = totals.get(String(company.id))
      if (!total) return []
      const reportableCents = Math.max(0, total.paid - total.reversed)
      if (company.tax_exempt === true) return []
      if (reportableCents < parsed.minimumCents) return []

      // Reportable but unfileable is the state worth surfacing in December
      // rather than discovering at the filing deadline.
      const blockingReasons: string[] = []
      if (!company.w9_received_at) blockingReasons.push("No W-9 on file")
      if (!company.tax_id_last4) blockingReasons.push("No taxpayer ID recorded")
      if (company.tin_verification_status === "mismatch") blockingReasons.push("TIN does not match IRS records")

      return [{
        companyId: String(company.id),
        companyName: String(company.name ?? "Vendor"),
        filingName: (company.filing_name as string | null) ?? null,
        taxEntityType: (company.tax_entity_type as string | null) ?? null,
        taxIdLast4: (company.tax_id_last4 as string | null) ?? null,
        is1099Eligible: company.is_1099_eligible === true,
        w9OnFile: Boolean(company.w9_received_at),
        backupWithholding: company.backup_withholding === true,
        tinVerificationStatus: (company.tin_verification_status as string | null) ?? null,
        paidCents: total.paid,
        reversedCents: total.reversed,
        reportableCents,
        paymentCount: total.count,
        blockedForFiling: blockingReasons.length > 0,
        blockingReasons,
      }]
    })
    .sort((left, right) => right.reportableCents - left.reportableCents)
}
