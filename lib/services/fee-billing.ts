import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import type { Invoice } from "@/lib/types"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createInvoice, getInvoiceWithLines } from "@/lib/services/invoices"
import { getNextInvoiceNumber, markReservationUsed } from "@/lib/services/invoice-numbers"
import { getProjectJobCostActualsByCostCode } from "@/lib/services/job-cost-actuals"
import { applyRetainageToInvoice } from "@/lib/services/retainage"

export type FeeScheduleStatus = "draft" | "active" | "closed" | "voided"
export type FeeLineStatus = "planned" | "earned" | "unbilled" | "partially_billed" | "billed" | "voided"

export interface ProjectFeeSchedule {
  id: string
  org_id: string
  project_id: string
  contract_id?: string | null
  name: string
  status: FeeScheduleStatus
  fee_basis: "fixed_fee" | "percent_of_costs" | "manual"
  earned_calculation: "percent_complete" | "manual" | "milestone"
  total_fee_cents: number
  currency: string
  metadata: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface ProjectFeeScheduleLine {
  id: string
  org_id: string
  project_id: string
  schedule_id: string
  billing_period_id?: string | null
  invoice_id?: string | null
  invoice_line_id?: string | null
  name: string
  description?: string | null
  status: FeeLineStatus
  scheduled_fee_cents: number
  earned_fee_cents: number
  billed_fee_cents: number
  percent_complete: number
  earned_at?: string | null
  billed_at?: string | null
  sort_order: number
  metadata: Record<string, any>
  effective_earned_fee_cents?: number
  billable_fee_cents?: number
}

export interface ProjectFeeBillingSummary {
  enabled: boolean
  reason?: string
  billing_model?: string | null
  schedule?: ProjectFeeSchedule | null
  lines: ProjectFeeScheduleLine[]
  total_fee_cents: number
  earned_fee_cents: number
  billed_fee_cents: number
  remaining_fee_cents: number
  billable_fee_cents: number
  project_percent_complete: number
  total_actual_cents: number
  total_eac_cents: number
}

const CONTRACT_TERMS_FEE_SCHEDULE_ID = "00000000-0000-0000-0000-000000000000"
const CONTRACT_TERMS_FEE_LINE_ID = "00000000-0000-0000-0000-000000000001"

const updateFeeProgressSchema = z.object({
  projectId: z.string().uuid(),
  scheduleId: z.string().uuid(),
  percentComplete: z.number().min(0).max(100).optional(),
  totalFeeCents: z.number().int().nonnegative().optional(),
})

const createFeeInvoiceSchema = z.object({
  projectId: z.string().uuid(),
  scheduleId: z.string().uuid().optional(),
  amountCents: z.number().int().positive().optional(),
  issueDate: z.string().optional(),
  dueDate: z.string().optional(),
  billingPeriodId: z.string().uuid().optional().nullable(),
  status: z.enum(["draft", "saved", "sent"]).default("saved"),
  clientVisible: z.boolean().default(false),
})

export type UpdateFeeProgressInput = z.infer<typeof updateFeeProgressSchema>
export type CreateFeeInvoiceInput = z.infer<typeof createFeeInvoiceSchema>

export interface PreparedProjectFeeBilling {
  summary: ProjectFeeBillingSummary
  amountCents: number
  allocations: Array<{ line_id: string; amount_cents: number }>
}

function toNumber(value: unknown, fallback = 0) {
  const next = Number(value ?? fallback)
  return Number.isFinite(next) ? next : fallback
}

function mapSchedule(row: any): ProjectFeeSchedule {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    contract_id: row.contract_id ?? null,
    name: row.name,
    status: row.status,
    fee_basis: row.fee_basis,
    earned_calculation: row.earned_calculation,
    total_fee_cents: Number(row.total_fee_cents ?? 0),
    currency: row.currency ?? "usd",
    metadata: row.metadata ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapLine(row: any): ProjectFeeScheduleLine {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    schedule_id: row.schedule_id,
    billing_period_id: row.billing_period_id ?? null,
    invoice_id: row.invoice_id ?? null,
    invoice_line_id: row.invoice_line_id ?? null,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    scheduled_fee_cents: Number(row.scheduled_fee_cents ?? 0),
    earned_fee_cents: Number(row.earned_fee_cents ?? 0),
    billed_fee_cents: Number(row.billed_fee_cents ?? 0),
    percent_complete: Number(row.percent_complete ?? 0),
    earned_at: row.earned_at ?? null,
    billed_at: row.billed_at ?? null,
    sort_order: Number(row.sort_order ?? 0),
    metadata: row.metadata ?? {},
  }
}

async function requireFeePermission(args: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  permission: "invoice.read" | "invoice.write"
  resourceId?: string
}) {
  await requireAuthorization({
    permission: args.permission,
    userId: args.userId,
    orgId: args.orgId,
    projectId: args.projectId,
    supabase: args.supabase,
    logDecision: true,
    resourceType: "project_fee_schedule",
    resourceId: args.resourceId,
  })
}

async function loadProjectFeeContext(args: { supabase: SupabaseClient; orgId: string; projectId: string }) {
  const [settingsResult, contractResult, projectResult] = await Promise.all([
    args.supabase
      .from("project_financial_settings")
      .select("billing_model, metadata")
      .eq("org_id", args.orgId)
      .eq("project_id", args.projectId)
      .maybeSingle(),
    args.supabase
      .from("contracts")
      .select("id, title, status, total_cents, fixed_fee_cents, retainage_percent, snapshot")
      .eq("org_id", args.orgId)
      .eq("project_id", args.projectId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    args.supabase
      .from("projects")
      .select("id, name, qbo_customer_id, qbo_customer_name")
      .eq("org_id", args.orgId)
      .eq("id", args.projectId)
      .maybeSingle(),
  ])

  if (settingsResult.error) throw new Error(`Failed to load project financial settings: ${settingsResult.error.message}`)
  if (contractResult.error) throw new Error(`Failed to load project contract: ${contractResult.error.message}`)
  if (projectResult.error || !projectResult.data) throw new Error("Project not found")

  const settings = settingsResult.data
  const contract = contractResult.data
  const fixedFeeCents =
    Number(contract?.fixed_fee_cents ?? contract?.snapshot?.fixed_fee_cents ?? settings?.metadata?.fixed_fee_cents ?? 0) || 0

  return {
    settings,
    contract,
    project: projectResult.data,
    billingModel: settings?.billing_model ?? contract?.snapshot?.billing_model ?? null,
    fixedFeeCents,
  }
}

async function estimateProjectPercentComplete(args: { supabase: SupabaseClient; orgId: string; projectId: string }) {
  const [budgetResult, actuals] = await Promise.all([
    args.supabase
      .from("budgets")
      .select("total_cents")
      .eq("org_id", args.orgId)
      .eq("project_id", args.projectId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    getProjectJobCostActualsByCostCode({ projectId: args.projectId, orgId: args.orgId, supabase: args.supabase }),
  ])

  if (budgetResult.error) throw new Error(`Failed to load budget for fee earned calculation: ${budgetResult.error.message}`)

  const totalActualCents = actuals.reduce((sum, row) => sum + row.actual_cents, 0)
  const budgetCents = Number(budgetResult.data?.total_cents ?? 0)
  const totalEacCents = Math.max(budgetCents, totalActualCents)
  const percentComplete = totalEacCents > 0 ? Math.min(100, Math.max(0, (totalActualCents / totalEacCents) * 100)) : 0

  return {
    project_percent_complete: percentComplete,
    total_actual_cents: totalActualCents,
    total_eac_cents: totalEacCents,
  }
}

async function loadActiveSchedule(args: { supabase: SupabaseClient; orgId: string; projectId: string }) {
  const { data, error } = await args.supabase
    .from("project_fee_schedules")
    .select("*")
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .in("status", ["draft", "active"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Failed to load project fee schedule: ${error.message}`)
  return data ? mapSchedule(data) : null
}

function buildContractTermsSchedule(args: {
  orgId: string
  projectId: string
  context: Awaited<ReturnType<typeof loadProjectFeeContext>>
}): { schedule: ProjectFeeSchedule; lines: ProjectFeeScheduleLine[] } {
  const now = new Date().toISOString()
  return {
    schedule: {
      id: CONTRACT_TERMS_FEE_SCHEDULE_ID,
      org_id: args.orgId,
      project_id: args.projectId,
      contract_id: args.context.contract?.id ?? null,
      name: "Construction management fee",
      status: "active",
      fee_basis: "fixed_fee",
      earned_calculation: "percent_complete",
      total_fee_cents: args.context.fixedFeeCents,
      currency: "usd",
      metadata: {
        source: "contract_fixed_fee",
        materialized: false,
        contract_title: args.context.contract?.title ?? null,
      },
      created_at: now,
      updated_at: now,
    },
    lines: [
      {
        id: CONTRACT_TERMS_FEE_LINE_ID,
        org_id: args.orgId,
        project_id: args.projectId,
        schedule_id: CONTRACT_TERMS_FEE_SCHEDULE_ID,
        name: "Construction management fee",
        description: "Fixed construction management fee",
        status: "unbilled",
        scheduled_fee_cents: args.context.fixedFeeCents,
        earned_fee_cents: 0,
        billed_fee_cents: 0,
        percent_complete: 0,
        sort_order: 0,
        metadata: { source: "contract_fixed_fee", materialized: false },
      },
    ],
  }
}

async function materializeContractFeeSchedule(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  userId?: string | null
}) {
  const context = await loadProjectFeeContext(args)
  if (context.billingModel !== "cost_plus_fixed_fee") {
    return {
      enabled: false,
      reason: "Fee billing is only enabled for cost-plus fixed-fee projects.",
      context,
      schedule: null,
    }
  }

  if (context.fixedFeeCents <= 0) {
    return {
      enabled: false,
      reason: "Cost-plus fixed-fee setup needs a fixed fee amount before fee billing can run.",
      context,
      schedule: null,
    }
  }

  const existing = await loadActiveSchedule(args)
  if (existing) {
    const existingLines = await loadScheduleLines({ supabase: args.supabase, orgId: args.orgId, scheduleId: existing.id })
    if (existingLines.length === 0) {
      const { error: lineError } = await args.supabase.from("project_fee_schedule_lines").insert({
        org_id: args.orgId,
        project_id: args.projectId,
        schedule_id: existing.id,
        name: "Construction management fee",
        description: "Fixed construction management fee",
        status: "unbilled",
        scheduled_fee_cents: existing.total_fee_cents || context.fixedFeeCents,
        earned_fee_cents: 0,
        billed_fee_cents: 0,
        percent_complete: 0,
        sort_order: 0,
        created_by: args.userId ?? null,
        updated_by: args.userId ?? null,
        metadata: { source: "contract_fixed_fee" },
      })
      if (lineError) throw new Error(`Failed to create default fee line: ${lineError.message}`)
    }
    return { enabled: true, context, schedule: existing, reason: undefined }
  }

  const payload = {
    org_id: args.orgId,
    project_id: args.projectId,
    contract_id: context.contract?.id ?? null,
    name: "Construction management fee",
    status: "active",
    fee_basis: "fixed_fee",
    earned_calculation: "percent_complete",
    total_fee_cents: context.fixedFeeCents,
    currency: "usd",
    updated_by: args.userId ?? null,
    created_by: args.userId ?? null,
    metadata: {
      source: "contract_fixed_fee",
      contract_title: context.contract?.title ?? null,
      materialized_from_contract_at: new Date().toISOString(),
    },
  }

  const { data: scheduleRow, error } = await args.supabase.from("project_fee_schedules").insert(payload).select("*").single()

  if (error || !scheduleRow) throw new Error(`Failed to materialize project fee schedule: ${error?.message}`)
  const schedule = mapSchedule(scheduleRow)

  const { data: lines, error: linesError } = await args.supabase
    .from("project_fee_schedule_lines")
    .select("id")
    .eq("org_id", args.orgId)
    .eq("schedule_id", schedule.id)
    .neq("status", "voided")

  if (linesError) throw new Error(`Failed to load project fee schedule lines: ${linesError.message}`)

  if ((lines ?? []).length === 0) {
    const { error: lineError } = await args.supabase.from("project_fee_schedule_lines").insert({
      org_id: args.orgId,
      project_id: args.projectId,
      schedule_id: schedule.id,
      name: "Construction management fee",
      description: "Fixed construction management fee",
      status: "unbilled",
      scheduled_fee_cents: context.fixedFeeCents,
      earned_fee_cents: 0,
      billed_fee_cents: 0,
      percent_complete: 0,
      sort_order: 0,
      created_by: args.userId ?? null,
      updated_by: args.userId ?? null,
      metadata: { source: "contract_fixed_fee" },
    })

    if (lineError) throw new Error(`Failed to create default fee line: ${lineError.message}`)
  }

  return { enabled: true, context, schedule, reason: undefined }
}

async function loadScheduleLines(args: { supabase: SupabaseClient; orgId: string; scheduleId: string }) {
  const { data, error } = await args.supabase
    .from("project_fee_schedule_lines")
    .select("*")
    .eq("org_id", args.orgId)
    .eq("schedule_id", args.scheduleId)
    .neq("status", "voided")
    .order("sort_order", { ascending: true })

  if (error) throw new Error(`Failed to load fee schedule lines: ${error.message}`)
  return (data ?? []).map(mapLine)
}

function summarizeFeeSchedule(args: {
  enabled: boolean
  reason?: string
  billingModel?: string | null
  schedule?: ProjectFeeSchedule | null
  lines: ProjectFeeScheduleLine[]
  progress: Awaited<ReturnType<typeof estimateProjectPercentComplete>>
}): ProjectFeeBillingSummary {
  const totalFeeCents = args.schedule?.total_fee_cents ?? 0
  const lines = args.lines.map((line) => {
    const effectivePercent = line.percent_complete > 0 ? line.percent_complete : args.progress.project_percent_complete
    const effectiveEarned = Math.min(line.scheduled_fee_cents, Math.max(line.earned_fee_cents, Math.round(line.scheduled_fee_cents * (effectivePercent / 100))))
    return {
      ...line,
      effective_earned_fee_cents: effectiveEarned,
      billable_fee_cents: Math.max(0, effectiveEarned - line.billed_fee_cents),
    }
  })
  const earnedFeeCents = Math.min(totalFeeCents, lines.reduce((sum, line) => sum + (line.effective_earned_fee_cents ?? 0), 0))
  const billedFeeCents = lines.reduce((sum, line) => sum + line.billed_fee_cents, 0)

  return {
    enabled: args.enabled,
    reason: args.reason,
    billing_model: args.billingModel,
    schedule: args.schedule ?? null,
    lines,
    total_fee_cents: totalFeeCents,
    earned_fee_cents: earnedFeeCents,
    billed_fee_cents: billedFeeCents,
    remaining_fee_cents: Math.max(0, totalFeeCents - billedFeeCents),
    billable_fee_cents: Math.max(0, earnedFeeCents - billedFeeCents),
    project_percent_complete: args.progress.project_percent_complete,
    total_actual_cents: args.progress.total_actual_cents,
    total_eac_cents: args.progress.total_eac_cents,
  }
}

export async function getProjectFeeBillingSummary(projectId: string, orgId?: string): Promise<ProjectFeeBillingSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireFeePermission({ supabase, orgId: resolvedOrgId, userId, projectId, permission: "invoice.read" })

  const [context, schedule, progress] = await Promise.all([
    loadProjectFeeContext({ supabase, orgId: resolvedOrgId, projectId }),
    loadActiveSchedule({ supabase, orgId: resolvedOrgId, projectId }),
    estimateProjectPercentComplete({ supabase, orgId: resolvedOrgId, projectId }),
  ])

  if (context.billingModel !== "cost_plus_fixed_fee") {
    return summarizeFeeSchedule({
      enabled: false,
      reason: "Fee billing is only enabled for cost-plus fixed-fee projects.",
      billingModel: context.billingModel,
      schedule: null,
      lines: [],
      progress,
    })
  }

  if (context.fixedFeeCents <= 0) {
    return summarizeFeeSchedule({
      enabled: false,
      reason: "Cost-plus fixed-fee setup needs a fixed fee amount before fee billing can run.",
      billingModel: context.billingModel,
      schedule: null,
      lines: [],
      progress,
    })
  }

  if (!schedule) {
    const synthetic = buildContractTermsSchedule({ orgId: resolvedOrgId, projectId, context })
    return summarizeFeeSchedule({
      enabled: true,
      billingModel: context.billingModel,
      schedule: synthetic.schedule,
      lines: synthetic.lines,
      progress,
    })
  }

  const lines = await loadScheduleLines({ supabase, orgId: resolvedOrgId, scheduleId: schedule.id })
  return summarizeFeeSchedule({
    enabled: true,
    billingModel: context.billingModel,
    schedule,
    lines,
    progress,
  })
}

export async function updateProjectFeeProgress(input: UpdateFeeProgressInput, orgId?: string) {
  const parsed = updateFeeProgressSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireFeePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: parsed.projectId,
    permission: "invoice.write",
    resourceId: parsed.scheduleId,
  })

  const materialized = await materializeContractFeeSchedule({ supabase, orgId: resolvedOrgId, projectId: parsed.projectId, userId })
  if (!materialized.enabled || !materialized.schedule) {
    throw new Error(materialized.reason ?? "Fee schedule is not available for this project.")
  }

  const current = await getProjectFeeBillingSummary(parsed.projectId, resolvedOrgId)
  const schedule = current.schedule
  if (
    !current.enabled ||
    !schedule ||
    (schedule.id !== parsed.scheduleId && parsed.scheduleId !== CONTRACT_TERMS_FEE_SCHEDULE_ID)
  ) {
    throw new Error(current.reason ?? "Fee schedule is not available for this project.")
  }

  const nextTotalFeeCents = parsed.totalFeeCents ?? schedule.total_fee_cents
  const nextPercent = parsed.percentComplete ?? null
  const now = new Date().toISOString()

  if (nextTotalFeeCents !== schedule.total_fee_cents) {
    const { error: scheduleError } = await supabase
      .from("project_fee_schedules")
      .update({ total_fee_cents: nextTotalFeeCents, updated_by: userId })
      .eq("org_id", resolvedOrgId)
      .eq("id", schedule.id)

    if (scheduleError) throw new Error(`Failed to update fee schedule: ${scheduleError.message}`)
  }

  const primaryLine = current.lines[0]
  if (primaryLine) {
    const lineTotal = nextTotalFeeCents
    const percentComplete = nextPercent ?? primaryLine.percent_complete
    const earnedFeeCents = Math.min(lineTotal, Math.round(lineTotal * (percentComplete / 100)))
    const nextStatus =
      primaryLine.billed_fee_cents >= lineTotal
        ? "billed"
        : earnedFeeCents > 0
          ? primaryLine.billed_fee_cents > 0
            ? "partially_billed"
            : "earned"
          : "unbilled"

    const { error: lineError } = await supabase
      .from("project_fee_schedule_lines")
      .update({
        scheduled_fee_cents: lineTotal,
        percent_complete: percentComplete,
        earned_fee_cents: earnedFeeCents,
        earned_at: earnedFeeCents > 0 ? (primaryLine.earned_at ?? now) : null,
        status: nextStatus,
        updated_by: userId,
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", primaryLine.id)

    if (lineError) throw new Error(`Failed to update fee progress: ${lineError.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "project_fee_schedule",
    entityId: schedule.id,
    after: { percentComplete: parsed.percentComplete, totalFeeCents: parsed.totalFeeCents },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_fee_progress_updated",
    entityType: "project_fee_schedule",
    entityId: schedule.id,
    payload: { project_id: parsed.projectId, percent_complete: parsed.percentComplete, total_fee_cents: nextTotalFeeCents },
  })

  return getProjectFeeBillingSummary(parsed.projectId, resolvedOrgId)
}

function allocateFeeBilling(lines: ProjectFeeScheduleLine[], amountCents: number) {
  const allocations: Array<{ line_id: string; amount_cents: number }> = []
  let remaining = amountCents
  for (const line of lines) {
    if (remaining <= 0) break
    const available = Math.max(0, (line.effective_earned_fee_cents ?? line.earned_fee_cents) - line.billed_fee_cents)
    if (available <= 0) continue
    const amount = Math.min(available, remaining)
    allocations.push({ line_id: line.id, amount_cents: amount })
    remaining -= amount
  }
  return allocations
}

export async function prepareProjectFeeBillingForOwnerInvoice(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  userId?: string | null
  amountCents?: number | null
}): Promise<PreparedProjectFeeBilling> {
  const materialized = await materializeContractFeeSchedule({
    supabase: args.supabase,
    orgId: args.orgId,
    projectId: args.projectId,
    userId: args.userId,
  })
  if (!materialized.enabled || !materialized.schedule) {
    throw new Error(materialized.reason ?? "Fee billing is not available for this project.")
  }

  const [progress, lines] = await Promise.all([
    estimateProjectPercentComplete({ supabase: args.supabase, orgId: args.orgId, projectId: args.projectId }),
    loadScheduleLines({ supabase: args.supabase, orgId: args.orgId, scheduleId: materialized.schedule.id }),
  ])
  const summary = summarizeFeeSchedule({
    enabled: true,
    billingModel: materialized.context.billingModel,
    schedule: materialized.schedule,
    lines,
    progress,
  })
  const amountCents = args.amountCents ?? summary.billable_fee_cents
  if (amountCents <= 0) {
    throw new Error("No earned fee is available to bill.")
  }
  if (amountCents > summary.billable_fee_cents) {
    throw new Error("Fee invoice amount cannot exceed earned unbilled fee.")
  }

  const allocations = allocateFeeBilling(summary.lines, amountCents)
  if (allocations.length === 0) {
    throw new Error("No fee schedule lines are available to bill.")
  }

  return { summary, amountCents, allocations }
}

export async function recordProjectFeeBillingForInvoice(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  userId?: string | null
  invoiceId: string
  invoiceLineId?: string | null
  billingPeriodId?: string | null
  prepared: PreparedProjectFeeBilling
  source: "fee_invoice" | "approved_cost_invoice"
  invoiceMetadata?: Record<string, any>
}) {
  const now = new Date().toISOString()
  const { summary, amountCents, allocations } = args.prepared

  for (const allocation of allocations) {
    const line = summary.lines.find((item) => item.id === allocation.line_id)
    if (!line) continue
    const nextBilled = line.billed_fee_cents + allocation.amount_cents
    const nextStatus = nextBilled >= line.scheduled_fee_cents ? "billed" : "partially_billed"
    const { error: lineError } = await args.supabase
      .from("project_fee_schedule_lines")
      .update({
        billed_fee_cents: nextBilled,
        invoice_id: args.invoiceId,
        invoice_line_id: args.invoiceLineId ?? null,
        billed_at: now,
        status: nextStatus,
        updated_by: args.userId ?? null,
      })
      .eq("org_id", args.orgId)
      .eq("id", allocation.line_id)

    if (lineError) throw new Error(`Failed to mark fee line billed: ${lineError.message}`)
  }

  const { error: billingError } = await args.supabase.from("project_fee_billings").insert({
    org_id: args.orgId,
    project_id: args.projectId,
    schedule_id: summary.schedule?.id,
    invoice_id: args.invoiceId,
    billing_period_id: args.billingPeriodId ?? null,
    status: "billed",
    fee_line_ids: allocations.map((allocation) => allocation.line_id),
    subtotal_fee_cents: amountCents,
    tax_cents: 0,
    total_fee_cents: amountCents,
    billed_at: now,
    created_by: args.userId ?? null,
    updated_by: args.userId ?? null,
    metadata: {
      allocations,
      source: args.source,
      project_percent_complete: summary.project_percent_complete,
      earned_fee_cents: summary.earned_fee_cents,
      billed_fee_cents_before: summary.billed_fee_cents,
    },
  })

  if (billingError) throw new Error(`Failed to record fee billing: ${billingError.message}`)

  const { data: invoiceRow } = await args.supabase
    .from("invoices")
    .select("metadata")
    .eq("org_id", args.orgId)
    .eq("id", args.invoiceId)
    .maybeSingle()

  const existingMetadata = (invoiceRow?.metadata as Record<string, any> | null) ?? {}
  await args.supabase
    .from("invoices")
    .update({
      billing_period_id: args.billingPeriodId ?? null,
      metadata: {
        ...existingMetadata,
        ...(args.invoiceMetadata ?? {}),
        fee_schedule_id: summary.schedule?.id ?? null,
        fee_line_ids: allocations.map((allocation) => allocation.line_id),
        fee_billing_allocations: allocations,
        earned_fee_cents: amountCents,
      },
    })
    .eq("org_id", args.orgId)
    .eq("id", args.invoiceId)
}

export async function createProjectFeeInvoice(input: CreateFeeInvoiceInput, orgId?: string): Promise<Invoice> {
  const parsed = createFeeInvoiceSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireFeePermission({ supabase, orgId: resolvedOrgId, userId, projectId: parsed.projectId, permission: "invoice.write" })

  const [summary, context] = await Promise.all([
    getProjectFeeBillingSummary(parsed.projectId, resolvedOrgId),
    loadProjectFeeContext({ supabase, orgId: resolvedOrgId, projectId: parsed.projectId }),
  ])

  if (!summary.enabled || !summary.schedule) {
    throw new Error(summary.reason ?? "Fee billing is not available for this project.")
  }
  if (
    parsed.scheduleId &&
    summary.schedule.id !== parsed.scheduleId &&
    parsed.scheduleId !== CONTRACT_TERMS_FEE_SCHEDULE_ID
  ) {
    throw new Error("Selected fee schedule is not active for this project.")
  }

  const amountCents = parsed.amountCents ?? summary.billable_fee_cents
  if (amountCents <= 0) {
    throw new Error("No earned fee is available to bill.")
  }
  if (amountCents > summary.billable_fee_cents) {
    throw new Error("Fee invoice amount cannot exceed earned unbilled fee.")
  }
  const preparedFeeBilling = await prepareProjectFeeBillingForOwnerInvoice({
    supabase,
    orgId: resolvedOrgId,
    projectId: parsed.projectId,
    userId,
    amountCents,
  })

  const nextNumber = await getNextInvoiceNumber(resolvedOrgId)
  const today = new Date().toISOString().slice(0, 10)
  const issueDate = parsed.issueDate ?? today
  const dueDate = parsed.dueDate ?? issueDate
  const status = parsed.status
  const retainFee = context.contract?.snapshot?.retain_fee === true
  const feeRetainagePercent = retainFee ? Number(context.contract?.retainage_percent ?? 0) : 0
  const feeRetainageCents =
    feeRetainagePercent > 0 ? Math.round(Math.max(amountCents, 0) * (feeRetainagePercent / 100)) : 0

  const invoice = await createInvoice({
    orgId: resolvedOrgId,
    input: {
      project_id: parsed.projectId,
      invoice_number: nextNumber.number,
      reservation_id: nextNumber.reservation_id,
      title: "Construction management fee",
      status,
      issue_date: issueDate,
      due_date: dueDate,
      client_visible: parsed.clientVisible || status === "sent",
      tax_rate: 0,
      source_type: "fee",
      customer_name: context.project.qbo_customer_name ?? undefined,
      qbo_customer_id: context.project.qbo_customer_id ?? undefined,
      qbo_customer_name: context.project.qbo_customer_name ?? undefined,
      lines: [
        {
          description: "Construction management fee",
          quantity: 1,
          unit: "fee",
          unit_cost: amountCents / 100,
          taxable: false,
        },
        ...(feeRetainageCents > 0
          ? [
              {
                description: `Retainage held (${feeRetainagePercent}%)`,
                quantity: 1,
                unit: "retainage",
                unit_cost: -Math.abs(feeRetainageCents) / 100,
                taxable: false,
              },
            ]
          : []),
      ],
      notes: "Fixed fee billed separately from reimbursable project costs.",
    },
  })

  if (feeRetainageCents > 0 && context.contract?.id) {
    await applyRetainageToInvoice({
      invoiceId: invoice.id,
      contract_id: context.contract.id,
      amount_cents: feeRetainageCents,
      project_id: parsed.projectId,
      orgId: resolvedOrgId,
    })
  }

  if (nextNumber.reservation_id) {
    await markReservationUsed(nextNumber.reservation_id, invoice.id, resolvedOrgId)
  }

  const freshInvoice = await getInvoiceWithLines(invoice.id, resolvedOrgId)
  const invoiceLineId = freshInvoice?.lines?.[0]?.id ?? null

  await recordProjectFeeBillingForInvoice({
    supabase,
    orgId: resolvedOrgId,
    projectId: parsed.projectId,
    userId,
    invoiceId: invoice.id,
    invoiceLineId,
    billingPeriodId: parsed.billingPeriodId ?? null,
    prepared: preparedFeeBilling,
    source: "fee_invoice",
    invoiceMetadata: {
        source_type: "fee",
        retain_fee: retainFee,
        retainage_percent: feeRetainagePercent > 0 ? feeRetainagePercent : null,
        retainage_amount_cents: feeRetainageCents > 0 ? feeRetainageCents : null,
    },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_fee_invoice_created",
    entityType: "invoice",
    entityId: invoice.id,
    payload: {
      project_id: parsed.projectId,
      schedule_id: preparedFeeBilling.summary.schedule?.id,
      amount_cents: amountCents,
      allocations: preparedFeeBilling.allocations,
    },
  })

  return (await getInvoiceWithLines(invoice.id, resolvedOrgId)) ?? invoice
}
