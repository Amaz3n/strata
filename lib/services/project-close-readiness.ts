import { isBefore, parseISO, startOfToday } from "date-fns"

import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission } from "@/lib/services/permissions"

export type CloseReadinessSeverity = "blocker" | "warning"
export type CloseReadinessCategory = "financial" | "vendors" | "schedule" | "field" | "closeout"
export type CloseReadinessState = "ready" | "warning" | "blocked"

export interface CloseReadinessIssue {
  id: string
  category: CloseReadinessCategory
  severity: CloseReadinessSeverity
  title: string
  detail: string
  href: string
  amountCents?: number
  count?: number
}

export interface CloseReadinessSection {
  key: CloseReadinessCategory
  title: string
  state: CloseReadinessState
  blockerCount: number
  warningCount: number
  amountCents: number
  issues: CloseReadinessIssue[]
}

export interface ProjectCloseReadiness {
  state: CloseReadinessState
  blockerCount: number
  warningCount: number
  blockingAmountCents: number
  warningAmountCents: number
  sections: CloseReadinessSection[]
}

const sectionTitles: Record<CloseReadinessCategory, string> = {
  financial: "Financials",
  vendors: "Vendors & commitments",
  schedule: "Schedule",
  field: "Field",
  closeout: "Closeout packet",
}

function projectHref(projectId: string, path: string) {
  return `/projects/${projectId}${path}`
}

function isPastDate(value?: string | null) {
  if (!value) return false
  return isBefore(parseISO(value), startOfToday())
}

function isMissingCloseoutOptionalColumnError(error: { message?: string } | null | undefined) {
  const message = error?.message ?? ""
  return (
    message.includes("column closeout_items.due_date does not exist") ||
    message.includes("column closeout_items.responsible_party does not exist") ||
    message.includes("column closeout_items.notes does not exist")
  )
}

function money(value?: number | null) {
  return Math.max(0, Math.round(value ?? 0))
}

function rowTitle(row: Record<string, any>, fallback: string) {
  return String(row.title ?? row.name ?? row.invoice_number ?? row.bill_number ?? row.co_number ?? fallback)
}

function sectionState(blockerCount: number, warningCount: number): CloseReadinessState {
  if (blockerCount > 0) return "blocked"
  if (warningCount > 0) return "warning"
  return "ready"
}

function buildSections(issues: CloseReadinessIssue[]): CloseReadinessSection[] {
  return (Object.keys(sectionTitles) as CloseReadinessCategory[]).map((key) => {
    const sectionIssues = issues.filter((issue) => issue.category === key)
    const blockerCount = sectionIssues.filter((issue) => issue.severity === "blocker").length
    const warningCount = sectionIssues.filter((issue) => issue.severity === "warning").length
    const amountCents = sectionIssues.reduce((sum, issue) => sum + money(issue.amountCents), 0)

    return {
      key,
      title: sectionTitles[key],
      state: sectionState(blockerCount, warningCount),
      blockerCount,
      warningCount,
      amountCents,
      issues: sectionIssues,
    }
  })
}

export async function getProjectCloseReadiness(projectId: string, orgId?: string): Promise<ProjectCloseReadiness> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["closeout.read", "closeout.write", "org.member", "org.read"], {
    supabase,
    orgId: resolvedOrgId,
    userId,
  })

  const [
    invoicesResult,
    billsResult,
    expensesResult,
    commitmentsResult,
    changeOrdersResult,
    linkedCoInvoicesResult,
    scheduleResult,
    punchResult,
    warrantyResult,
    closeoutPackageResult,
  ] = await Promise.all([
    supabase
      .from("invoices")
      .select("id, invoice_number, title, status, due_date, total_cents, balance_due_cents, qbo_sync_status")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .neq("status", "void"),
    supabase
      .from("vendor_bills")
      .select("id, commitment_id, bill_number, status, due_date, total_cents, paid_cents, lien_waiver_status, qbo_sync_status, qbo_sync_error")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId),
    supabase
      .from("project_expenses")
      .select("id, description, status, amount_cents, tax_cents, is_billable, qbo_sync_status")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId),
    supabase
      .from("commitments")
      .select("id, title, status, total_cents, executed_at, executed_file_id")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId),
    supabase
      .from("change_orders")
      .select("id, co_number, title, status, total_cents, requires_signature, client_visible, metadata")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId),
    supabase
      .from("invoices")
      .select("id, status, metadata")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .neq("status", "void")
      .not("metadata->>source_change_order_id", "is", null),
    supabase
      .from("schedule_items")
      .select("id, name, status, end_date, progress")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .not("status", "in", "(completed,cancelled)"),
    supabase
      .from("punch_items")
      .select("id, title, status, due_date, verification_required, verified_at")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .neq("status", "closed"),
    supabase
      .from("warranty_requests")
      .select("id, title, status")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .in("status", ["open", "in_progress"]),
    supabase
      .from("closeout_packages")
      .select("id, status")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .maybeSingle(),
  ])

  for (const [label, result] of [
    ["invoices", invoicesResult],
    ["vendor bills", billsResult],
    ["expenses", expensesResult],
    ["commitments", commitmentsResult],
    ["change orders", changeOrdersResult],
    ["linked change order invoices", linkedCoInvoicesResult],
    ["schedule", scheduleResult],
    ["punch", punchResult],
    ["warranty", warrantyResult],
    ["closeout package", closeoutPackageResult],
  ] as const) {
    if (result.error) throw new Error(`Failed to load project close readiness ${label}: ${result.error.message}`)
  }

  const issues: CloseReadinessIssue[] = []
  const invoices = invoicesResult.data ?? []

  for (const invoice of invoices) {
    const balance = money(invoice.balance_due_cents ?? invoice.total_cents)
    const status = String(invoice.status ?? "draft")
    const label = invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : rowTitle(invoice, "Invoice")

    if (["sent", "partial", "overdue"].includes(status) && balance > 0) {
      issues.push({
        id: `invoice-${invoice.id}`,
        category: "financial",
        severity: "blocker",
        title: isPastDate(invoice.due_date) ? `${label} is overdue` : `${label} has an open balance`,
        detail: `${status.replaceAll("_", " ")} invoice with ${balance > 0 ? "a remaining balance" : "unresolved status"}.`,
        href: projectHref(projectId, `/invoices?invoice=${invoice.id}`),
        amountCents: balance,
      })
    } else if (["draft", "saved"].includes(status) && money(invoice.total_cents) > 0) {
      issues.push({
        id: `invoice-draft-${invoice.id}`,
        category: "financial",
        severity: "warning",
        title: `${label} is not issued`,
        detail: "Draft/saved invoices should be sent, voided, or removed before close.",
        href: projectHref(projectId, `/invoices?invoice=${invoice.id}`),
        amountCents: money(invoice.total_cents),
      })
    }

    if (invoice.qbo_sync_status === "error" || invoice.qbo_sync_status === "pending") {
      issues.push({
        id: `invoice-sync-${invoice.id}`,
        category: "financial",
        severity: invoice.qbo_sync_status === "error" ? "blocker" : "warning",
        title: `${label} is not settled in QuickBooks`,
        detail: `QuickBooks sync status is ${invoice.qbo_sync_status}.`,
        href: projectHref(projectId, `/invoices?invoice=${invoice.id}`),
      })
    }
  }

  const linkedInvoiceByChangeOrderId = new Set<string>()
  for (const invoice of linkedCoInvoicesResult.data ?? []) {
    const changeOrderId = (invoice.metadata as any)?.source_change_order_id
    if (typeof changeOrderId === "string") linkedInvoiceByChangeOrderId.add(changeOrderId)
  }

  for (const changeOrder of changeOrdersResult.data ?? []) {
    const status = String(changeOrder.status ?? "draft")
    const label = changeOrder.co_number ? `CO ${changeOrder.co_number}` : rowTitle(changeOrder, "Change order")
    if (["pending", "sent", "requested_changes"].includes(status)) {
      issues.push({
        id: `co-pending-${changeOrder.id}`,
        category: "financial",
        severity: "blocker",
        title: `${label} is still awaiting resolution`,
        detail: "Pending change orders can change contract value, schedule, and final billing.",
        href: projectHref(projectId, `/change-orders?highlight=${changeOrder.id}`),
        amountCents: money(changeOrder.total_cents),
      })
    } else if (status === "draft") {
      issues.push({
        id: `co-draft-${changeOrder.id}`,
        category: "financial",
        severity: "warning",
        title: `${label} is still a draft`,
        detail: "Draft change orders should be approved, sent, or cancelled before final close.",
        href: projectHref(projectId, `/change-orders?highlight=${changeOrder.id}`),
        amountCents: money(changeOrder.total_cents),
      })
    } else if (status === "approved" && !linkedInvoiceByChangeOrderId.has(changeOrder.id)) {
      issues.push({
        id: `co-unbilled-${changeOrder.id}`,
        category: "financial",
        severity: "blocker",
        title: `${label} is approved but not linked to an invoice`,
        detail: "Approved change orders should be billed, credited, or explicitly waived before close.",
        href: projectHref(projectId, `/change-orders?highlight=${changeOrder.id}`),
        amountCents: money(changeOrder.total_cents),
      })
    }
  }

  for (const bill of billsResult.data ?? []) {
    const status = String(bill.status ?? "pending")
    const total = money(bill.total_cents)
    const paid = money(bill.paid_cents)
    const outstanding = Math.max(0, total - paid)
    const label = bill.bill_number ? `Bill ${bill.bill_number}` : "Vendor bill"

    if (status === "pending") {
      issues.push({
        id: `bill-pending-${bill.id}`,
        category: "vendors",
        severity: "blocker",
        title: `${label} is pending approval`,
        detail: "Payables should be approved, rejected, or removed before project close.",
        href: projectHref(projectId, "/financials/payables"),
        amountCents: outstanding || total,
      })
    } else if (["approved", "partial"].includes(status) && outstanding > 0) {
      issues.push({
        id: `bill-open-${bill.id}`,
        category: "vendors",
        severity: "blocker",
        title: `${label} has an unpaid balance`,
        detail: isPastDate(bill.due_date) ? "This payable is past due." : "Approved payables should be paid or intentionally carried before close.",
        href: projectHref(projectId, "/financials/payables"),
        amountCents: outstanding,
      })
    }

    if (["approved", "partial", "paid"].includes(status) && bill.lien_waiver_status && bill.lien_waiver_status !== "received") {
      issues.push({
        id: `bill-waiver-${bill.id}`,
        category: "vendors",
        severity: "blocker",
        title: `${label} is missing lien waiver clearance`,
        detail: `Lien waiver status is ${String(bill.lien_waiver_status).replaceAll("_", " ")}.`,
        href: projectHref(projectId, "/financials/payables"),
      })
    }

    if (bill.qbo_sync_status === "error" || bill.qbo_sync_status === "needs_review") {
      issues.push({
        id: `bill-sync-${bill.id}`,
        category: "vendors",
        severity: "warning",
        title: `${label} needs accounting review`,
        detail: bill.qbo_sync_error || `QuickBooks sync status is ${bill.qbo_sync_status}.`,
        href: projectHref(projectId, "/financials/payables"),
      })
    }
  }

  const billsByCommitment = new Map<string, { billed: number; paid: number }>()
  for (const bill of billsResult.data ?? []) {
    const commitmentId = (bill as any).commitment_id as string | undefined
    if (!commitmentId) continue
    const current = billsByCommitment.get(commitmentId) ?? { billed: 0, paid: 0 }
    current.billed += money(bill.total_cents)
    current.paid += money(bill.paid_cents)
    billsByCommitment.set(commitmentId, current)
  }

  for (const commitment of commitmentsResult.data ?? []) {
    const status = String(commitment.status ?? "draft")
    const total = money(commitment.total_cents)
    const rollup = billsByCommitment.get(commitment.id) ?? { billed: 0, paid: 0 }
    const remaining = Math.max(0, total - rollup.billed)

    if (!["complete", "canceled", "cancelled"].includes(status)) {
      issues.push({
        id: `commitment-open-${commitment.id}`,
        category: "vendors",
        severity: "blocker",
        title: `${rowTitle(commitment, "Commitment")} is still ${status}`,
        detail: remaining > 0 ? "The commitment still has unbilled value." : "The commitment should be marked complete or cancelled before close.",
        href: projectHref(projectId, "/commitments"),
        amountCents: remaining,
      })
    }

    if (status !== "draft" && !commitment.executed_at && !commitment.executed_file_id) {
      issues.push({
        id: `commitment-executed-${commitment.id}`,
        category: "vendors",
        severity: "warning",
        title: `${rowTitle(commitment, "Commitment")} has no executed document`,
        detail: "Attach the executed subcontract or PO before final handoff.",
        href: projectHref(projectId, "/commitments"),
      })
    }
  }

  for (const expense of expensesResult.data ?? []) {
    const status = String(expense.status ?? "draft")
    const amount = money(expense.amount_cents) + money(expense.tax_cents)
    if (["draft", "submitted"].includes(status)) {
      issues.push({
        id: `expense-open-${expense.id}`,
        category: "financial",
        severity: status === "submitted" ? "blocker" : "warning",
        title: expense.description || "Expense is not finalized",
        detail: `Expense status is ${status}.`,
        href: projectHref(projectId, `/expenses?expense=${expense.id}`),
        amountCents: amount,
      })
    } else if (status === "approved" && ["error", "needs_review", "pending"].includes(String(expense.qbo_sync_status ?? ""))) {
      issues.push({
        id: `expense-sync-${expense.id}`,
        category: "financial",
        severity: expense.qbo_sync_status === "error" ? "blocker" : "warning",
        title: expense.description || "Approved expense needs accounting review",
        detail: `QuickBooks sync status is ${expense.qbo_sync_status}.`,
        href: projectHref(projectId, `/expenses?expense=${expense.id}`),
        amountCents: amount,
      })
    }
  }

  for (const item of scheduleResult.data ?? []) {
    const status = String(item.status ?? "planned")
    const severity: CloseReadinessSeverity = status === "blocked" || status === "at_risk" || isPastDate(item.end_date) ? "blocker" : "warning"
    issues.push({
      id: `schedule-${item.id}`,
      category: "schedule",
      severity,
      title: rowTitle(item, "Schedule item"),
      detail: isPastDate(item.end_date) ? "Schedule item is overdue and not completed." : `Schedule status is ${status.replaceAll("_", " ")}.`,
      href: projectHref(projectId, `/schedule?highlight=${item.id}`),
    })
  }

  for (const item of punchResult.data ?? []) {
    const status = String(item.status ?? "open")
    issues.push({
      id: `punch-${item.id}`,
      category: "field",
      severity: "blocker",
      title: rowTitle(item, "Punch item"),
      detail:
        item.verification_required && !item.verified_at
          ? "Verification evidence is required before this punch item can close."
          : isPastDate(item.due_date)
            ? "Punch item is overdue."
            : `Punch status is ${status.replaceAll("_", " ")}.`,
      href: projectHref(projectId, `/punch?highlight=${item.id}`),
    })
  }

  for (const request of warrantyResult.data ?? []) {
    issues.push({
      id: `warranty-${request.id}`,
      category: "field",
      severity: "warning",
      title: rowTitle(request, "Warranty request"),
      detail: `Warranty request is ${String(request.status ?? "open").replaceAll("_", " ")}.`,
      href: projectHref(projectId, "/warranty"),
    })
  }

  const pkg = closeoutPackageResult.data
  if (!pkg) {
    issues.push({
      id: "closeout-package-missing",
      category: "closeout",
      severity: "warning",
      title: "Closeout package has not been initialized",
      detail: "Open the checklist or initialize closeout requirements before final handoff.",
      href: projectHref(projectId, "/closeout"),
    })
  } else {
    let { data: closeoutItems, error } = await supabase
      .from("closeout_items")
      .select("id, title, status, due_date")
      .eq("org_id", resolvedOrgId)
      .eq("closeout_package_id", pkg.id)

    if (error && isMissingCloseoutOptionalColumnError(error)) {
      const fallback = await supabase
        .from("closeout_items")
        .select("id, title, status")
        .eq("org_id", resolvedOrgId)
        .eq("closeout_package_id", pkg.id)

      closeoutItems = fallback.data?.map((item) => ({ ...item, due_date: null })) ?? null
      error = fallback.error
    }

    if (error) throw new Error(`Failed to load project close readiness closeout items: ${error.message}`)

    for (const item of closeoutItems ?? []) {
      const status = String(item.status ?? "missing")
      if (status === "complete") continue
      issues.push({
        id: `closeout-${item.id}`,
        category: "closeout",
        severity: status === "missing" || isPastDate(item.due_date) ? "blocker" : "warning",
        title: rowTitle(item, "Closeout requirement"),
        detail: isPastDate(item.due_date) ? "Closeout requirement is overdue." : `Requirement is ${status.replaceAll("_", " ")}.`,
        href: projectHref(projectId, "/closeout"),
      })
    }
  }

  const sections = buildSections(issues)
  const blockerIssues = issues.filter((issue) => issue.severity === "blocker")
  const warningIssues = issues.filter((issue) => issue.severity === "warning")

  return {
    state: sectionState(blockerIssues.length, warningIssues.length),
    blockerCount: blockerIssues.length,
    warningCount: warningIssues.length,
    blockingAmountCents: blockerIssues.reduce((sum, issue) => sum + money(issue.amountCents), 0),
    warningAmountCents: warningIssues.reduce((sum, issue) => sum + money(issue.amountCents), 0),
    sections,
  }
}
