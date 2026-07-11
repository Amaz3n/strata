import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

export type Vendor1099Row = {
  company_id: string
  vendor_name: string
  tax_id_last4: string | null
  tax_entity_type: string | null
  w9_on_file: boolean
  total_paid_cents: number
  meets_threshold: boolean
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
  const thresholdCents = 60_000

  const [companiesResult, allocationsResult, billsResult, expensesResult] = await Promise.all([
    supabase.from("companies").select("id, name, tax_id_last4, tax_entity_type, is_1099_eligible, w9_file_id").eq("org_id", resolvedOrgId).eq("is_1099_eligible", true),
    supabase.from("payment_allocations").select("amount_cents, bill_id, payment:payments!inner(received_at, status), bill:vendor_bills!inner(company_id)").eq("org_id", resolvedOrgId).not("bill_id", "is", null).gte("payment.received_at", start).lt("payment.received_at", end).in("payment.status", ["succeeded", "completed", "paid"]),
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
    if (!bill?.company_id) continue
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
    paidByCompany.set(expense.vendor_company_id, (paidByCompany.get(expense.vendor_company_id) ?? 0) + Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0))
  }

  const rows = (companiesResult.data ?? []).map((company) => {
    const totalPaidCents = paidByCompany.get(company.id) ?? 0
    return {
      company_id: company.id,
      vendor_name: company.name,
      tax_id_last4: company.tax_id_last4 ?? null,
      tax_entity_type: company.tax_entity_type ?? null,
      w9_on_file: Boolean(company.w9_file_id),
      total_paid_cents: totalPaidCents,
      meets_threshold: totalPaidCents >= thresholdCents,
    }
  }).sort((a, b) => b.total_paid_cents - a.total_paid_cents || a.vendor_name.localeCompare(b.vendor_name))

  return { tax_year: taxYear, threshold_cents: thresholdCents, rows, total_paid_cents: rows.reduce((sum, row) => sum + row.total_paid_cents, 0) }
}
