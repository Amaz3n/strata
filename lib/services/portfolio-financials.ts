import { differenceInCalendarDays, parseISO } from "date-fns"

import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { getComplianceRules } from "@/lib/services/compliance"
import { getCompaniesComplianceStatus } from "@/lib/services/compliance-documents"
import type { ComplianceStatusSummary } from "@/lib/types"
import type { AgingBucket, PortfolioFinancialControlData, PortfolioFinancialRow } from "@/lib/financials/portfolio-control"

function emptyAging(): Record<AgingBucket, number> {
  return {
    current: 0,
    "1_30": 0,
    "31_60": 0,
    "61_90": 0,
    "90_plus": 0,
  }
}

function getTodayUtcDate() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function getAgeDays(dueDate?: string | null) {
  if (!dueDate) return 0
  return Math.max(0, differenceInCalendarDays(getTodayUtcDate(), parseISO(dueDate)))
}

function getDaysUntil(dueDate?: string | null) {
  if (!dueDate) return null
  return differenceInCalendarDays(parseISO(dueDate), getTodayUtcDate())
}

function getAgingBucket(dueDate?: string | null): AgingBucket {
  const ageDays = getAgeDays(dueDate)
  if (ageDays <= 0) return "current"
  if (ageDays <= 30) return "1_30"
  if (ageDays <= 60) return "31_60"
  if (ageDays <= 90) return "61_90"
  return "90_plus"
}

function addToAging(aging: Record<AgingBucket, number>, row: PortfolioFinancialRow) {
  const bucket = row.aging_bucket ?? "current"
  aging[bucket] += row.amount_cents
}

function projectFinancialHref(projectId?: string | null, section = "") {
  if (!projectId) return "/projects"
  return `/projects/${projectId}/financials${section}`
}

export async function getPortfolioFinancialControlData(): Promise<PortfolioFinancialControlData> {
  const { supabase, orgId, userId } = await requireOrgContext()

  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId,
    supabase,
    logDecision: true,
    resourceType: "org",
    resourceId: orgId,
  })

  const [invoicesResult, vendorBillsResult, readyCostsResult, qboRecordsResult, complianceRules] = await Promise.all([
    supabase
      .from("invoices")
      .select(
        "id, project_id, invoice_number, title, status, due_date, total_cents, balance_due_cents, qbo_sync_status, metadata, project:projects(id, name)",
      )
      .eq("org_id", orgId)
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("vendor_bills")
      .select(
        "id, project_id, commitment_id, bill_number, status, due_date, total_cents, paid_cents, lien_waiver_status, metadata, project:projects(id, name), commitment:commitments(id, title, company_id, company:companies(id, name))",
      )
      .eq("org_id", orgId)
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("billable_costs")
      .select("id, project_id, cost_code_id, status, occurred_on, description, billable_cents, cost_cents, markup_cents, metadata, project:projects(id, name)")
      .eq("org_id", orgId)
      .eq("status", "open")
      .eq("is_billable", true)
      .order("occurred_on", { ascending: true }),
    supabase
      .from("qbo_sync_records")
      .select("id, entity_type, entity_id, status, error_message, created_at, metadata")
      .eq("org_id", orgId)
      .in("status", ["error", "failed", "pending"])
      .order("created_at", { ascending: false })
      .limit(50),
    getComplianceRules(orgId).catch(() => ({
      require_lien_waiver: false,
      block_payment_on_missing_docs: true,
    })),
  ])

  if (invoicesResult.error) throw new Error(`Failed to load AR: ${invoicesResult.error.message}`)
  if (vendorBillsResult.error) throw new Error(`Failed to load AP: ${vendorBillsResult.error.message}`)
  if (readyCostsResult.error) throw new Error(`Failed to load ready-to-invoice costs: ${readyCostsResult.error.message}`)
  if (qboRecordsResult.error) throw new Error(`Failed to load QBO exceptions: ${qboRecordsResult.error.message}`)

  const vendorBills = vendorBillsResult.data ?? []
  const companyIds = Array.from(
    new Set(
      vendorBills
        .map((bill: any) => bill.commitment?.company_id ?? bill.commitment?.company?.id)
        .filter(Boolean),
    ),
  ) as string[]
  const complianceByCompanyId: Record<string, ComplianceStatusSummary> = await getCompaniesComplianceStatus(companyIds).catch(
    () => ({}),
  )

  const arAging = emptyAging()
  const apAging = emptyAging()

  const arRows = (invoicesResult.data ?? [])
    .map((invoice: any): PortfolioFinancialRow | null => {
      const balanceDue = invoice.balance_due_cents ?? invoice.total_cents ?? 0
      if (balanceDue <= 0 || ["paid", "void"].includes(invoice.status)) return null
      const agingBucket = getAgingBucket(invoice.due_date)
      return {
        id: invoice.id,
        kind: "ar",
        project_id: invoice.project_id,
        project_name: invoice.project?.name ?? null,
        counterparty: invoice.metadata?.customer_name ?? "Client",
        reference: invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : invoice.title ?? "Invoice",
        status: invoice.status ?? "sent",
        amount_cents: balanceDue,
        due_date: invoice.due_date,
        age_days: getAgeDays(invoice.due_date),
        aging_bucket: agingBucket,
        href: projectFinancialHref(invoice.project_id, `/receivables?invoice=${invoice.id}`),
      }
    })
    .filter(Boolean) as PortfolioFinancialRow[]

  for (const row of arRows) addToAging(arAging, row)

  const apRows = vendorBills
    .map((bill: any): PortfolioFinancialRow | null => {
      const balanceDue = Math.max(0, (bill.total_cents ?? 0) - (bill.paid_cents ?? 0))
      if (balanceDue <= 0 || bill.status === "paid") return null
      const agingBucket = getAgingBucket(bill.due_date)
      return {
        id: bill.id,
        kind: "ap",
        project_id: bill.project_id,
        project_name: bill.project?.name ?? null,
        counterparty: bill.commitment?.company?.name ?? "Vendor",
        reference: bill.bill_number ? `Bill ${bill.bill_number}` : "Vendor bill",
        status: bill.status ?? "pending",
        amount_cents: balanceDue,
        due_date: bill.due_date,
        age_days: getAgeDays(bill.due_date),
        aging_bucket: agingBucket,
        href: projectFinancialHref(bill.project_id, "/payables"),
      }
    })
    .filter(Boolean) as PortfolioFinancialRow[]

  for (const row of apRows) addToAging(apAging, row)

  const readyByProject = new Map<string, PortfolioFinancialRow>()
  for (const cost of readyCostsResult.data ?? []) {
    const projectId = (cost as any).project_id as string
    const existing = readyByProject.get(projectId)
    const amount = (cost as any).billable_cents ?? 0
    if (existing) {
      existing.amount_cents += amount
      existing.reference = `${Number(existing.reason ?? 0) + 1} approved costs`
      existing.reason = String(Number(existing.reason ?? 0) + 1)
      continue
    }
    readyByProject.set(projectId, {
      id: projectId,
      kind: "ready_to_invoice",
      project_id: projectId,
      project_name: (cost as any).project?.name ?? null,
      reference: "1 approved cost",
      status: "ready",
      amount_cents: amount,
      due_date: null,
      age_days: getAgeDays((cost as any).occurred_on),
      reason: "1",
      href: projectFinancialHref(projectId),
    })
  }
  const readyToInvoiceRows = Array.from(readyByProject.values()).map((row) => ({ ...row, reason: null }))

  const blockedRows: PortfolioFinancialRow[] = []

  for (const bill of vendorBills as any[]) {
    const balanceDue = Math.max(0, (bill.total_cents ?? 0) - (bill.paid_cents ?? 0))
    if (balanceDue <= 0 || bill.status === "paid") continue

    const companyId = bill.commitment?.company_id ?? bill.commitment?.company?.id
    const complianceStatus = companyId ? complianceByCompanyId[companyId] : null
    const reasons: string[] = []

    if (complianceRules.block_payment_on_missing_docs && complianceStatus && !complianceStatus.is_compliant) {
      reasons.push("Compliance documents")
    }
    if (
      complianceRules.block_payment_on_missing_docs &&
      complianceRules.require_lien_waiver &&
      bill.lien_waiver_status !== "received"
    ) {
      reasons.push("Lien waiver")
    }

    if (reasons.length > 0) {
      blockedRows.push({
        id: `payable-${bill.id}`,
        kind: "blocked",
        project_id: bill.project_id,
        project_name: bill.project?.name ?? null,
        counterparty: bill.commitment?.company?.name ?? "Vendor",
        reference: bill.bill_number ? `Bill ${bill.bill_number}` : "Vendor bill",
        status: bill.status ?? "pending",
        amount_cents: balanceDue,
        due_date: bill.due_date,
        age_days: getAgeDays(bill.due_date),
        aging_bucket: getAgingBucket(bill.due_date),
        reason: reasons.join(" + "),
        href: projectFinancialHref(bill.project_id, "/payables"),
      })
    }
  }

  for (const cost of readyCostsResult.data ?? []) {
    if ((cost as any).cost_code_id) continue
    blockedRows.push({
      id: `cost-${(cost as any).id}`,
      kind: "blocked",
      project_id: (cost as any).project_id,
      project_name: (cost as any).project?.name ?? null,
      reference: (cost as any).description ?? "Billable cost",
      status: "needs coding",
      amount_cents: (cost as any).billable_cents ?? 0,
      due_date: null,
      age_days: getAgeDays((cost as any).occurred_on),
      reason: "Missing cost code",
      href: projectFinancialHref((cost as any).project_id),
    })
  }

  const invoiceQboRows = (invoicesResult.data ?? [])
    .filter((invoice: any) => ["error", "pending"].includes(invoice.qbo_sync_status))
    .map((invoice: any): PortfolioFinancialRow => ({
      id: `invoice-${invoice.id}`,
      kind: "qbo",
      project_id: invoice.project_id,
      project_name: invoice.project?.name ?? null,
      counterparty: invoice.metadata?.customer_name ?? "Client",
      reference: invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : invoice.title ?? "Invoice",
      status: invoice.qbo_sync_status,
      amount_cents: invoice.balance_due_cents ?? invoice.total_cents ?? 0,
      due_date: invoice.due_date,
      age_days: null,
      reason: invoice.qbo_sync_status === "error" ? "Invoice sync failed" : "Invoice sync pending",
      href: projectFinancialHref(invoice.project_id, `/receivables?invoice=${invoice.id}`),
    }))

  const qboRecordRows = (qboRecordsResult.data ?? []).map((record: any): PortfolioFinancialRow => ({
    id: `qbo-record-${record.id}`,
    kind: "qbo",
    reference: `${record.entity_type ?? "QBO"} ${record.entity_id ?? ""}`.trim(),
    status: record.status ?? "error",
    amount_cents: 0,
    due_date: null,
    age_days: null,
    reason: record.error_message ?? "QBO sync attention required",
    href: "/settings?tab=integrations",
  }))

  const qboRows = [...invoiceQboRows, ...qboRecordRows]

  const arOpen = arRows.reduce((sum, row) => sum + row.amount_cents, 0)
  const apOpen = apRows.reduce((sum, row) => sum + row.amount_cents, 0)
  const arDue30 = arRows.reduce((sum, row) => {
    const daysUntil = getDaysUntil(row.due_date)
    return daysUntil != null && daysUntil <= 30 ? sum + row.amount_cents : sum
  }, 0)
  const apDue30 = apRows.reduce((sum, row) => {
    const daysUntil = getDaysUntil(row.due_date)
    return daysUntil != null && daysUntil <= 30 ? sum + row.amount_cents : sum
  }, 0)

  return {
    summary: {
      ar_open_cents: arOpen,
      ar_overdue_cents: arRows.reduce((sum, row) => (row.age_days && row.age_days > 0 ? sum + row.amount_cents : sum), 0),
      ap_open_cents: apOpen,
      ap_due_soon_cents: apDue30,
      ready_to_invoice_cents: readyToInvoiceRows.reduce((sum, row) => sum + row.amount_cents, 0),
      blocked_payment_cents: blockedRows.reduce((sum, row) => sum + row.amount_cents, 0),
      qbo_exception_count: qboRows.length,
      cash_flow_30_day_cents: arDue30 - apDue30,
    },
    arRows,
    apRows,
    readyToInvoiceRows,
    blockedRows,
    qboRows,
    aging: {
      ar: arAging,
      ap: apAging,
    },
  }
}
