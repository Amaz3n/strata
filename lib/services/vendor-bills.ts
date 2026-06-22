import type { SupabaseClient } from "@supabase/supabase-js"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireAuthorization } from "@/lib/services/authorization"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import {
  vendorBillStatusUpdateSchema,
  vendorBillCreateSchema,
  type VendorBillStatusUpdate,
  type VendorBillCreate,
} from "@/lib/validation/vendor-bills"
import { getComplianceRules } from "@/lib/services/compliance"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { propagateApprovalToLedger, voidBillableCostsForVendorBill } from "@/lib/services/cost-plus"
import { voidJobCostEntriesForVendorBill } from "@/lib/services/job-cost-actuals"
import { enqueueBillPaymentSync, enqueueVendorBillSync } from "@/lib/services/qbo-sync"

export type VendorBillStatus = "pending" | "approved" | "partial" | "paid"
export type PayableKind = "bill" | "vendor_credit"

export interface VendorBillPaymentSummary {
  id: string
  amount_cents: number
  method?: string
  reference?: string
  received_at?: string
  provider?: string
  status?: string
  qbo_id?: string
  vendor_credit_applied?: boolean
}

export interface VendorBillSummary {
  id: string
  org_id: string
  project_id: string
  project_name?: string
  commitment_id?: string
  commitment_title?: string
  commitment_total_cents?: number
  company_id?: string
  company_name?: string
  bill_number?: string
  status: VendorBillStatus | string
  bill_date?: string
  due_date?: string
  total_cents?: number
  currency: string
  submitted_by_contact_id?: string
  file_id?: string
  created_at: string
  updated_at?: string
  payment_reference?: string
  payment_method?: string
  paid_at?: string
  approved_at?: string
  approved_by?: string
  paid_cents?: number
  retainage_percent?: number
  retainage_cents?: number
  lien_waiver_status?: string
  lien_waiver_received_at?: string
  over_budget?: boolean
  actual_cost_code_id?: string
  actual_cost_code_code?: string
  actual_cost_code_name?: string
  qbo_id?: string
  qbo_synced_at?: string
  qbo_sync_status?: string
  qbo_sync_error?: string
  qbo_expense_account_id?: string
  qbo_expense_account_name?: string
  qbo_ap_account_id?: string
  qbo_ap_account_name?: string
  qbo_vendor_id?: string
  qbo_vendor_name?: string
  company_qbo_vendor_id?: string | null
  company_qbo_vendor_name?: string | null
  actual_lines?: VendorBillActualLine[]
  /** This bill's portion attributed to the viewing project (multi-project bills). Defaults to total_cents. */
  project_amount_cents?: number
  /** True when the bill's lines span more than one project. */
  is_shared?: boolean
  /** Every project this bill touches (incl. the viewing one), with that project's share. */
  shared_projects?: VendorBillProjectShare[]
  payable_type: PayableKind
  qbo_pushable: boolean
  /** True when this payable originated from a QuickBooks import (QBO owns the record). */
  imported_from_qbo: boolean
  payments: VendorBillPaymentSummary[]
}

export interface VendorBillProjectShare {
  id: string
  name?: string
  amount_cents: number
}

export interface VendorBillActualLine {
  id?: string
  cost_code_id: string | null
  budget_line_id?: string | null
  cost_code_code?: string
  cost_code_name?: string
  description?: string
  amount_cents: number
  project_id?: string | null
  project_name?: string
  billable_to_customer: boolean
  qbo_expense_account_id?: string
  qbo_expense_account_name?: string
  qbo_ap_account_id?: string
  qbo_ap_account_name?: string
  qbo_vendor_id?: string
  qbo_vendor_name?: string
}

function linesHaveQboExpenseCoding(lines: Array<{ qbo_expense_account_id?: string | null }>) {
  return lines.length > 0 && lines.every((line) => Boolean(line.qbo_expense_account_id))
}

// Returns the single value shared by every line, or undefined when the lines disagree
// (or none have a value). Used to surface per-line QBO coding as a bill-level chip.
function pickSharedLineValue(values: Array<string | null | undefined>): string | undefined {
  const distinct = new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))
  return distinct.size === 1 ? [...distinct][0] : undefined
}

async function buildBillLinesFromCommitment({
  supabase,
  orgId,
  commitmentId,
  billAmountCents,
  projectId,
  fallbackDescription,
}: {
  supabase: SupabaseClient
  orgId: string
  commitmentId: string
  billAmountCents: number
  projectId: string | null
  fallbackDescription: string
}) {
  const { data: lines, error } = await supabase
    .from("commitment_lines")
    .select("cost_code_id, budget_line_id, description, quantity, unit_cost_cents, scheduled_value_cents, sort_order")
    .eq("org_id", orgId)
    .eq("commitment_id", commitmentId)
    .order("sort_order", { ascending: true })

  if (error) {
    throw new Error(`Failed to inherit commitment coding: ${error.message}`)
  }

  const commitmentLines = lines ?? []
  if (commitmentLines.length === 0) return null

  const basis = commitmentLines.map((line) => {
    const scheduled = Number(line.scheduled_value_cents ?? 0)
    const lineTotal = Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1))
    return Math.max(0, scheduled || lineTotal)
  })
  const basisTotal = basis.reduce((sum, amount) => sum + amount, 0)
  if (basisTotal <= 0) return null

  let allocated = 0
  return commitmentLines.map((line, index) => {
    const amountCents =
      index === commitmentLines.length - 1
        ? billAmountCents - allocated
        : Math.round((basis[index] / basisTotal) * billAmountCents)
    allocated += amountCents
    return {
      cost_code_id: line.cost_code_id ?? null,
      budget_line_id: line.budget_line_id ?? null,
      description: line.description?.trim() || fallbackDescription,
      amount_cents: amountCents,
      project_id: projectId,
      billable_to_customer: false,
      qbo_expense_account_id: undefined,
      qbo_expense_account_name: undefined,
      qbo_ap_account_id: undefined,
      qbo_ap_account_name: undefined,
      qbo_vendor_id: undefined,
      qbo_vendor_name: undefined,
    }
  })
}

export function mapVendorBill(row: any, billLines?: any[], viewProjectId?: string, paymentRows?: any[]): VendorBillSummary {
  const metadata = row?.metadata ?? {}
  const payableType: PayableKind = metadata.source === "vendor_credit" ? "vendor_credit" : "bill"
  const company = row?.company ?? row?.commitment?.company ?? {}
  const lines = Array.isArray(billLines) ? billLines : []
  const actualLines = lines.map((line) => ({
    id: line.id ?? undefined,
    cost_code_id: line.cost_code_id,
    budget_line_id: line.budget_line_id ?? null,
    cost_code_code: line.cost_code?.code ?? undefined,
    cost_code_name: line.cost_code?.name ?? undefined,
    description: line.description ?? undefined,
    amount_cents: (line.unit_cost_cents ?? 0) * (line.quantity ?? 1),
    project_id: line.project_id ?? null,
    project_name: line.project?.name ?? undefined,
    billable_to_customer: line.metadata?.billable_to_customer === true,
    qbo_expense_account_id: line.metadata?.qbo_expense_account_id ?? undefined,
    qbo_expense_account_name: line.metadata?.qbo_expense_account_name ?? undefined,
    qbo_ap_account_id: line.metadata?.qbo_ap_account_id ?? undefined,
    qbo_ap_account_name: line.metadata?.qbo_ap_account_name ?? undefined,
    qbo_vendor_id: line.metadata?.qbo_vendor_id ?? undefined,
    qbo_vendor_name: line.metadata?.qbo_vendor_name ?? undefined,
  }))
  const firstActualLine = actualLines[0]

  // For split bills the QBO coding lives on the lines, not the bill (the bill-level
  // qbo_*_account_id columns stay null). When the bill is being shown for a specific
  // project, derive the displayed account chips from that project's line(s) so the list
  // reflects the coding the user actually set and synced — instead of "Choose account".
  const viewLines = viewProjectId
    ? actualLines.filter((line) => (line.project_id ?? row.project_id) === viewProjectId)
    : actualLines
  const lineExpenseAccountId = pickSharedLineValue(viewLines.map((line) => line.qbo_expense_account_id))
  const lineExpenseAccountName = pickSharedLineValue(viewLines.map((line) => line.qbo_expense_account_name))
  const lineApAccountId = pickSharedLineValue(viewLines.map((line) => line.qbo_ap_account_id))
  const lineApAccountName = pickSharedLineValue(viewLines.map((line) => line.qbo_ap_account_name))

  // Group the bill's value by the project each line is allocated to (a line's
  // effective project is its own project_id, falling back to the bill's primary).
  // With no coded lines the whole bill belongs to the primary project.
  const shareByProject = new Map<string, { amount_cents: number; name?: string }>()
  if (actualLines.length > 0) {
    for (const line of actualLines) {
      const pid = line.project_id ?? row.project_id
      if (!pid) continue
      const existing = shareByProject.get(pid) ?? { amount_cents: 0, name: undefined }
      existing.amount_cents += line.amount_cents
      if (!existing.name) existing.name = line.project_id ? line.project_name : row.project?.name ?? undefined
      shareByProject.set(pid, existing)
    }
  } else if (row.project_id) {
    shareByProject.set(row.project_id, { amount_cents: row.total_cents ?? 0, name: row.project?.name ?? undefined })
  }
  const sharedProjects: VendorBillProjectShare[] = Array.from(shareByProject.entries()).map(([id, share]) => ({
    id,
    name: share.name,
    amount_cents: share.amount_cents,
  }))
  const isShared = sharedProjects.length > 1
  const viewProjectShare = viewProjectId ? shareByProject.get(viewProjectId)?.amount_cents : undefined
  const projectAmountCents = viewProjectShare ?? row.total_cents ?? undefined
  const paidCents =
    typeof row.paid_cents === "number"
      ? row.paid_cents
      : row.status === "paid"
        ? row.total_cents ?? 0
        : 0
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    project_name: row.project?.name ?? undefined,
    commitment_id: row.commitment_id ?? undefined,
    commitment_title: row.commitment?.title ?? undefined,
    commitment_total_cents: row.commitment?.total_cents ?? undefined,
    company_id: company.id ?? row.company_id ?? undefined,
    company_name: company.name ?? row.company?.name ?? undefined,
    bill_number: row.bill_number ?? undefined,
    status: row.status ?? "pending",
    bill_date: row.bill_date ?? undefined,
    due_date: row.due_date ?? undefined,
    total_cents: row.total_cents ?? undefined,
    currency: row.currency ?? "usd",
    submitted_by_contact_id: row.submitted_by_contact_id ?? undefined,
    file_id: row.file_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at ?? undefined,
    payment_reference: row.payment_reference ?? metadata.payment_reference ?? undefined,
    payment_method: row.payment_method ?? metadata.payment_method ?? undefined,
    paid_at: row.paid_at ?? metadata.paid_at ?? undefined,
    approved_at: row.approved_at ?? metadata.approved_at ?? undefined,
    approved_by: row.approved_by ?? metadata.approved_by ?? undefined,
    paid_cents: paidCents,
    retainage_percent: row.retainage_percent ?? undefined,
    retainage_cents: row.retainage_cents ?? undefined,
    lien_waiver_status: row.lien_waiver_status ?? undefined,
    lien_waiver_received_at: row.lien_waiver_received_at ?? undefined,
    over_budget: typeof metadata.over_budget === "boolean" ? metadata.over_budget : undefined,
    actual_cost_code_id: firstActualLine?.cost_code_id ?? undefined,
    actual_cost_code_code: firstActualLine?.cost_code_code ?? undefined,
    actual_cost_code_name: firstActualLine?.cost_code_name ?? undefined,
    qbo_id: row.qbo_id ?? undefined,
    qbo_synced_at: row.qbo_synced_at ?? undefined,
    qbo_sync_status: row.qbo_sync_status ?? undefined,
    qbo_sync_error: row.qbo_sync_error ?? undefined,
    qbo_expense_account_id: row.qbo_expense_account_id ?? metadata.qbo_expense_account_id ?? lineExpenseAccountId ?? undefined,
    qbo_expense_account_name: row.qbo_expense_account_name ?? metadata.qbo_expense_account_name ?? lineExpenseAccountName ?? undefined,
    qbo_ap_account_id: row.qbo_ap_account_id ?? metadata.qbo_ap_account_id ?? lineApAccountId ?? undefined,
    qbo_ap_account_name: row.qbo_ap_account_name ?? metadata.qbo_ap_account_name ?? lineApAccountName ?? undefined,
    qbo_vendor_id: company.qbo_vendor_id ?? row.qbo_vendor_id ?? metadata.qbo_vendor_id ?? undefined,
    qbo_vendor_name: company.qbo_vendor_name ?? row.qbo_vendor_name ?? metadata.qbo_vendor_name ?? undefined,
    company_qbo_vendor_id: company.qbo_vendor_id ?? undefined,
    company_qbo_vendor_name: company.qbo_vendor_name ?? undefined,
    actual_lines: actualLines,
    project_amount_cents: projectAmountCents,
    is_shared: isShared,
    shared_projects: sharedProjects,
    payable_type: payableType,
    qbo_pushable: payableType === "bill",
    imported_from_qbo: metadata.imported_from_qbo === true,
    payments: (paymentRows ?? []).map((payment) => {
      const paymentMetadata = (payment.metadata as Record<string, any> | null) ?? {}
      return {
        id: payment.id,
        amount_cents: Number(payment.amount_cents ?? 0),
        method: payment.method ?? undefined,
        reference: payment.reference ?? undefined,
        received_at: payment.received_at ?? undefined,
        provider: payment.provider ?? undefined,
        status: payment.status ?? undefined,
        qbo_id: typeof paymentMetadata.qbo_id === "string" ? paymentMetadata.qbo_id : undefined,
        vendor_credit_applied: paymentMetadata.vendor_credit_applied === true,
      }
    }),
  }
}

async function replaceBillLineCoding(
  supabase: SupabaseClient,
  {
    orgId,
    billId,
    lines,
  }: {
    orgId: string
    billId: string
    lines: Array<{
      cost_code_id: string | null
      budget_line_id?: string | null
      description: string
      amount_cents: number
      project_id?: string | null
      billable_to_customer?: boolean
      qbo_expense_account_id?: string
      qbo_expense_account_name?: string
      qbo_ap_account_id?: string
      qbo_ap_account_name?: string
      qbo_vendor_id?: string
      qbo_vendor_name?: string
    }>
  },
) {
  if (lines.length === 0) return

  const projectIds = Array.from(
    new Set(lines.map((line) => line.project_id).filter((id): id is string => typeof id === "string" && id.length > 0)),
  )
  const { data: projectSettings, error: projectSettingsError } =
    projectIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("project_financial_settings")
          .select("project_id, billing_model")
          .eq("org_id", orgId)
          .in("project_id", projectIds)

  if (projectSettingsError) {
    throw new Error(`Failed to load project billing settings: ${projectSettingsError.message}`)
  }
  const billingModelByProject = new Map(
    (projectSettings ?? []).map((settings) => [settings.project_id, settings.billing_model]),
  )

  const costCodeIds = Array.from(new Set(lines.map((line) => line.cost_code_id))).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  )

  if (costCodeIds.length > 0) {
    const { data: costCodes, error: costCodeError } = await supabase
      .from("cost_codes")
      .select("id")
      .eq("org_id", orgId)
      .in("id", costCodeIds)

    if (costCodeError || (costCodes ?? []).length !== costCodeIds.length) {
      throw new Error("Cost code not found")
    }
  }

  const { error: deleteError } = await supabase
    .from("bill_lines")
    .delete()
    .eq("org_id", orgId)
    .eq("bill_id", billId)

  if (deleteError) {
    throw new Error(`Failed to update bill coding: ${deleteError.message}`)
  }

  const rows = lines.map((line, index) => ({
    org_id: orgId,
    bill_id: billId,
    cost_code_id: line.cost_code_id,
    budget_line_id: line.budget_line_id ?? null,
    project_id: line.project_id ?? null,
    description: line.description,
    quantity: 1,
    unit: "LS",
    unit_cost_cents: line.amount_cents,
    sort_order: index,
    metadata: {
      source: "ap_review",
      billable_to_customer:
        billingModelByProject.get(line.project_id ?? "") !== "fixed_price" &&
        Boolean(billingModelByProject.get(line.project_id ?? "")) &&
        line.billable_to_customer === true,
      qbo_expense_account_id: line.qbo_expense_account_id,
      qbo_expense_account_name: line.qbo_expense_account_name,
      qbo_ap_account_id: line.qbo_ap_account_id,
      qbo_ap_account_name: line.qbo_ap_account_name,
      qbo_vendor_id: line.qbo_vendor_id,
      qbo_vendor_name: line.qbo_vendor_name,
    },
  }))

  const { error: insertError } = await supabase.from("bill_lines").insert(rows)

  if (insertError) {
    throw new Error(`Failed to update bill coding: ${insertError.message}`)
  }
}

export async function listVendorBillsForCompany(companyId: string, orgId?: string): Promise<VendorBillSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "bill.read",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "company",
    resourceId: companyId,
  })

  const { data: commitments, error: commitmentError } = await supabase
    .from("commitments")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("company_id", companyId)

  if (commitmentError) {
    throw new Error(`Failed to load commitments: ${commitmentError.message}`)
  }

  const commitmentIds = (commitments ?? []).map((c: any) => c.id).filter(Boolean)
  if (commitmentIds.length === 0) return []

  const { data, error } = await supabase
    .from("vendor_bills")
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at, qbo_id, qbo_synced_at, qbo_sync_status, qbo_sync_error, qbo_expense_account_id, qbo_expense_account_name, qbo_ap_account_id, qbo_ap_account_name, qbo_vendor_id, qbo_vendor_name,
      project:projects(id, name),
      company:companies!vendor_bills_company_id_fkey(id, name, qbo_vendor_id, qbo_vendor_name),
      commitment:commitments(id, title, total_cents, company:companies(id, name, qbo_vendor_id, qbo_vendor_name))
    `,
    )
    .eq("org_id", resolvedOrgId)
    .in("commitment_id", commitmentIds)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list vendor bills: ${error.message}`)
  }

  return (data ?? []).map((row: any) => mapVendorBill(row))
}

export async function listVendorBillsForProject(projectId: string, orgId?: string): Promise<VendorBillSummary[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "bill.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })

  // Multi-project bills: include bills whose primary project is elsewhere but
  // which have at least one line allocated to this project.
  const { data: allocatedRows, error: allocatedError } = await supabase
    .from("bill_lines")
    .select("bill_id")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  if (allocatedError) {
    throw new Error(`Failed to resolve allocated bills: ${allocatedError.message}`)
  }

  const allocatedBillIds = Array.from(
    new Set((allocatedRows ?? []).map((row: any) => row.bill_id).filter(Boolean)),
  )

  const baseSelect = supabase
    .from("vendor_bills")
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at, qbo_id, qbo_synced_at, qbo_sync_status, qbo_sync_error, qbo_expense_account_id, qbo_expense_account_name, qbo_ap_account_id, qbo_ap_account_name, qbo_vendor_id, qbo_vendor_name,
      project:projects(id, name),
      company:companies!vendor_bills_company_id_fkey(id, name, qbo_vendor_id, qbo_vendor_name),
      commitment:commitments(id, title, total_cents, company:companies(id, name, qbo_vendor_id, qbo_vendor_name))
    `,
    )
    .eq("org_id", resolvedOrgId)

  const scoped =
    allocatedBillIds.length > 0
      ? baseSelect.or(`project_id.eq.${projectId},id.in.(${allocatedBillIds.join(",")})`)
      : baseSelect.eq("project_id", projectId)

  const { data, error } = await scoped
    .order("due_date", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list vendor bills: ${error.message}`)
  }

  const bills = data ?? []
  const billIds = bills.map((bill: any) => bill.id).filter(Boolean)

  const { data: billLines, error: billLinesError } =
    billIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("bill_lines")
          .select("id, bill_id, project_id, cost_code_id, budget_line_id, description, unit_cost_cents, quantity, metadata, cost_code:cost_codes(id, code, name), project:projects(id, name)")
          .eq("org_id", resolvedOrgId)
          .in("bill_id", billIds)
          .order("sort_order", { ascending: true })

  if (billLinesError) {
    throw new Error(`Failed to load bill coding: ${billLinesError.message}`)
  }

  const linesByBillId = new Map<string, any[]>()
  for (const line of billLines ?? []) {
    const current = linesByBillId.get(line.bill_id) ?? []
    current.push(line)
    linesByBillId.set(line.bill_id, current)
  }

  const { data: paymentRows, error: paymentsError } =
    billIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("payments")
          .select("id, bill_id, amount_cents, method, reference, received_at, provider, status, metadata")
          .eq("org_id", resolvedOrgId)
          .in("bill_id", billIds)
          .eq("status", "succeeded")
          .order("received_at", { ascending: false })

  if (paymentsError) {
    throw new Error(`Failed to load bill payments: ${paymentsError.message}`)
  }

  const paymentsByBillId = new Map<string, any[]>()
  for (const payment of paymentRows ?? []) {
    const current = paymentsByBillId.get(payment.bill_id) ?? []
    current.push(payment)
    paymentsByBillId.set(payment.bill_id, current)
  }

  return bills.map((bill: any) =>
    mapVendorBill(bill, linesByBillId.get(bill.id), projectId, paymentsByBillId.get(bill.id)),
  )
}

export async function updateVendorBillStatus({
  billId,
  input,
  orgId,
}: {
  billId: string
  input: VendorBillStatusUpdate
  orgId?: string
}): Promise<VendorBillSummary> {
  const parsed = vendorBillStatusUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: existingError } = await supabase
    .from("vendor_bills")
    .select("id, org_id, project_id, commitment_id, company_id, bill_number, bill_date, due_date, status, total_cents, currency, metadata, approved_at, approved_by, paid_at, paid_cents, lien_waiver_status, qbo_sync_status, qbo_sync_error, qbo_expense_account_id, qbo_expense_account_name, qbo_ap_account_id, qbo_ap_account_name, qbo_vendor_id, qbo_vendor_name")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Vendor bill not found")
  }
  const existingMetadata = (existing.metadata as Record<string, any> | null) ?? {}
  const isVendorCredit = existingMetadata.source === "vendor_credit"

  if (isVendorCredit && parsed.status !== existing.status) {
    throw new Error("Vendor credits do not have a payment status lifecycle")
  }
  if (
    isVendorCredit &&
    (parsed.payment_amount_cents !== undefined ||
      parsed.payment_method !== undefined ||
      parsed.payment_reference !== undefined)
  ) {
    throw new Error("Payments cannot be recorded against a vendor credit")
  }

  const requiredPermission =
    isVendorCredit
      ? "bill.write"
      : parsed.status === "approved"
      ? "bill.approve"
      : parsed.status === "paid" || parsed.status === "partial"
        ? "payment.release"
        : "bill.write"

  await requireAuthorization({
    permission: requiredPermission,
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: billId,
  })

  if (
    (parsed.status === "paid" || parsed.status === "partial") &&
    existing.status !== "approved" &&
    existing.status !== "partial" &&
    existing.status !== "paid"
  ) {
    throw new Error("Bill must be approved before it can be marked paid")
  }

  if (parsed.status === "paid" || parsed.status === "partial") {
    const rules = await getComplianceRules(resolvedOrgId).catch(() => ({
      require_lien_waiver: false,
      block_payment_on_missing_docs: true,
    }))

    if (rules.block_payment_on_missing_docs) {
      if (rules.require_lien_waiver && existing.lien_waiver_status !== "received") {
        throw new Error("Lien waiver required before payment")
      }

      if (existing.commitment_id) {
        const { data: commitment, error: commitmentError } = await supabase
          .from("commitments")
          .select("company_id")
          .eq("id", existing.commitment_id)
          .eq("org_id", resolvedOrgId)
          .maybeSingle()

        if (commitmentError) {
          throw new Error(`Unable to validate compliance: ${commitmentError.message}`)
        }

        const companyId = (commitment as any)?.company_id as string | undefined
        if (companyId) {
          const status = await getCompanyComplianceStatusWithClient(supabase, resolvedOrgId, companyId)
          if (!status.is_compliant) {
            throw new Error("Compliance documents required before payment")
          }
        }
      }
    }
  }

  if (parsed.status === "partial" && parsed.payment_amount_cents == null && existing.status !== "partial") {
    throw new Error("Payment amount required to mark bill as partial")
  }

  // Build update object with column values.
  const updateData: any = { status: parsed.status }
  if (parsed.bill_number !== undefined) {
    updateData.bill_number = parsed.bill_number
  }
  if (parsed.bill_date !== undefined) {
    updateData.bill_date = parsed.bill_date
  }
  if (parsed.due_date !== undefined) {
    updateData.due_date = parsed.due_date
  }
  const totalCents = existing.total_cents ?? 0
  const existingPaid = typeof existing.paid_cents === "number" ? existing.paid_cents : 0
  const remainingCents = Math.max(0, totalCents - existingPaid)

  if (parsed.payment_reference) {
    updateData.payment_reference = parsed.payment_reference
  }

  if (parsed.payment_method) {
    updateData.payment_method = parsed.payment_method
  }

  // Tracks whether any field that QuickBooks cares about (expense/AP account, vendor) changed.
  // Used below to re-push the recode to an already-linked QBO bill even when the bill isn't
  // transitioning into an approved/paid status (e.g. recoding a still-pending imported bill).
  let qboCodingChanged = false

  if (parsed.qbo_expense_account_id !== undefined) {
    updateData.qbo_expense_account_id = parsed.qbo_expense_account_id || null
    updateData.qbo_expense_account_name = parsed.qbo_expense_account_name || null
    if (!isVendorCredit && existing.qbo_expense_account_id !== parsed.qbo_expense_account_id) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
      qboCodingChanged = true
    }
  }

  if (parsed.qbo_ap_account_id !== undefined) {
    updateData.qbo_ap_account_id = parsed.qbo_ap_account_id || null
    updateData.qbo_ap_account_name = parsed.qbo_ap_account_name || null
    if (!isVendorCredit && existing.qbo_ap_account_id !== parsed.qbo_ap_account_id) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
      qboCodingChanged = true
    }
  }

  if (parsed.company_id !== undefined) {
    updateData.company_id = parsed.company_id
    if (parsed.company_id) {
      const { data: comp } = await supabase
        .from("companies")
        .select("qbo_vendor_id, qbo_vendor_name, name")
        .eq("id", parsed.company_id)
        .maybeSingle()
      if (comp) {
        updateData.qbo_vendor_id = comp.qbo_vendor_id ?? null
        updateData.qbo_vendor_name = comp.qbo_vendor_name ?? comp.name ?? null
      }
    } else {
      updateData.qbo_vendor_id = null
      updateData.qbo_vendor_name = null
    }
    if (!isVendorCredit && existing.company_id !== parsed.company_id) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
      qboCodingChanged = true
    }
  }

  if (parsed.qbo_vendor_id !== undefined) {
    updateData.qbo_vendor_id = parsed.qbo_vendor_id || null
    updateData.qbo_vendor_name = parsed.qbo_vendor_name || null
    if (!isVendorCredit && existing.qbo_vendor_id !== parsed.qbo_vendor_id) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
      qboCodingChanged = true
    }
  }

  if (parsed.status === "approved" && !existing.approved_at) {
    updateData.approved_at = new Date().toISOString()
    updateData.approved_by = userId
  }

  const explicitLines = parsed.actual_lines && parsed.actual_lines.length > 0 ? parsed.actual_lines : null

  let actualLines = explicitLines
    ? explicitLines.map((line) => ({
        cost_code_id: line.cost_code_id ?? null,
        budget_line_id: line.budget_line_id ?? null,
        description: line.description?.trim() || (existing.bill_number ? `Bill ${existing.bill_number}` : "Vendor bill"),
        amount_cents: line.amount_cents,
        project_id: line.project_id ?? existing.project_id ?? null,
        billable_to_customer: line.billable_to_customer === true,
        qbo_expense_account_id: line.qbo_expense_account_id ?? parsed.qbo_expense_account_id ?? existing.qbo_expense_account_id ?? undefined,
        qbo_expense_account_name: line.qbo_expense_account_name ?? parsed.qbo_expense_account_name ?? existing.qbo_expense_account_name ?? undefined,
        qbo_ap_account_id: line.qbo_ap_account_id ?? parsed.qbo_ap_account_id ?? existing.qbo_ap_account_id ?? undefined,
        qbo_ap_account_name: line.qbo_ap_account_name ?? parsed.qbo_ap_account_name ?? existing.qbo_ap_account_name ?? undefined,
        qbo_vendor_id: line.qbo_vendor_id ?? parsed.qbo_vendor_id ?? existing.qbo_vendor_id ?? undefined,
        qbo_vendor_name: line.qbo_vendor_name ?? parsed.qbo_vendor_name ?? existing.qbo_vendor_name ?? undefined,
      }))
    : []

  const targetStatus = parsed.status ?? existing.status
  const isApprovedOrReleased = ["approved", "partial", "paid"].includes(targetStatus)

  // When no explicit per-line coding is supplied we may still need to synthesize a single
  // full-total line — e.g. a quick approve from the list, or assigning one cost code to an
  // uncoded bill. Crucially, we must NOT do this when the bill is already split across
  // multiple lines, or we'd silently collapse the split back onto the bill's primary project.
  if (!explicitLines && (parsed.cost_code_id || isApprovedOrReleased)) {
    const { data: currentLines } = await supabase
      .from("bill_lines")
      .select("id")
      .eq("org_id", resolvedOrgId)
      .eq("bill_id", billId)

    const existingLineCount = currentLines?.length ?? 0
    // Only (re)build a single line when the bill isn't already split: an uncoded bill (0 lines),
    // or recoding the lone line when an explicit cost code is being assigned.
    const shouldSynthesizeSingleLine =
      existingLineCount === 0 || (existingLineCount === 1 && Boolean(parsed.cost_code_id))

    if (shouldSynthesizeSingleLine) {
      const fallbackDescription = existing.bill_number ? `Bill ${existing.bill_number}` : "Vendor bill"
      const inheritedLines =
        !parsed.cost_code_id && existing.commitment_id
          ? await buildBillLinesFromCommitment({
              supabase,
              orgId: resolvedOrgId,
              commitmentId: existing.commitment_id,
              billAmountCents: totalCents,
              projectId: existing.project_id ?? null,
              fallbackDescription,
            })
          : null

      actualLines =
        inheritedLines && inheritedLines.length > 0
          ? inheritedLines
          : [
              {
                cost_code_id: parsed.cost_code_id ?? null,
                budget_line_id: null,
                description: fallbackDescription,
                amount_cents: totalCents,
                project_id: existing.project_id ?? null,
                billable_to_customer: false,
                qbo_expense_account_id: parsed.qbo_expense_account_id ?? existing.qbo_expense_account_id ?? undefined,
                qbo_expense_account_name: parsed.qbo_expense_account_name ?? existing.qbo_expense_account_name ?? undefined,
                qbo_ap_account_id: parsed.qbo_ap_account_id ?? existing.qbo_ap_account_id ?? undefined,
                qbo_ap_account_name: parsed.qbo_ap_account_name ?? existing.qbo_ap_account_name ?? undefined,
                qbo_vendor_id: parsed.qbo_vendor_id ?? existing.qbo_vendor_id ?? undefined,
                qbo_vendor_name: parsed.qbo_vendor_name ?? existing.qbo_vendor_name ?? undefined,
              },
            ]
    }
  }

  if (actualLines.length > 0) {
    const hasInvalidSign = isVendorCredit
      ? actualLines.some((line) => line.amount_cents > 0)
      : actualLines.some((line) => line.amount_cents < 0)
    if (hasInvalidSign) {
      throw new Error(isVendorCredit ? "Vendor credit lines cannot be positive" : "Bill lines cannot be negative")
    }
    const actualTotal = actualLines.reduce((sum, line) => sum + line.amount_cents, 0)
    if (actualTotal !== totalCents) {
      throw new Error("Bill coding must equal the bill amount")
    }

    if (!isVendorCredit && isApprovedOrReleased && !updateData.qbo_expense_account_id && linesHaveQboExpenseCoding(actualLines)) {
      updateData.qbo_sync_status = "pending"
      updateData.qbo_sync_error = null
    }

    if (["approved", "partial", "paid"].includes(String(existing.status))) {
      await voidBillableCostsForVendorBill({ billId, orgId: resolvedOrgId })
      await voidJobCostEntriesForVendorBill({ billId, orgId: resolvedOrgId })
    }

    await replaceBillLineCoding(supabase, {
      orgId: resolvedOrgId,
      billId,
      lines: actualLines,
    })
  }

  const shouldProcessPayment = parsed.status === "paid" || (parsed.status === "partial" && parsed.payment_amount_cents != null)

  if (shouldProcessPayment) {
    let paymentAmount = parsed.payment_amount_cents
    if (paymentAmount == null && parsed.status === "paid") {
      paymentAmount = remainingCents
    }

    if (paymentAmount == null) {
      throw new Error("Payment amount required for partial payments")
    }

    if (paymentAmount <= 0 && remainingCents > 0) {
      throw new Error("Payment amount must be positive")
    }

    if (paymentAmount > remainingCents) {
      throw new Error("Payment amount exceeds remaining balance")
    }

    if (paymentAmount > 0) {
      const { data: paymentRow, error: paymentInsertError } = await supabase.from("payments").insert({
        org_id: resolvedOrgId,
        project_id: existing.project_id,
        bill_id: billId,
        amount_cents: paymentAmount,
        currency: existing.currency ?? "usd",
        method: parsed.payment_method ?? "check",
        reference: parsed.payment_reference ?? null,
        received_at: new Date().toISOString(),
        status: "succeeded",
        provider: "manual",
        net_cents: paymentAmount,
        metadata: {},
      }).select("id").single()

      if (paymentInsertError) {
        throw new Error(`Failed to record bill payment: ${paymentInsertError.message}`)
      }
      if (paymentRow?.id) {
        await enqueueBillPaymentSync(paymentRow.id, resolvedOrgId)
      }
    }

    const nextPaid = existingPaid + (paymentAmount ?? 0)
    const isPaid = totalCents > 0 ? nextPaid >= totalCents : parsed.status === "paid"
    updateData.status = isPaid ? "paid" : "partial"
    updateData.paid_cents = nextPaid
    if (isPaid && !existing.paid_at) {
      updateData.paid_at = new Date().toISOString()
    }
  }

  if (parsed.retainage_percent != null) {
    updateData.retainage_percent = parsed.retainage_percent
    updateData.retainage_cents = Math.round((totalCents * parsed.retainage_percent) / 100)
  }

  if (parsed.lien_waiver_status) {
    updateData.lien_waiver_status = parsed.lien_waiver_status
    updateData.lien_waiver_received_at =
      parsed.lien_waiver_status === "received" ? new Date().toISOString() : null
  }

  const { data, error } = await supabase
    .from("vendor_bills")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at, qbo_id, qbo_synced_at, qbo_sync_status, qbo_sync_error, qbo_expense_account_id, qbo_expense_account_name, qbo_ap_account_id, qbo_ap_account_name, qbo_vendor_id, qbo_vendor_name,
      project:projects(id, name),
      company:companies!vendor_bills_company_id_fkey(id, name, qbo_vendor_id, qbo_vendor_name),
      commitment:commitments(id, title, total_cents, company:companies(id, name, qbo_vendor_id, qbo_vendor_name))
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to update vendor bill: ${error?.message}`)
  }

  const finalStatus = updateData.status ?? parsed.status

  try {
    if (["approved", "partial", "paid"].includes(String(finalStatus))) {
      await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId })
    }

    if (["approved", "partial", "paid"].includes(String(existing.status)) && finalStatus === "pending") {
      await voidBillableCostsForVendorBill({ billId, orgId: resolvedOrgId })
      await voidJobCostEntriesForVendorBill({ billId, orgId: resolvedOrgId })
    }
  } catch (error) {
    await supabase
      .from("vendor_bills")
      .update({
        status: existing.status,
        approved_at: existing.approved_at ?? null,
        approved_by: existing.approved_by ?? null,
        paid_at: existing.paid_at ?? null,
        paid_cents: existing.paid_cents ?? null,
        qbo_sync_status: existing.qbo_sync_status ?? null,
        qbo_sync_error: existing.qbo_sync_error ?? null,
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", billId)

    const message = error instanceof Error ? error.message : String(error ?? "Unknown error")
    throw new Error(`Vendor bill status was not saved because the project cost ledger could not be updated: ${message}`)
  }

  // Push to QuickBooks when either (a) the bill enters an approved/paid state, or (b) its QBO
  // coding (expense/AP account, vendor) changed and the bill is already linked to a QBO record
  // — so recoding a still-pending or imported bill flows the new account back to QuickBooks.
  // enqueueVendorBillSync is the durable, deduped path: it respects auto-sync, skips inbound-only
  // imports (isSyncPushBlocked), and is drained with retries by the process-outbox cron.
  const billLinkedToQbo = Boolean(data.qbo_id)
  const shouldEnqueueForStatus = ["approved", "partial", "paid"].includes(String(finalStatus))
  const shouldEnqueueForRecode = billLinkedToQbo && qboCodingChanged
  if (!isVendorCredit && (shouldEnqueueForStatus || shouldEnqueueForRecode)) {
    await enqueueVendorBillSync(billId, resolvedOrgId)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "vendor_bill",
    entityId: billId,
    before: existing,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: finalStatus === "paid" ? "vendor_bill_paid" : "vendor_bill_updated",
    entityType: "vendor_bill",
    entityId: billId,
    payload: {
      status: finalStatus,
      cost_code_id: parsed.cost_code_id,
      actual_lines: parsed.actual_lines,
      payment_reference: parsed.payment_reference,
      payment_method: parsed.payment_method,
      payment_amount_cents: parsed.payment_amount_cents,
      lien_waiver_status: parsed.lien_waiver_status,
      retainage_percent: parsed.retainage_percent,
      qbo_expense_account_id: parsed.qbo_expense_account_id,
      qbo_ap_account_id: parsed.qbo_ap_account_id,
      qbo_vendor_id: parsed.qbo_vendor_id,
    },
  })

  return mapVendorBill(data)
}

/**
 * Create a vendor bill from the sub portal.
 * This function bypasses normal org context since it's called from a portal token.
 */
export async function createVendorBillFromPortal({
  input,
  orgId,
  projectId,
  companyId,
  portalTokenId,
}: {
  input: VendorBillCreate
  orgId: string
  projectId: string
  companyId: string
  portalTokenId: string
}): Promise<VendorBillSummary> {
  const parsed = vendorBillCreateSchema.parse(input)
  const supabase = createServiceSupabaseClient()

  // Verify the commitment belongs to this org, project, and company
  const { data: commitment, error: commitmentError } = await supabase
    .from("commitments")
    .select("id, org_id, project_id, company_id, title, status, total_cents")
    .eq("id", parsed.commitment_id)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("company_id", companyId)
    .maybeSingle()

  if (commitmentError || !commitment) {
    throw new Error("Commitment not found or does not belong to your company")
  }

  if (commitment.status !== "approved") {
    throw new Error("Can only submit invoices against approved contracts")
  }

  // Get existing billed amount for this commitment
  const { data: existingBills } = await supabase
    .from("vendor_bills")
    .select("total_cents")
    .eq("commitment_id", parsed.commitment_id)
    .eq("org_id", orgId)

  const totalBilled = (existingBills ?? []).reduce((sum, b) => sum + (b.total_cents ?? 0), 0)
  const remaining = (commitment.total_cents ?? 0) - totalBilled

  // Warn if over budget (but still allow submission)
  const isOverBudget = parsed.total_cents > remaining

  // Create the vendor bill
  const { data, error } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: orgId,
      project_id: projectId,
      commitment_id: parsed.commitment_id,
      bill_number: parsed.bill_number,
      total_cents: parsed.total_cents,
      currency: "usd",
      status: "pending",
      bill_date: parsed.bill_date,
      due_date: parsed.due_date ?? null,
      file_id: parsed.file_id ?? null,
      metadata: {
        description: parsed.description,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        submitted_via_portal: true,
        portal_token_id: portalTokenId,
        over_budget: isOverBudget,
      },
    })
    .select(
      `
      id, org_id, project_id, commitment_id, bill_number, status, bill_date, due_date, total_cents, currency, submitted_by_contact_id, file_id, metadata, created_at, updated_at, approved_at, approved_by, paid_at, paid_cents, payment_reference, payment_method, retainage_percent, retainage_cents, lien_waiver_status, lien_waiver_received_at,
      project:projects(id, name),
      commitment:commitments(id, title, total_cents)
    `,
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create vendor bill: ${error?.message}`)
  }

  if (parsed.file_id) {
    try {
      await attachFileWithServiceRole({
        orgId,
        fileId: parsed.file_id,
        projectId,
        entityType: "vendor_bill",
        entityId: data.id as string,
        linkRole: "invoice",
        createdBy: null,
      })
    } catch (error) {
      console.warn("Failed to attach vendor bill file to file_links", error)
    }
  }

  // Record event for activity feed
  await recordEvent({
    orgId,
    eventType: "vendor_bill_submitted",
    entityType: "vendor_bill",
    entityId: data.id as string,
    payload: {
      company_id: companyId,
      project_id: projectId,
      commitment_id: parsed.commitment_id,
      total_cents: parsed.total_cents,
      bill_number: parsed.bill_number,
      submitted_via_portal: true,
      over_budget: isOverBudget,
    },
  })

  return mapVendorBill(data)
}

export async function deleteVendorBill({
  billId,
  orgId,
}: {
  billId: string
  orgId?: string
}): Promise<{ projectId: string | null }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // 1. Fetch the existing bill
  const { data: existing, error: existingError } = await supabase
    .from("vendor_bills")
    .select("id, org_id, project_id, bill_number, status, qbo_id, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Vendor bill not found")
  }

  const existingMetadata = (existing.metadata as Record<string, any> | null) ?? {}

  // 2. Authorization check (bill.write)
  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id ?? undefined,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: billId,
  })

  // 3. Restriction checks
  if (existing.qbo_id) {
    // Bills imported FROM QuickBooks are owned by QBO — deleting the Arc copy
    // would not touch QBO, and the usual reason to delete one is a wrong project.
    // Point the user at Reassign instead of the (here misleading) "disconnect in QBO" path.
    if (existingMetadata.imported_from_qbo === true) {
      throw new Error(
        'This bill was imported from QuickBooks. To move it to the correct project, use "Reassign" instead of deleting it here.',
      )
    }
    throw new Error("Bills synced to QuickBooks cannot be deleted. Disconnect or delete them in QuickBooks first.")
  }

  // Fetch related billable costs
  const { data: costs, error: costsError } = await supabase
    .from("billable_costs")
    .select("status")
    .eq("org_id", resolvedOrgId)
    .eq("source_type", "vendor_bill_line")
    .eq("metadata->>bill_id", billId)

  if (costsError) {
    throw new Error(`Failed to load billable costs: ${costsError.message}`)
  }

  const hasBilledOrLockedCosts = (costs ?? []).some(
    (cost) => cost.status === "billed" || cost.status === "locked"
  )
  if (hasBilledOrLockedCosts) {
    throw new Error("This bill cannot be deleted because its costs have already been billed or locked.")
  }

  // 4. Cleanup related polymorphic records
  // Fetch line IDs
  const { data: lines, error: linesError } = await supabase
    .from("bill_lines")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("bill_id", billId)

  if (linesError) {
    throw new Error(`Failed to load bill lines: ${linesError.message}`)
  }

  const lineIds = (lines ?? []).map((line) => line.id).filter(Boolean)

  if (lineIds.length > 0) {
    // Delete open/voided billable costs
    const { error: deleteCostsError } = await supabase
      .from("billable_costs")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq("source_type", "vendor_bill_line")
      .in("source_id", lineIds)

    if (deleteCostsError) {
      throw new Error(`Failed to delete billable costs: ${deleteCostsError.message}`)
    }

    // Delete job cost entries
    const { error: deleteJobCostsError } = await supabase
      .from("job_cost_entries")
      .delete()
      .eq("org_id", resolvedOrgId)
      .eq("source_type", "vendor_bill_line")
      .in("source_id", lineIds)

    if (deleteJobCostsError) {
      throw new Error(`Failed to delete job cost entries: ${deleteJobCostsError.message}`)
    }
  }

  // Delete file links
  await supabase
    .from("file_links")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", "vendor_bill")
    .eq("entity_id", billId)

  // 5. Delete the vendor bill (bill_lines will be deleted automatically due to cascade constraint)
  const { error: deleteBillError } = await supabase
    .from("vendor_bills")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)

  if (deleteBillError) {
    throw new Error(`Failed to delete vendor bill: ${deleteBillError.message}`)
  }

  // 6. Record activity event & audit log
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "vendor_bill_deleted",
    entityType: "vendor_bill",
    entityId: billId,
    payload: {
      bill_number: existing.bill_number,
      project_id: existing.project_id,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "vendor_bill",
    entityId: billId,
    before: existing,
  })

  return { projectId: existing.project_id }
}

/**
 * Move a QuickBooks-imported payable (regular bill or vendor credit) to a
 * different project. Re-posts the job-cost ledger so reports stay correct.
 *
 * Vendor credits that have already been *applied* to a bill (which records a
 * payment-settlement link) are blocked, because moving them would break that
 * application. A regular bill's own payment simply moves with the bill.
 */
export async function reassignImportedPayable({
  billId,
  targetProjectId,
  orgId,
}: {
  billId: string
  targetProjectId: string
  orgId?: string
}): Promise<{ previousProjectId: string; projectId: string }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: existingError } = await supabase
    .from("vendor_bills")
    .select("id, org_id, project_id, bill_number, total_cents, status, metadata, qbo_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)
    .maybeSingle()

  if (existingError || !existing) throw new Error("Payable not found")
  const metadata = (existing.metadata as Record<string, any> | null) ?? {}
  const isVendorCredit = metadata.source === "vendor_credit"
  const payableLabel = isVendorCredit ? "vendor credit" : "bill"
  if (metadata.imported_from_qbo !== true || !existing.qbo_id) {
    throw new Error("Only payables imported from QuickBooks can be reassigned")
  }
  if (!existing.project_id) throw new Error(`This ${payableLabel} is missing its current project`)
  if (existing.project_id === targetProjectId) {
    return { previousProjectId: existing.project_id, projectId: targetProjectId }
  }

  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "vendor_bill",
    resourceId: billId,
  })
  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId: resolvedOrgId,
    projectId: targetProjectId,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: targetProjectId,
  })

  const { data: targetProject, error: targetProjectError } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("id", targetProjectId)
    .maybeSingle()
  if (targetProjectError || !targetProject) throw new Error("Target project not found")

  const { count: paymentCount, error: paymentsError } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("bill_id", billId)
  if (paymentsError) throw new Error(`Failed to check payable dependencies: ${paymentsError.message}`)
  if (isVendorCredit && (paymentCount ?? 0) > 0) {
    throw new Error("This vendor credit cannot be reassigned because it is already applied to a bill")
  }

  const previousProjectId = existing.project_id
  await voidJobCostEntriesForVendorBill({ billId, orgId: resolvedOrgId })

  const { error: lineUpdateError } = await supabase
    .from("bill_lines")
    .update({ project_id: targetProjectId })
    .eq("org_id", resolvedOrgId)
    .eq("bill_id", billId)
  if (lineUpdateError) {
    await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId })
    throw new Error(`Failed to reassign ${payableLabel} lines: ${lineUpdateError.message}`)
  }

  const { error: billUpdateError } = await supabase
    .from("vendor_bills")
    .update({
      project_id: targetProjectId,
      commitment_id: null,
      metadata: {
        ...metadata,
        reassigned_from_project_id: previousProjectId,
        reassigned_at: new Date().toISOString(),
        reassigned_by: userId,
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", billId)

  if (billUpdateError) {
    await supabase.from("bill_lines").update({ project_id: previousProjectId }).eq("org_id", resolvedOrgId).eq("bill_id", billId)
    await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId })
    throw new Error(`Failed to reassign ${payableLabel}: ${billUpdateError.message}`)
  }

  try {
    await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId })
  } catch (error) {
    await supabase
      .from("vendor_bills")
      .update({ project_id: previousProjectId, metadata })
      .eq("org_id", resolvedOrgId)
      .eq("id", billId)
    await supabase.from("bill_lines").update({ project_id: previousProjectId }).eq("org_id", resolvedOrgId).eq("bill_id", billId)
    await propagateApprovalToLedger({ source: "vendor_bill", sourceId: billId, orgId: resolvedOrgId }).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`This ${payableLabel} was not reassigned because job costs could not be updated: ${message}`)
  }

  // A regular bill's payment(s) belong to the bill and should follow it to the
  // new project. (Applied vendor credits are blocked above, so this only runs
  // for ordinary bills.)
  if (!isVendorCredit && (paymentCount ?? 0) > 0) {
    const { error: paymentMoveError } = await supabase
      .from("payments")
      .update({ project_id: targetProjectId })
      .eq("org_id", resolvedOrgId)
      .eq("bill_id", billId)
    if (paymentMoveError) {
      console.warn("Payable reassigned but its payment project could not be moved", paymentMoveError)
    }
  }

  const { error: fileLinksError } = await supabase
    .from("file_links")
    .update({ project_id: targetProjectId })
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", "vendor_bill")
    .eq("entity_id", billId)
  if (fileLinksError) {
    console.warn("Payable reassigned but its file links could not be moved", fileLinksError)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "vendor_bill",
    entityId: billId,
    before: existing,
    after: { ...existing, project_id: targetProjectId },
  })
  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: isVendorCredit ? "vendor_credit_reassigned" : "vendor_bill_reassigned",
    entityType: "vendor_bill",
    entityId: billId,
    payload: {
      qbo_id: existing.qbo_id,
      previous_project_id: previousProjectId,
      project_id: targetProjectId,
      total_cents: existing.total_cents,
    },
  })

  return { previousProjectId, projectId: targetProjectId }
}
