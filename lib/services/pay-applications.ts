import type { SupabaseClient } from "@supabase/supabase-js"

import {
  computePayAppLine,
  computePayAppSummary,
  normalizeRetainageSchedule,
  resolveRetainageRatePercent,
  thisPeriodFromPercentComplete,
  type ComputedPayAppLine,
  type PayAppSummary,
  type RetainageStep,
} from "@/lib/financials/pay-app-math"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createInvoice, voidInvoice } from "@/lib/services/invoices"
import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import { getPeriodForCostDate, linkInvoiceToBillingPeriod } from "@/lib/services/billing-periods"
import { getProgressBillingContract, listPrimeSovLines, type PrimeSovLine } from "@/lib/services/prime-sov"
import {
  payApplicationCreateSchema,
  payApplicationLinesUpdateSchema,
  retainageReleaseInputSchema,
  type PayApplicationLineEntry,
  type RetainageReleaseInput,
} from "@/lib/validation/pay-applications"

const PAY_APP_SELECT =
  "id, org_id, project_id, contract_id, application_number, period_start, period_end, billing_period_id, status, invoice_id, original_contract_sum_cents, change_order_sum_cents, contract_sum_to_date_cents, total_completed_stored_cents, retainage_cents, total_earned_less_retainage_cents, previous_certificates_cents, current_payment_due_cents, balance_to_finish_cents, submitted_at, approved_at, pdf_file_id, metadata, created_at, updated_at"

const APP_LINE_SELECT =
  "id, pay_application_id, prime_sov_line_id, scheduled_value_cents, previous_billed_cents, this_period_cents, stored_materials_cents, percent_complete, balance_to_finish_cents, retainage_cents, metadata"

const BILLED_APP_STATUSES = ["submitted", "approved", "invoiced", "paid"] as const

export type PayApplicationStatus = "draft" | "submitted" | "approved" | "invoiced" | "paid" | "void"

export interface PayApplication {
  id: string
  project_id: string
  contract_id: string
  application_number: number
  period_start: string | null
  period_end: string
  billing_period_id: string | null
  status: PayApplicationStatus
  invoice_id: string | null
  original_contract_sum_cents: number
  change_order_sum_cents: number
  contract_sum_to_date_cents: number
  total_completed_stored_cents: number
  retainage_cents: number
  total_earned_less_retainage_cents: number
  previous_certificates_cents: number
  current_payment_due_cents: number
  balance_to_finish_cents: number
  submitted_at: string | null
  approved_at: string | null
  pdf_file_id: string | null
  is_retainage_release: boolean
  created_at?: string
}

export interface PayApplicationLine {
  id: string
  prime_sov_line_id: string
  line_number: number
  description: string
  cost_code_label: string | null
  scheduled_value_cents: number
  previous_billed_cents: number
  this_period_cents: number
  stored_materials_cents: number
  previous_stored_materials_cents: number
  percent_complete: number
  balance_to_finish_cents: number
  retainage_cents: number
  retainage_percent_override: number | null
  overbilled: boolean
}

export interface PayApplicationRetainageConfig {
  contract_percent: number
  schedule: RetainageStep[] | null
  stored_materials_percent: number | null
}

export interface PayApplicationDetail {
  application: PayApplication
  lines: PayApplicationLine[]
  summary: PayAppSummary
  retainage_config: PayApplicationRetainageConfig
}

type PayAppRow = Record<string, any>
type AppLineRow = Record<string, any>

function mapApplication(row: PayAppRow): PayApplication {
  const metadata = (row.metadata ?? {}) as Record<string, any>
  return {
    id: row.id,
    project_id: row.project_id,
    contract_id: row.contract_id,
    application_number: Number(row.application_number),
    period_start: row.period_start ?? null,
    period_end: row.period_end,
    billing_period_id: row.billing_period_id ?? null,
    status: row.status as PayApplicationStatus,
    invoice_id: row.invoice_id ?? null,
    original_contract_sum_cents: Number(row.original_contract_sum_cents ?? 0),
    change_order_sum_cents: Number(row.change_order_sum_cents ?? 0),
    contract_sum_to_date_cents: Number(row.contract_sum_to_date_cents ?? 0),
    total_completed_stored_cents: Number(row.total_completed_stored_cents ?? 0),
    retainage_cents: Number(row.retainage_cents ?? 0),
    total_earned_less_retainage_cents: Number(row.total_earned_less_retainage_cents ?? 0),
    previous_certificates_cents: Number(row.previous_certificates_cents ?? 0),
    current_payment_due_cents: Number(row.current_payment_due_cents ?? 0),
    balance_to_finish_cents: Number(row.balance_to_finish_cents ?? 0),
    submitted_at: row.submitted_at ?? null,
    approved_at: row.approved_at ?? null,
    pdf_file_id: row.pdf_file_id ?? null,
    is_retainage_release: metadata.type === "retainage_release",
    created_at: row.created_at,
  }
}

function retainageConfigFromContract(contract: {
  retainage_percent?: number | null
  retainage_schedule?: unknown
  stored_materials_retainage_percent?: number | null
}): PayApplicationRetainageConfig {
  return {
    contract_percent: Number(contract.retainage_percent ?? 0),
    schedule: normalizeRetainageSchedule(contract.retainage_schedule),
    stored_materials_percent:
      contract.stored_materials_retainage_percent != null ? Number(contract.stored_materials_retainage_percent) : null,
  }
}

function computedFromRow(row: AppLineRow): ComputedPayAppLine {
  return {
    thisPeriodCents: Number(row.this_period_cents ?? 0),
    storedMaterialsCents: Number(row.stored_materials_cents ?? 0),
    totalCompletedAndStoredCents:
      Number(row.previous_billed_cents ?? 0) + Number(row.this_period_cents ?? 0) + Number(row.stored_materials_cents ?? 0),
    percentComplete: Number(row.percent_complete ?? 0),
    balanceToFinishCents: Number(row.balance_to_finish_cents ?? 0),
    retainageCents: Number(row.retainage_cents ?? 0),
    overbilled: Boolean((row.metadata as Record<string, any> | null)?.overbilled),
  }
}

function mapLine(row: AppLineRow, sovLine: PrimeSovLine | undefined): PayApplicationLine {
  const metadata = (row.metadata ?? {}) as Record<string, any>
  return {
    id: row.id,
    prime_sov_line_id: row.prime_sov_line_id,
    line_number: sovLine?.line_number ?? 0,
    description: sovLine?.description ?? "SOV line",
    cost_code_label: sovLine?.cost_code_label ?? null,
    scheduled_value_cents: Number(row.scheduled_value_cents ?? 0),
    previous_billed_cents: Number(row.previous_billed_cents ?? 0),
    this_period_cents: Number(row.this_period_cents ?? 0),
    stored_materials_cents: Number(row.stored_materials_cents ?? 0),
    previous_stored_materials_cents: Number(metadata.previous_stored_materials_cents ?? 0),
    percent_complete: Number(row.percent_complete ?? 0),
    balance_to_finish_cents: Number(row.balance_to_finish_cents ?? 0),
    retainage_cents: Number(row.retainage_cents ?? 0),
    retainage_percent_override: sovLine?.retainage_percent_override ?? null,
    overbilled: Boolean(metadata.overbilled),
  }
}

async function requirePayAppPermission(params: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  permission?: "payapp.write" | "invoice.read"
  resourceId?: string
}) {
  await requireAuthorization({
    permission: params.permission ?? "payapp.write",
    userId: params.userId,
    orgId: params.orgId,
    projectId: params.projectId,
    supabase: params.supabase,
    logDecision: params.permission !== "invoice.read",
    resourceType: "pay_application",
    resourceId: params.resourceId,
  })
}

async function loadApplication(supabase: SupabaseClient, orgId: string, payApplicationId: string): Promise<PayAppRow> {
  const { data, error } = await supabase
    .from("pay_applications")
    .select(PAY_APP_SELECT)
    .eq("org_id", orgId)
    .eq("id", payApplicationId)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to load pay application: ${error.message}`)
  }
  if (!data) {
    throw new Error("Pay application not found")
  }
  return data
}

async function loadApplicationLines(supabase: SupabaseClient, orgId: string, payApplicationId: string): Promise<AppLineRow[]> {
  const { data, error } = await supabase
    .from("pay_application_lines")
    .select(APP_LINE_SELECT)
    .eq("org_id", orgId)
    .eq("pay_application_id", payApplicationId)
  if (error) {
    throw new Error(`Failed to load pay application lines: ${error.message}`)
  }
  return data ?? []
}

async function sumPreviousCertificates(
  supabase: SupabaseClient,
  orgId: string,
  contractId: string,
  excludeAppId?: string,
): Promise<number> {
  let query = supabase
    .from("pay_applications")
    .select("id, current_payment_due_cents")
    .eq("org_id", orgId)
    .eq("contract_id", contractId)
    .in("status", [...BILLED_APP_STATUSES])
  if (excludeAppId) {
    query = query.neq("id", excludeAppId)
  }
  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load prior pay applications: ${error.message}`)
  }
  return (data ?? []).reduce((sum, row) => sum + Number(row.current_payment_due_cents ?? 0), 0)
}

async function sumApprovedChangeOrders(supabase: SupabaseClient, orgId: string, projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from("change_orders")
    .select("total_cents")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("lifecycle", "approved")
  if (error) {
    throw new Error(`Failed to load approved change orders: ${error.message}`)
  }
  return (data ?? []).reduce((sum, row) => sum + Number(row.total_cents ?? 0), 0)
}

async function buildDetail(
  supabase: SupabaseClient,
  orgId: string,
  appRow: PayAppRow,
  options?: { sovLines?: PrimeSovLine[] },
): Promise<PayApplicationDetail> {
  const [lineRows, sovState, contract, previousCertificates, changeOrderSum] = await Promise.all([
    loadApplicationLines(supabase, orgId, appRow.id),
    options?.sovLines
      ? Promise.resolve(null)
      : listPrimeSovLines(appRow.project_id as string, orgId),
    getProgressBillingContract(supabase, orgId, appRow.project_id as string),
    sumPreviousCertificates(supabase, orgId, appRow.contract_id as string, appRow.id as string),
    sumApprovedChangeOrders(supabase, orgId, appRow.project_id as string),
  ])

  const sovLines = options?.sovLines ?? sovState?.lines ?? []
  const sovById = new Map(sovLines.map((line) => [line.id, line]))
  const lines = lineRows
    .map((row) => mapLine(row, sovById.get(row.prime_sov_line_id as string)))
    .sort((a, b) => a.line_number - b.line_number)

  const application = mapApplication(appRow)
  const heldNet = sovLines.reduce((sum, line) => sum + line.retainage_held_cents - line.retainage_released_cents, 0)
  const isPosted = application.status !== "draft"

  // For drafts the summary is live-computed; posted apps report their frozen
  // snapshot so the numbers never drift after invoicing.
  const summary: PayAppSummary = isPosted
    ? {
        contractSumToDateCents: application.contract_sum_to_date_cents,
        totalCompletedStoredCents: application.total_completed_stored_cents,
        currentRetainageCents: Number((appRow.metadata as Record<string, any> | null)?.current_retainage_cents ?? 0),
        retainageCents: application.retainage_cents,
        totalEarnedLessRetainageCents: application.total_earned_less_retainage_cents,
        previousCertificatesCents: application.previous_certificates_cents,
        currentPaymentDueCents: application.current_payment_due_cents,
        balanceToFinishCents: application.balance_to_finish_cents,
      }
    : computePayAppSummary({
        originalContractSumCents: resolveOriginalContractSum(contract),
        changeOrderSumCents: changeOrderSum,
        previousRetainageHeldCents: heldNet,
        previousCertificatesCents: previousCertificates,
        lines: lineRows.map(computedFromRow),
      })

  return {
    application,
    lines,
    summary,
    retainage_config: retainageConfigFromContract(contract ?? {}),
  }
}

function resolveOriginalContractSum(contract: { total_cents?: number | null; snapshot?: Record<string, any> | null } | null): number {
  if (!contract) return 0
  const original = Number(contract.snapshot?.original_total_cents ?? NaN)
  if (Number.isFinite(original) && original > 0) return Math.round(original)
  return Number(contract.total_cents ?? 0)
}

export async function listPayApplications(projectId: string, orgId?: string): Promise<PayApplication[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePayAppPermission({ supabase, orgId: resolvedOrgId, userId, projectId, permission: "invoice.read" })

  const { data, error } = await supabase
    .from("pay_applications")
    .select(PAY_APP_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("application_number", { ascending: false })
  if (error) {
    throw new Error(`Failed to load pay applications: ${error.message}`)
  }
  return (data ?? []).map(mapApplication)
}

export async function getPayApplication(payApplicationId: string, orgId?: string): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    permission: "invoice.read",
    resourceId: payApplicationId,
  })
  return buildDetail(supabase, resolvedOrgId, appRow)
}

const INSERT_RETRY_LIMIT = 5

export async function createPayApplication(
  projectId: string,
  input: { period_start?: string | null; period_end: string },
  orgId?: string,
): Promise<PayApplicationDetail> {
  const parsed = payApplicationCreateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePayAppPermission({ supabase, orgId: resolvedOrgId, userId, projectId })

  const sovState = await listPrimeSovLines(projectId, resolvedOrgId)
  if (!sovState.summary) {
    throw new Error("Set up the billing contract before creating a pay application")
  }
  if (sovState.lines.length === 0) {
    throw new Error("Build the schedule of values before creating a pay application")
  }

  const { data: openDraft, error: draftError } = await supabase
    .from("pay_applications")
    .select("id, application_number")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", sovState.summary.contract_id)
    .eq("status", "draft")
    .limit(1)
    .maybeSingle()
  if (draftError) {
    throw new Error(`Failed to check open pay applications: ${draftError.message}`)
  }
  if (openDraft) {
    throw new Error(`Application #${openDraft.application_number} is still a draft. Submit or delete it first.`)
  }

  const billingPeriod = await getPeriodForCostDate({
    supabase,
    orgId: resolvedOrgId,
    projectId,
    occurredOn: parsed.period_end,
  }).catch(() => null)

  let appRow: PayAppRow | null = null
  for (let attempt = 0; attempt < INSERT_RETRY_LIMIT && !appRow; attempt += 1) {
    const { data: maxRow, error: maxError } = await supabase
      .from("pay_applications")
      .select("application_number")
      .eq("org_id", resolvedOrgId)
      .eq("contract_id", sovState.summary.contract_id)
      .order("application_number", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (maxError) {
      throw new Error(`Failed to number pay application: ${maxError.message}`)
    }
    const nextNumber = Number(maxRow?.application_number ?? 0) + 1

    const { data, error } = await supabase
      .from("pay_applications")
      .insert({
        org_id: resolvedOrgId,
        project_id: projectId,
        contract_id: sovState.summary.contract_id,
        application_number: nextNumber,
        period_start: parsed.period_start ?? null,
        period_end: parsed.period_end,
        billing_period_id: billingPeriod?.id ?? null,
        status: "draft",
        metadata: { current_retainage_cents: 0 },
      })
      .select(PAY_APP_SELECT)
      .single()

    if (!error && data) {
      appRow = data
      break
    }
    if (error?.code !== "23505") {
      throw new Error(`Failed to create pay application: ${error?.message}`)
    }
  }
  if (!appRow) {
    throw new Error("Failed to allocate a pay application number. Try again.")
  }

  const seedLines = sovState.lines.map((line) => ({
    org_id: resolvedOrgId,
    pay_application_id: appRow!.id,
    prime_sov_line_id: line.id,
    scheduled_value_cents: line.scheduled_value_cents,
    previous_billed_cents: line.previous_billed_cents,
    this_period_cents: 0,
    stored_materials_cents: line.stored_materials_cents,
    percent_complete:
      line.scheduled_value_cents > 0
        ? Math.round((line.previous_billed_cents / line.scheduled_value_cents) * 10000) / 100
        : 0,
    balance_to_finish_cents: line.scheduled_value_cents - line.previous_billed_cents - line.stored_materials_cents,
    retainage_cents: 0,
    metadata: { previous_stored_materials_cents: line.stored_materials_cents },
  }))

  const { error: linesError } = await supabase.from("pay_application_lines").insert(seedLines)
  if (linesError) {
    await supabase.from("pay_applications").delete().eq("org_id", resolvedOrgId).eq("id", appRow.id)
    throw new Error(`Failed to seed pay application lines: ${linesError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "pay_application",
    entityId: appRow.id as string,
    after: { project_id: projectId, application_number: appRow.application_number, period_end: parsed.period_end },
  })

  return buildDetail(supabase, resolvedOrgId, appRow, { sovLines: sovState.lines })
}

export async function deletePayApplication(payApplicationId: string, orgId?: string): Promise<{ success: true }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    resourceId: payApplicationId,
  })
  if (appRow.status !== "draft") {
    throw new Error("Only draft pay applications can be deleted. Void submitted applications instead.")
  }

  const { error } = await supabase.from("pay_applications").delete().eq("org_id", resolvedOrgId).eq("id", payApplicationId)
  if (error) {
    throw new Error(`Failed to delete pay application: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "pay_application",
    entityId: payApplicationId,
    before: { application_number: appRow.application_number, project_id: appRow.project_id },
  })
  return { success: true }
}

export async function updatePayApplicationLines(
  payApplicationId: string,
  input: { entries: PayApplicationLineEntry[]; allow_overbilling?: boolean },
  orgId?: string,
): Promise<PayApplicationDetail> {
  const parsed = payApplicationLinesUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    resourceId: payApplicationId,
  })
  if (appRow.status !== "draft") {
    throw new Error("This pay application has been submitted and is frozen. Void it to make changes.")
  }

  const [lineRows, contract] = await Promise.all([
    loadApplicationLines(supabase, resolvedOrgId, payApplicationId),
    getProgressBillingContract(supabase, resolvedOrgId, appRow.project_id as string),
  ])
  if (!contract) {
    throw new Error("Billing contract not found")
  }

  const { data: sovRows, error: sovError } = await supabase
    .from("prime_sov_lines")
    .select("id, retainage_percent_override, line_number")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", appRow.contract_id)
  if (sovError) {
    throw new Error(`Failed to load schedule of values: ${sovError.message}`)
  }
  const sovById = new Map((sovRows ?? []).map((row) => [row.id as string, row]))
  const lineBySovId = new Map(lineRows.map((row) => [row.prime_sov_line_id as string, row]))

  const config = retainageConfigFromContract(contract)
  const overbilledLines: number[] = []

  for (const entry of parsed.entries) {
    const lineRow = lineBySovId.get(entry.prime_sov_line_id)
    const sovLine = sovById.get(entry.prime_sov_line_id)
    if (!lineRow || !sovLine) {
      throw new Error("Pay application line does not match the schedule of values")
    }

    const scheduled = Number(lineRow.scheduled_value_cents ?? 0)
    const previousBilled = Number(lineRow.previous_billed_cents ?? 0)
    const previousStored = Number((lineRow.metadata as Record<string, any> | null)?.previous_stored_materials_cents ?? 0)

    const thisPeriod =
      entry.this_period_cents != null
        ? entry.this_period_cents
        : thisPeriodFromPercentComplete({
            scheduledValueCents: scheduled,
            percentComplete: entry.percent_complete ?? 0,
            previousBilledCents: previousBilled,
          })
    if (previousBilled + thisPeriod < 0) {
      throw new Error(`Line ${sovLine.line_number}: this period cannot reduce billed-to-date below zero`)
    }

    const percentAfter = scheduled > 0 ? ((previousBilled + thisPeriod) / scheduled) * 100 : 0
    const workRate = resolveRetainageRatePercent({
      percentComplete: percentAfter,
      schedule: config.schedule,
      lineOverridePercent: sovLine.retainage_percent_override != null ? Number(sovLine.retainage_percent_override) : null,
      contractPercent: config.contract_percent,
    })
    const storedRate = config.stored_materials_percent ?? workRate

    const computed = computePayAppLine({
      scheduledValueCents: scheduled,
      previousBilledCents: previousBilled,
      thisPeriodCents: thisPeriod,
      storedMaterialsCents: entry.stored_materials_cents,
      previousStoredMaterialsCents: previousStored,
      workRetainagePercent: workRate,
      storedMaterialsRetainagePercent: storedRate,
    })
    if (computed.overbilled) {
      overbilledLines.push(Number(sovLine.line_number))
    }

    const { error: updateError } = await supabase
      .from("pay_application_lines")
      .update({
        this_period_cents: computed.thisPeriodCents,
        stored_materials_cents: computed.storedMaterialsCents,
        percent_complete: computed.percentComplete,
        balance_to_finish_cents: computed.balanceToFinishCents,
        retainage_cents: computed.retainageCents,
        metadata: {
          ...((lineRow.metadata as Record<string, any> | null) ?? {}),
          overbilled: computed.overbilled ? true : undefined,
          work_retainage_percent: workRate,
          stored_retainage_percent: storedRate,
        },
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", lineRow.id)
    if (updateError) {
      throw new Error(`Failed to save pay application line: ${updateError.message}`)
    }
  }

  if (overbilledLines.length > 0 && !parsed.allow_overbilling) {
    throw new Error(
      `Line${overbilledLines.length > 1 ? "s" : ""} ${overbilledLines.join(", ")} would bill past the scheduled value. Confirm overbilling to continue.`,
    )
  }

  // Refresh the draft retainage total so the invoice context always matches
  // the saved lines.
  const refreshedLines = await loadApplicationLines(supabase, resolvedOrgId, payApplicationId)
  const currentRetainage = refreshedLines.reduce((sum, row) => sum + Number(row.retainage_cents ?? 0), 0)
  const { error: appUpdateError } = await supabase
    .from("pay_applications")
    .update({
      metadata: {
        ...((appRow.metadata as Record<string, any> | null) ?? {}),
        current_retainage_cents: currentRetainage,
        overbilled: overbilledLines.length > 0 ? true : undefined,
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", payApplicationId)
  if (appUpdateError) {
    throw new Error(`Failed to update pay application totals: ${appUpdateError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    after: { entries: parsed.entries.length, current_retainage_cents: currentRetainage },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow)
}

export async function submitPayApplication(payApplicationId: string, orgId?: string): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  const projectId = appRow.project_id as string
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId,
    resourceId: payApplicationId,
  })
  if (appRow.status !== "draft") {
    throw new Error("This pay application has already been submitted.")
  }

  const [lineRows, sovState, contract, previousCertificates, changeOrderSum] = await Promise.all([
    loadApplicationLines(supabase, resolvedOrgId, payApplicationId),
    listPrimeSovLines(projectId, resolvedOrgId),
    getProgressBillingContract(supabase, resolvedOrgId, projectId),
    sumPreviousCertificates(supabase, resolvedOrgId, appRow.contract_id as string, payApplicationId),
    sumApprovedChangeOrders(supabase, resolvedOrgId, projectId),
  ])
  if (!contract) {
    throw new Error("Billing contract not found")
  }

  const sovById = new Map(sovState.lines.map((line) => [line.id, line]))
  const activeLines = lineRows.filter((row) => {
    const storedDelta =
      Number(row.stored_materials_cents ?? 0) -
      Number((row.metadata as Record<string, any> | null)?.previous_stored_materials_cents ?? 0)
    return Number(row.this_period_cents ?? 0) !== 0 || storedDelta !== 0
  })
  if (activeLines.length === 0) {
    throw new Error("Enter work completed or stored materials before submitting.")
  }

  const heldNet = sovState.lines.reduce((sum, line) => sum + line.retainage_held_cents - line.retainage_released_cents, 0)
  const summary = computePayAppSummary({
    originalContractSumCents: resolveOriginalContractSum(contract),
    changeOrderSumCents: changeOrderSum,
    previousRetainageHeldCents: heldNet,
    previousCertificatesCents: previousCertificates,
    lines: lineRows.map(computedFromRow),
  })

  // The invoice context reads this to size the retainage negative line.
  const { error: metaError } = await supabase
    .from("pay_applications")
    .update({
      metadata: {
        ...((appRow.metadata as Record<string, any> | null) ?? {}),
        current_retainage_cents: summary.currentRetainageCents,
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", payApplicationId)
  if (metaError) {
    throw new Error(`Failed to stage pay application retainage: ${metaError.message}`)
  }

  const invoiceLines = activeLines.map((row) => {
    const sovLine = sovById.get(row.prime_sov_line_id as string)
    const storedDelta =
      Number(row.stored_materials_cents ?? 0) -
      Number((row.metadata as Record<string, any> | null)?.previous_stored_materials_cents ?? 0)
    const amountCents = Number(row.this_period_cents ?? 0) + storedDelta
    return {
      cost_code_id: sovLine?.cost_code_id ?? undefined,
      description: `${sovLine?.line_number ?? ""}. ${sovLine?.description ?? "SOV line"}`.trim(),
      quantity: 1,
      unit: "sov",
      unit_cost: amountCents / 100,
      taxable: false,
    }
  })

  const applicationNumber = Number(appRow.application_number)
  const numbering = await getNextInvoiceNumber(resolvedOrgId)
  const today = new Date().toISOString().slice(0, 10)

  const invoice = await createInvoice({
    input: {
      project_id: projectId,
      invoice_number: numbering.number,
      reservation_id: numbering.reservation_id,
      title: `Pay Application #${applicationNumber}`,
      status: "saved",
      issue_date: today,
      client_visible: false,
      tax_rate: 0,
      lines: invoiceLines,
      source_type: "pay_application",
      source_pay_application_id: payApplicationId,
    },
    orgId: resolvedOrgId,
  })

  const { error: rpcError } = await supabase.rpc("post_pay_application", {
    p_org_id: resolvedOrgId,
    p_pay_application_id: payApplicationId,
    p_invoice_id: invoice.id,
    p_summary: {
      original_contract_sum_cents: resolveOriginalContractSum(contract),
      change_order_sum_cents: changeOrderSum,
      contract_sum_to_date_cents: summary.contractSumToDateCents,
      total_completed_stored_cents: summary.totalCompletedStoredCents,
      retainage_cents: summary.retainageCents,
      total_earned_less_retainage_cents: summary.totalEarnedLessRetainageCents,
      previous_certificates_cents: summary.previousCertificatesCents,
      current_payment_due_cents: summary.currentPaymentDueCents,
      balance_to_finish_cents: summary.balanceToFinishCents,
      metadata: { current_retainage_cents: summary.currentRetainageCents },
    },
  })
  if (rpcError) {
    // Compensate: the invoice must not survive a failed posting.
    await voidInvoice({ invoiceId: invoice.id, orgId: resolvedOrgId }).catch(() => undefined)
    throw new Error(`Failed to post pay application: ${rpcError.message}`)
  }

  if (appRow.billing_period_id) {
    try {
      await linkInvoiceToBillingPeriod({
        supabase,
        orgId: resolvedOrgId,
        projectId,
        billingPeriodId: appRow.billing_period_id as string,
        invoiceId: invoice.id,
        costIds: [],
      })
    } catch {
      // Billing-period linkage is bookkeeping, not a submit blocker.
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "pay_application.submitted",
    entityType: "pay_application",
    entityId: payApplicationId,
    payload: {
      project_id: projectId,
      application_number: applicationNumber,
      current_payment_due_cents: summary.currentPaymentDueCents,
    },
  })
  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "pay_application.invoiced",
    entityType: "pay_application",
    entityId: payApplicationId,
    payload: { project_id: projectId, invoice_id: invoice.id, invoice_number: invoice.invoice_number },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    after: {
      status: "invoiced",
      invoice_id: invoice.id,
      current_payment_due_cents: summary.currentPaymentDueCents,
      retainage_cents: summary.retainageCents,
    },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow)
}

export async function markPayApplicationApproved(payApplicationId: string, orgId?: string): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    resourceId: payApplicationId,
  })
  if (appRow.status !== "invoiced" && appRow.status !== "submitted") {
    throw new Error("Only submitted pay applications can be marked approved.")
  }

  const { error } = await supabase
    .from("pay_applications")
    .update({ approved_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId)
    .eq("id", payApplicationId)
  if (error) {
    throw new Error(`Failed to record owner approval: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    after: { approved_at: new Date().toISOString() },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow)
}

export async function voidPayApplication(payApplicationId: string, orgId?: string): Promise<PayApplicationDetail> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const appRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  await requirePayAppPermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: appRow.project_id as string,
    resourceId: payApplicationId,
  })

  const { error: rpcError } = await supabase.rpc("void_pay_application", {
    p_org_id: resolvedOrgId,
    p_pay_application_id: payApplicationId,
  })
  if (rpcError) {
    throw new Error(`Failed to void pay application: ${rpcError.message}`)
  }

  if (appRow.invoice_id) {
    await voidInvoice({ invoiceId: appRow.invoice_id as string, orgId: resolvedOrgId })
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "pay_application.voided",
    entityType: "pay_application",
    entityId: payApplicationId,
    payload: { project_id: appRow.project_id, application_number: appRow.application_number },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: payApplicationId,
    after: { status: "void" },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, payApplicationId)
  return buildDetail(supabase, resolvedOrgId, freshRow)
}

/**
 * Release held retainage on a progress-billing contract: creates a
 * retainage-release pay application + release invoice, distributes the
 * release across SOV lines, and moves the `retainage` mirror rows to
 * invoiced with the release invoice attached.
 */
export async function releasePrimeRetainage(
  projectId: string,
  input: RetainageReleaseInput,
  orgId?: string,
): Promise<PayApplicationDetail> {
  const parsed = retainageReleaseInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePayAppPermission({ supabase, orgId: resolvedOrgId, userId, projectId })

  const sovState = await listPrimeSovLines(projectId, resolvedOrgId)
  if (!sovState.summary) {
    throw new Error("This project has no progress-billing contract")
  }
  const availableCents = sovState.summary.retainage_held_cents - sovState.summary.retainage_released_cents
  const amountCents = parsed.full ? availableCents : parsed.amount_cents ?? 0
  if (amountCents <= 0) {
    throw new Error("Enter a release amount")
  }
  if (amountCents > availableCents) {
    throw new Error(`Only ${(availableCents / 100).toFixed(2)} of retainage is available to release`)
  }

  const contractId = sovState.summary.contract_id
  const previousCertificates = await sumPreviousCertificates(supabase, resolvedOrgId, contractId)

  const { data: openDraft } = await supabase
    .from("pay_applications")
    .select("id, application_number")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", contractId)
    .eq("status", "draft")
    .limit(1)
    .maybeSingle()
  if (openDraft) {
    throw new Error(`Application #${openDraft.application_number} is still a draft. Submit or delete it before releasing retainage.`)
  }

  let appRow: PayAppRow | null = null
  for (let attempt = 0; attempt < INSERT_RETRY_LIMIT && !appRow; attempt += 1) {
    const { data: maxRow } = await supabase
      .from("pay_applications")
      .select("application_number")
      .eq("org_id", resolvedOrgId)
      .eq("contract_id", contractId)
      .order("application_number", { ascending: false })
      .limit(1)
      .maybeSingle()
    const nextNumber = Number(maxRow?.application_number ?? 0) + 1

    const { data, error } = await supabase
      .from("pay_applications")
      .insert({
        org_id: resolvedOrgId,
        project_id: projectId,
        contract_id: contractId,
        application_number: nextNumber,
        period_end: new Date().toISOString().slice(0, 10),
        status: "draft",
        metadata: { type: "retainage_release", release_amount_cents: amountCents, current_retainage_cents: 0 },
      })
      .select(PAY_APP_SELECT)
      .single()
    if (!error && data) {
      appRow = data
      break
    }
    if (error?.code !== "23505") {
      throw new Error(`Failed to create retainage release: ${error?.message}`)
    }
  }
  if (!appRow) {
    throw new Error("Failed to allocate a pay application number. Try again.")
  }

  const numbering = await getNextInvoiceNumber(resolvedOrgId)
  const invoice = await createInvoice({
    input: {
      project_id: projectId,
      invoice_number: numbering.number,
      reservation_id: numbering.reservation_id,
      title: `Retainage Release — Application #${appRow.application_number}`,
      status: "saved",
      issue_date: new Date().toISOString().slice(0, 10),
      client_visible: false,
      tax_rate: 0,
      lines: [
        {
          description: "Retainage release",
          quantity: 1,
          unit: "retainage_release",
          unit_cost: amountCents / 100,
          taxable: false,
        },
      ],
      source_type: "pay_application",
      source_pay_application_id: appRow.id as string,
    },
    orgId: resolvedOrgId,
  })

  const { error: releaseError } = await supabase.rpc("release_prime_sov_retainage", {
    p_org_id: resolvedOrgId,
    p_contract_id: contractId,
    p_amount_cents: amountCents,
  })
  if (releaseError) {
    await voidInvoice({ invoiceId: invoice.id, orgId: resolvedOrgId }).catch(() => undefined)
    await supabase.from("pay_applications").delete().eq("org_id", resolvedOrgId).eq("id", appRow.id)
    throw new Error(`Failed to release retainage: ${releaseError.message}`)
  }

  const completedStored = sovState.lines.reduce(
    (sum, line) => sum + line.previous_billed_cents + line.stored_materials_cents,
    0,
  )
  const retainageAfter = availableCents - amountCents
  const { error: postError } = await supabase.rpc("post_pay_application", {
    p_org_id: resolvedOrgId,
    p_pay_application_id: appRow.id,
    p_invoice_id: invoice.id,
    p_summary: {
      original_contract_sum_cents: resolveOriginalContractSum(
        await getProgressBillingContract(supabase, resolvedOrgId, projectId),
      ),
      change_order_sum_cents: await sumApprovedChangeOrders(supabase, resolvedOrgId, projectId),
      contract_sum_to_date_cents: sovState.summary.contract_sum_cents,
      total_completed_stored_cents: completedStored,
      retainage_cents: retainageAfter,
      total_earned_less_retainage_cents: completedStored - retainageAfter,
      previous_certificates_cents: previousCertificates,
      current_payment_due_cents: amountCents,
      balance_to_finish_cents: sovState.summary.contract_sum_cents - completedStored,
      metadata: { type: "retainage_release", release_amount_cents: amountCents, current_retainage_cents: 0 },
    },
  })
  if (postError) {
    throw new Error(
      `Retainage was released on the SOV but the release application failed to post: ${postError.message}. Contact support before retrying.`,
    )
  }

  // Move the retainage mirror rows (held on each source invoice) to invoiced,
  // splitting the oldest row when the release is partial.
  let remaining = amountCents
  const { data: heldRows, error: heldError } = await supabase
    .from("retainage")
    .select("id, amount_cents, invoice_id")
    .eq("org_id", resolvedOrgId)
    .eq("contract_id", contractId)
    .eq("status", "held")
    .order("created_at", { ascending: true })
  if (heldError) {
    throw new Error(`Failed to load held retainage records: ${heldError.message}`)
  }
  const now = new Date().toISOString()
  for (const row of heldRows ?? []) {
    if (remaining <= 0) break
    const rowAmount = Number(row.amount_cents ?? 0)
    const take = Math.min(remaining, rowAmount)
    if (take === rowAmount) {
      const { error } = await supabase
        .from("retainage")
        .update({ status: "invoiced", release_invoice_id: invoice.id, released_at: now })
        .eq("org_id", resolvedOrgId)
        .eq("id", row.id)
      if (error) throw new Error(`Failed to update retainage record: ${error.message}`)
    } else {
      const { error: shrinkError } = await supabase
        .from("retainage")
        .update({ amount_cents: rowAmount - take })
        .eq("org_id", resolvedOrgId)
        .eq("id", row.id)
      if (shrinkError) throw new Error(`Failed to split retainage record: ${shrinkError.message}`)
      const { error: insertError } = await supabase.from("retainage").insert({
        org_id: resolvedOrgId,
        project_id: projectId,
        contract_id: contractId,
        invoice_id: row.invoice_id,
        amount_cents: take,
        status: "invoiced",
        release_invoice_id: invoice.id,
        released_at: now,
      })
      if (insertError) throw new Error(`Failed to record released retainage: ${insertError.message}`)
    }
    remaining -= take
  }

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "retainage.released",
    entityType: "pay_application",
    entityId: appRow.id as string,
    payload: { project_id: projectId, amount_cents: amountCents, invoice_id: invoice.id },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "pay_application",
    entityId: appRow.id as string,
    after: { type: "retainage_release", amount_cents: amountCents, invoice_id: invoice.id },
  })

  const freshRow = await loadApplication(supabase, resolvedOrgId, appRow.id as string)
  return buildDetail(supabase, resolvedOrgId, freshRow)
}
