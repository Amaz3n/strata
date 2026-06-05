import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import {
  assertBillingPeriodStatusAllowsEdit,
  assertBillingPeriodStatusAllowsInvoice,
} from "@/lib/financials/billing-period-rules"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

export type BillingPeriodStatus = "open" | "reviewing" | "invoiced" | "closed" | "reopened"

export interface ProjectBillingPeriod {
  id: string
  org_id: string
  project_id: string
  name: string
  period_start: string
  period_end: string
  status: BillingPeriodStatus
  invoice_ids: string[]
  closed_by?: string | null
  closed_at?: string | null
  reopened_by?: string | null
  reopened_at?: string | null
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

const periodInputSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(160).optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

export type CreateBillingPeriodInput = z.infer<typeof periodInputSchema>

function mapPeriod(row: any): ProjectBillingPeriod {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    name: row.name,
    period_start: row.period_start,
    period_end: row.period_end,
    status: row.status,
    invoice_ids: Array.isArray(row.invoice_ids) ? row.invoice_ids : [],
    closed_by: row.closed_by ?? null,
    closed_at: row.closed_at ?? null,
    reopened_by: row.reopened_by ?? null,
    reopened_at: row.reopened_at ?? null,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function assertDateOrder(periodStart: string, periodEnd: string) {
  if (periodStart > periodEnd) {
    throw new Error("Billing period start must be before the end date.")
  }
}

function defaultPeriodName(periodStart: string, periodEnd: string) {
  return `${periodStart} to ${periodEnd}`
}

async function requireProjectInvoicePermission(args: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  permission: "invoice.read" | "invoice.write"
}) {
  await requireAuthorization({
    permission: args.permission,
    userId: args.userId,
    orgId: args.orgId,
    projectId: args.projectId,
    supabase: args.supabase,
    logDecision: true,
    resourceType: "project_billing_period",
  })
}

export async function listProjectBillingPeriods(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId,
    permission: "invoice.read",
  })

  const { data, error } = await supabase
    .from("project_billing_periods")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("period_start", { ascending: false })

  if (error) throw new Error(`Failed to load billing periods: ${error.message}`)
  return (data ?? []).map(mapPeriod)
}

export async function createProjectBillingPeriod(input: CreateBillingPeriodInput, orgId?: string) {
  const parsed = periodInputSchema.parse(input)
  assertDateOrder(parsed.periodStart, parsed.periodEnd)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: parsed.projectId,
    permission: "invoice.write",
  })

  const payload = {
    org_id: resolvedOrgId,
    project_id: parsed.projectId,
    name: parsed.name ?? defaultPeriodName(parsed.periodStart, parsed.periodEnd),
    period_start: parsed.periodStart,
    period_end: parsed.periodEnd,
    status: "open",
    created_by: userId,
    updated_by: userId,
    metadata: { source: "phase_4_billing_periods" },
  }

  const { data, error } = await supabase
    .from("project_billing_periods")
    .insert(payload)
    .select("*")
    .single()

  if (error || !data) throw new Error(`Failed to create billing period: ${error?.message}`)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "project_billing_period",
    entityId: data.id,
    after: data,
  })
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_billing_period_created",
    entityType: "project_billing_period",
    entityId: data.id,
    payload: {
      project_id: parsed.projectId,
      period_start: parsed.periodStart,
      period_end: parsed.periodEnd,
    },
  })

  return mapPeriod(data)
}

export async function getProjectBillingPeriod(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  billingPeriodId: string
}) {
  const { data, error } = await args.supabase
    .from("project_billing_periods")
    .select("*")
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("id", args.billingPeriodId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load billing period: ${error.message}`)
  return data ? mapPeriod(data) : null
}

export async function getPeriodForCostDate(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  occurredOn: string
}) {
  const { data, error } = await args.supabase
    .from("project_billing_periods")
    .select("*")
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .lte("period_start", args.occurredOn)
    .gte("period_end", args.occurredOn)
    .order("period_start", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Failed to resolve billing period: ${error.message}`)
  return data ? mapPeriod(data) : null
}

export async function getNextOpenBillingPeriod(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  afterDate: string
}) {
  const { data, error } = await args.supabase
    .from("project_billing_periods")
    .select("*")
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .in("status", ["open", "reviewing", "reopened"])
    .gt("period_end", args.afterDate)
    .order("period_start", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Failed to resolve next billing period: ${error.message}`)
  return data ? mapPeriod(data) : null
}

export function assertBillingPeriodCanInvoice(period: ProjectBillingPeriod) {
  assertBillingPeriodStatusAllowsInvoice(period)
}

export async function assertProjectBillingDateEditable(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  date?: string | null
  actionLabel?: string
}) {
  if (!args.date) return null
  const period = await getPeriodForCostDate({
    supabase: args.supabase,
    orgId: args.orgId,
    projectId: args.projectId,
    occurredOn: args.date,
  })
  if (period) assertBillingPeriodStatusAllowsEdit(period, args.actionLabel ?? "This cost")
  return period
}

export async function linkInvoiceToBillingPeriod(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  billingPeriodId: string
  invoiceId: string
  costIds: string[]
}) {
  const { error: invoiceError } = await args.supabase
    .from("invoices")
    .update({ billing_period_id: args.billingPeriodId })
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("id", args.invoiceId)

  if (invoiceError) throw new Error(`Failed to link invoice to billing period: ${invoiceError.message}`)

  const { error: costsError } = await args.supabase
    .from("billable_costs")
    .update({ billing_period_id: args.billingPeriodId })
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .in("id", args.costIds)

  if (costsError) throw new Error(`Failed to link costs to billing period: ${costsError.message}`)

  const { data: period, error: loadError } = await args.supabase
    .from("project_billing_periods")
    .select("invoice_ids, metadata")
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("id", args.billingPeriodId)
    .maybeSingle()

  if (loadError) throw new Error(`Failed to load billing period invoices: ${loadError.message}`)
  const invoiceIds = Array.from(new Set([...(Array.isArray(period?.invoice_ids) ? period.invoice_ids : []), args.invoiceId]))

  const { error: updateError } = await args.supabase
    .from("project_billing_periods")
    .update({
      invoice_ids: invoiceIds,
      status: "invoiced",
      metadata: {
        ...((period?.metadata as Record<string, any> | null) ?? {}),
        last_invoice_id: args.invoiceId,
        invoiced_at: new Date().toISOString(),
      },
    })
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("id", args.billingPeriodId)

  if (updateError) throw new Error(`Failed to update billing period invoice links: ${updateError.message}`)
}
