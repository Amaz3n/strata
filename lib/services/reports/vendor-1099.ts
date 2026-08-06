import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type Vendor1099Row = {
  company_id: string
  vendor_name: string
  tax_id_last4: string | null
  tax_entity_type: string | null
  w9_on_file: boolean
  total_paid_cents: number
  reversed_cents: number
  meets_threshold: boolean
  /** Reportable, but Arc does not hold enough to file. Surfaced in December, not at the deadline. */
  blocked_for_filing: boolean
  blocking_reasons: string[]
}

export type Vendor1099Report = {
  tax_year: number
  threshold_cents: number
  rows: Vendor1099Row[]
  total_paid_cents: number
}

export async function getVendor1099Report({ year, orgId }: { year?: number; orgId?: string } = {}): Promise<Vendor1099Report> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("report.read", { supabase, orgId: resolvedOrgId, userId })
  const taxYear = year ?? new Date().getFullYear()
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2200) throw new Error("Invalid tax year")
  const start = `${taxYear}-01-01T00:00:00.000Z`
  const end = `${taxYear + 1}-01-01T00:00:00.000Z`
  const service = createServiceSupabaseClient()
  const { data: policies, error: policyError } = await service
    .from("tax_policy_versions")
    .select("org_id, threshold_cents, source_url")
    .eq("tax_year", taxYear)
    .eq("form_type", "1099-NEC")
    .eq("jurisdiction", "US")
    .or(`org_id.eq.${resolvedOrgId},org_id.is.null`)
  if (policyError) throw new Error(`Failed to load 1099 policy: ${policyError.message}`)
  const policy = (policies ?? []).sort((left, right) => Number(Boolean(right.org_id)) - Number(Boolean(left.org_id)))[0]
  if (!policy) throw new Error(`No approved 1099-NEC policy exists for tax year ${taxYear}`)
  const thresholdCents = Number(policy.threshold_cents)

  const [companiesResult, allocationsResult, billsResult, expensesResult] = await Promise.all([
    supabase.from("companies").select("id, name, tax_id_last4, tax_entity_type, is_1099_eligible, w9_file_id, w9_received_at, tin_verification_status, backup_withholding, tax_exempt").eq("org_id", resolvedOrgId).eq("is_1099_eligible", true),
    supabase.from("payment_allocations").select("amount_cents, bill_id, payment:payments!inner(received_at, status, method), bill:vendor_bills!inner(company_id)").eq("org_id", resolvedOrgId).not("bill_id", "is", null).gte("payment.received_at", start).lt("payment.received_at", end).in("payment.status", ["succeeded", "completed", "paid"]),
    supabase.from("vendor_bills").select("id, company_id, paid_cents, paid_at, status").eq("org_id", resolvedOrgId).not("company_id", "is", null).gte("paid_at", start).lt("paid_at", end),
    supabase.from("project_expenses").select("vendor_company_id, amount_cents, tax_cents, expense_date, status, payment_method, qbo_transaction_type").eq("org_id", resolvedOrgId).not("vendor_company_id", "is", null).gte("expense_date", `${taxYear}-01-01`).lte("expense_date", `${taxYear}-12-31`).in("status", ["approved", "locked"]),
  ])
  const firstError = companiesResult.error || allocationsResult.error || billsResult.error || expensesResult.error
  if (firstError) throw new Error(`Failed to build 1099 report: ${firstError.message}`)

  const candidateBillIds = (billsResult.data ?? []).map((bill) => bill.id)
  const { data: anyYearAllocations, error: allocationLookupError } = candidateBillIds.length > 0
    ? await supabase.from("payment_allocations").select("bill_id").eq("org_id", resolvedOrgId).in("bill_id", candidateBillIds)
    : { data: [], error: null }
  if (allocationLookupError) throw new Error(`Failed to build 1099 report: ${allocationLookupError.message}`)

  const paidByCompany = new Map<string, number>()
  const allocatedBillIds = new Set<string>()
  for (const allocation of allocationsResult.data ?? []) {
    const bill = Array.isArray(allocation.bill) ? allocation.bill[0] : allocation.bill
    const payment = Array.isArray(allocation.payment) ? allocation.payment[0] : allocation.payment
    if (!bill?.company_id) continue
    if (payment?.method && new Set(["credit_card", "company_card", "card"]).has(payment.method)) continue
    allocatedBillIds.add(allocation.bill_id as string)
    paidByCompany.set(bill.company_id, (paidByCompany.get(bill.company_id) ?? 0) + Number(allocation.amount_cents ?? 0))
  }
  for (const allocation of anyYearAllocations ?? []) if (allocation.bill_id) allocatedBillIds.add(allocation.bill_id)
  for (const bill of billsResult.data ?? []) {
    if (!bill.company_id || allocatedBillIds.has(bill.id)) continue
    paidByCompany.set(bill.company_id, (paidByCompany.get(bill.company_id) ?? 0) + Number(bill.paid_cents ?? 0))
  }
  for (const expense of expensesResult.data ?? []) {
    if (!expense.vendor_company_id) continue
    // Direct-paid expenses are cash-basis. AP/bill transactions belong in the
    // payment-allocation stream and must not leak into 1099 totals on approval.
    if (!expense.payment_method || expense.qbo_transaction_type === "bill") continue
    if (new Set(["credit_card", "company_card", "card"]).has(expense.payment_method)) continue
    paidByCompany.set(expense.vendor_company_id, (paidByCompany.get(expense.vendor_company_id) ?? 0) + Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0))
  }

  // A returned payment was not income to the vendor, and reporting it overstates
  // what they received on a form the IRS also receives. `payment_reversals`
  // carries the bill directly, so the vendor is resolved the same way the
  // payment was.
  const { data: reversals, error: reversalError } = await supabase
    .from("payment_reversals")
    .select("amount_cents, bill_id, created_at, status")
    .eq("org_id", resolvedOrgId)
    .not("bill_id", "is", null)
    .in("status", ["pending", "succeeded"])
    .gte("created_at", start)
    .lt("created_at", end)
  if (reversalError) throw new Error(`Failed to build 1099 report: ${reversalError.message}`)

  const reversedBillIds = [...new Set((reversals ?? []).map((row) => row.bill_id as string))]
  const companyByBill = new Map<string, string>()
  for (let index = 0; index < reversedBillIds.length; index += 500) {
    const { data } = await supabase
      .from("vendor_bills")
      .select("id, company_id")
      .eq("org_id", resolvedOrgId)
      .in("id", reversedBillIds.slice(index, index + 500))
    for (const bill of data ?? []) if (bill.company_id) companyByBill.set(bill.id, bill.company_id)
  }
  const reversedByCompany = new Map<string, number>()
  for (const reversal of reversals ?? []) {
    const companyId = reversal.bill_id ? companyByBill.get(reversal.bill_id as string) : null
    if (!companyId) continue
    reversedByCompany.set(companyId, (reversedByCompany.get(companyId) ?? 0) + Number(reversal.amount_cents ?? 0))
  }

  const rows = (companiesResult.data ?? [])
    .filter((company) => company.tax_exempt !== true)
    .map((company) => {
      const reversedCents = reversedByCompany.get(company.id) ?? 0
      const totalPaidCents = Math.max(0, (paidByCompany.get(company.id) ?? 0) - reversedCents)
      const meetsThreshold = totalPaidCents >= thresholdCents

      const blockingReasons: string[] = []
      if (meetsThreshold) {
        if (!company.w9_file_id && !company.w9_received_at) blockingReasons.push("No W-9 on file")
        if (!company.tax_id_last4) blockingReasons.push("No taxpayer ID recorded")
        if (company.tin_verification_status === "mismatch") blockingReasons.push("TIN does not match IRS records")
        if (company.backup_withholding === true) blockingReasons.push("Backup withholding applies")
      }

      return {
        company_id: company.id,
        vendor_name: company.name,
        tax_id_last4: company.tax_id_last4 ?? null,
        tax_entity_type: company.tax_entity_type ?? null,
        w9_on_file: Boolean(company.w9_file_id || company.w9_received_at),
        total_paid_cents: totalPaidCents,
        reversed_cents: reversedCents,
        meets_threshold: meetsThreshold,
        blocked_for_filing: blockingReasons.length > 0,
        blocking_reasons: blockingReasons,
      }
    })
    .sort((a, b) => b.total_paid_cents - a.total_paid_cents || a.vendor_name.localeCompare(b.vendor_name))

  return { tax_year: taxYear, threshold_cents: thresholdCents, rows, total_paid_cents: rows.reduce((sum, row) => sum + row.total_paid_cents, 0) }
}
