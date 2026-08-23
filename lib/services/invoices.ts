import { randomUUID } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { Invoice, InvoiceLine, InvoiceTotals, InvoiceView } from "@/lib/types"
import type { InvoiceInput, InvoiceLineInput } from "@/lib/validation/invoices"
import { isCostDrivenBillingModel, resolveProjectBillingModel } from "@/lib/financials/billing-model"
import {
  calculateInvoiceTotals,
  calculateInvoiceTotalsWithRetainage,
  isInvoiceFeeLine,
  isSystemGeneratedRetainageLine,
  type InvoiceDiscountInput,
} from "@/lib/financials/invoice-totals"
import { dollarsToCents } from "@/lib/financials/money"
import { getProjectPosture, type ProductTier, type ProjectPosture } from "@/lib/product-tier"
import { getReceivablesPosturePolicy } from "@/lib/receivables/policy"
import { createApprovedCostInvoiceFromPreview } from "@/lib/services/approved-cost-invoicing"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { sendEmail, renderEmailTemplate, getOrgSenderEmail } from "@/lib/services/mailer"
import { InvoiceEmail } from "@/lib/emails/invoice-email"
import { getNextInvoiceNumber, markReservationUsed, releaseInvoiceNumberReservation } from "@/lib/services/invoice-numbers"
import { enqueueInvoiceSync } from "@/lib/services/accounting-sync"
import { isSyncableInvoiceStatus } from "@/lib/financials/ledger-status"
import { getAgingBucket, type AgingBucket as ReportAgingBucket } from "@/lib/services/reports/aging"
import { recalcInvoiceBalanceAndStatus } from "@/lib/services/invoice-balance"
import { requireAuthorization } from "@/lib/services/authorization"
import { releaseInvoiceFromBillingPeriod } from "@/lib/services/billing-periods"
import {
  getAccountingSyncState,
  getAccountingSyncStates,
  hasAccountingExternalId,
  type AccountingSyncState,
} from "@/lib/services/accounting-sync-state"

type InvoiceRow = {
  id: string
  org_id: string
  project_id?: string | null
  file_id?: string | null
  billing_period_id?: string | null
  token?: string | null
  invoice_number: string
  title?: string | null
  status: string
  issue_date?: string | null
  due_date?: string | null
  notes?: string | null
  client_visible?: boolean | null
  subtotal_cents?: number | null
  tax_cents?: number | null
  total_cents?: number | null
  balance_due_cents?: number | null
  qbo_id?: string | null
  qbo_synced_at?: string | null
  qbo_sync_status?: string | null
  metadata?: Record<string, any> | null
  created_at?: string
  updated_at?: string
  viewed_at?: string | null
  sent_at?: string | null
  sent_to_emails?: string[] | null
  source_type?: string | null
  product_posture?: ProjectPosture | null
  approval_status?: Invoice["approval_status"]
  delivery_status?: Invoice["delivery_status"]
  issued_snapshot?: Record<string, any> | null
}

type SourceBillingContext = {
  contractId?: string | null
  retainagePercent: number
  retainageAppliesToFee: boolean
  retainageAmountCents: number
  /** Overrides the default "Retainage held (N%)" line description. */
  retainageLabel?: string
  metadata: Record<string, any>
}

type InvoicePermission = string

async function resolveInvoicePosture(params: {
  supabase: SupabaseClient
  projectId?: string | null
  productTier: ProductTier
}): Promise<ProjectPosture> {
  if (!params.projectId) return params.productTier
  const { data, error } = await params.supabase
    .from("projects")
    .select("property_type")
    .eq("id", params.projectId)
    .maybeSingle()
  if (error) throw new Error(`Failed to resolve invoice workflow: ${error.message}`)
  return getProjectPosture(data?.property_type, params.productTier)
}

async function requireInvoicePermission(params: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  permission: InvoicePermission
  projectId?: string | null
  invoiceId?: string
}) {
  await requireAuthorization({
    permission: params.permission,
    userId: params.userId,
    orgId: params.orgId,
    projectId: params.projectId ?? undefined,
    supabase: params.supabase,
    logDecision: true,
    resourceType: "invoice",
    resourceId: params.invoiceId,
  })
}

function normalizeLines(lines: InvoiceLineInput[]): InvoiceLine[] {
  return lines.map((line) => ({
    cost_code_id: line.cost_code_id ?? null,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: dollarsToCents(line.unit_cost),
    taxable: line.taxable ?? true,
    tax_rate_percent: line.tax_rate_percent ?? null,
    qbo_income_account_id: line.qbo_income_account_id ?? null,
    qbo_income_account_name: line.qbo_income_account_name ?? null,
    billable_cost_ids: line.billable_cost_ids ?? undefined,
    cost_cents: line.cost_cents ?? null,
    markup_cents: line.markup_cents ?? null,
    markup_percent: line.markup_percent ?? null,
  }))
}

function invoiceLineRows(lines: InvoiceLine[], sourceType: string) {
  return lines.map((line) => ({
    cost_code_id: line.cost_code_id ?? null,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unit_price_cents: line.unit_cost_cents,
    metadata: {
      taxable: line.taxable ?? true,
      tax_rate_percent: line.tax_rate_percent ?? null,
      qbo_income_account_id: line.qbo_income_account_id ?? null,
      qbo_income_account_name: line.qbo_income_account_name ?? null,
      system_generated_kind: isSystemGeneratedRetainageLine(line) ? "retainage_hold" : null,
      source_type: sourceType === "fee" ? "fee" : null,
      billable_cost_ids: line.billable_cost_ids ?? null,
      cost_cents: line.cost_cents ?? null,
      markup_cents: line.markup_cents ?? null,
      markup_percent: line.markup_percent ?? null,
    },
  }))
}

function issuedInvoiceSnapshot(params: {
  posture: ProjectPosture
  input: InvoiceInput
  lines: InvoiceLine[]
  totals: InvoiceTotals
}) {
  return {
    schema_version: 1,
    issued_at: new Date().toISOString(),
    product_posture: params.posture,
    invoice_number: params.input.invoice_number,
    title: params.input.title,
    issue_date: params.input.issue_date ?? null,
    due_date: params.input.due_date ?? null,
    customer_id: params.input.customer_id ?? null,
    customer_name: params.input.customer_name ?? null,
    recipients: params.input.sent_to_emails ?? [],
    source_type: params.input.source_type ?? "manual",
    lines: params.lines,
    totals: params.totals,
  }
}


function discountFromInput(input: Pick<InvoiceInput, "discount_type" | "discount_value">): InvoiceDiscountInput {
  if (!input.discount_type || !input.discount_value || input.discount_value <= 0) return null
  return { type: input.discount_type, value: input.discount_value }
}


export function buildApprovedCostInvoicePreview({
  projectId,
  title,
  issueDate,
  dueDate,
  lines,
  totals,
}: {
  projectId: string
  title: string
  issueDate?: string | null
  dueDate?: string | null
  lines: InvoiceLine[]
  totals: InvoiceTotals
}) {
  return {
    projectId,
    title,
    issueDate: issueDate ?? new Date().toISOString().slice(0, 10),
    dueDate: dueDate ?? new Date().toISOString().slice(0, 10),
    groupBy: "cost_code" as const,
    lines: lines.map((line, index) => ({
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      unit: line.unit ?? null,
      cost_cents: line.cost_cents ?? line.unit_cost_cents,
      markup_cents: line.markup_cents ?? 0,
      billable_cents: Math.round(line.quantity * line.unit_cost_cents),
      markup_percent: line.markup_percent ?? 0,
      billable_cost_ids: line.billable_cost_ids ?? [],
      sort_order: index,
      metadata: {
        taxable: line.taxable === false ? false : undefined,
        qbo_income_account_id: line.qbo_income_account_id ?? undefined,
        qbo_income_account_name: line.qbo_income_account_name ?? undefined,
      },
    })),
    totals: {
      cost_cents: lines.reduce((sum, line) => sum + (line.cost_cents ?? line.unit_cost_cents), 0),
      markup_cents: lines.reduce((sum, line) => sum + (line.markup_cents ?? 0), 0),
      billable_cents: totals.total_cents,
    },
  }
}

function stripSystemGeneratedBillingLines(lines: InvoiceLine[]) {
  return lines.filter((line) => !isSystemGeneratedRetainageLine(line))
}

async function resolveInvoiceSourceBillingContext(params: {
  supabase: SupabaseClient
  orgId: string
  projectId?: string | null
  sourceType?: string
  sourceDrawId?: string | null
  sourceChangeOrderId?: string | null
  sourcePayApplicationId?: string | null
  baseLines: InvoiceLine[]
}) {
  const { supabase, orgId, projectId, sourceType, sourceDrawId, sourceChangeOrderId, sourcePayApplicationId, baseLines } = params

  if (sourceType === "pay_application" && sourcePayApplicationId) {
    // Pay applications compute retainage per SOV line (stepped schedules,
    // line overrides) before invoicing; use their amount verbatim instead of
    // re-deriving from the flat contract percent.
    const { data: payApp, error: payAppError } = await supabase
      .from("pay_applications")
      .select("id, project_id, contract_id, application_number, status, metadata")
      .eq("org_id", orgId)
      .eq("id", sourcePayApplicationId)
      .maybeSingle()

    if (payAppError) {
      throw new Error(`Failed to load pay application context: ${payAppError.message}`)
    }
    if (!payApp) {
      throw new Error("Selected pay application no longer exists.")
    }
    if (payApp.status !== "draft" && payApp.status !== "submitted") {
      throw new Error("This pay application has already been invoiced or voided.")
    }

    const payAppMetadata = (payApp.metadata ?? {}) as Record<string, any>
    const retainageAmountCents = Math.max(0, Math.round(Number(payAppMetadata.current_retainage_cents ?? 0)))
    const grossAmountCents = stripSystemGeneratedBillingLines(baseLines).reduce(
      (sum, line) => sum + Math.round(line.quantity * line.unit_cost_cents),
      0,
    )
    const effectivePercent =
      grossAmountCents > 0 ? Math.round((retainageAmountCents / grossAmountCents) * 10000) / 100 : 0

    return {
      contractId: payApp.contract_id as string,
      retainagePercent: effectivePercent,
      retainageAppliesToFee: false,
      retainageAmountCents,
      retainageLabel: "Retainage held (this application)",
      metadata: {
        pay_application_id: payApp.id,
        pay_application_number: payApp.application_number,
        contract_id: payApp.contract_id,
        retainage_amount_cents: retainageAmountCents > 0 ? retainageAmountCents : null,
        gross_amount_cents: grossAmountCents,
      },
    } satisfies SourceBillingContext
  }

  if (sourceType !== "manual" && sourceType !== "draw" && sourceType !== "change_order") {
    return null
  }

  let contractId: string | null = null
  let sourceMetadata: Record<string, any> = {}

  if (sourceType === "draw" && sourceDrawId) {
    const { data: draw, error: drawError } = await supabase
      .from("draw_schedules")
      .select("id, project_id, contract_id, draw_number, title, amount_cents, percent_of_contract, status")
      .eq("org_id", orgId)
      .eq("id", sourceDrawId)
      .maybeSingle()

    if (drawError) {
      throw new Error(`Failed to load draw context: ${drawError.message}`)
    }

    if (!draw) {
      throw new Error("Selected draw no longer exists.")
    }

    contractId = (draw as any).contract_id ?? null

    const { data: priorDraws } = await supabase
      .from("draw_schedules")
      .select("amount_cents")
      .eq("org_id", orgId)
      .eq("project_id", draw.project_id)
      .neq("id", draw.id)
      .in("status", ["invoiced", "partial", "paid"])

    const priorBilledCents = (priorDraws ?? []).reduce((sum, row: any) => sum + Number(row.amount_cents ?? 0), 0)
    sourceMetadata = {
      draw_id: draw.id,
      draw_number: draw.draw_number,
      draw_title: draw.title,
      draw_amount_cents: draw.amount_cents,
      draw_percent_of_contract: draw.percent_of_contract,
      draw_status: draw.status,
      prior_billed_cents: priorBilledCents,
    }
  }

  if (sourceType === "change_order" && sourceChangeOrderId) {
    const { data: changeOrder, error: changeOrderError } = await supabase
      .from("change_orders")
      .select("id, project_id, contract_id, title, total_cents, status, approved_at")
      .eq("org_id", orgId)
      .eq("id", sourceChangeOrderId)
      .maybeSingle()

    if (changeOrderError) {
      throw new Error(`Failed to load change order context: ${changeOrderError.message}`)
    }

    if (!changeOrder) {
      throw new Error("Selected change order no longer exists.")
    }

    contractId = (changeOrder as any).contract_id ?? null
    sourceMetadata = {
      change_order_id: changeOrder.id,
      change_order_title: changeOrder.title,
      change_order_total_cents: changeOrder.total_cents,
      change_order_status: changeOrder.status,
      change_order_approved_at: changeOrder.approved_at,
    }
  }

  const contractProjectId = projectId ?? null
  let contract: any = null

  if (contractId) {
    const { data: linkedContract, error: contractError } = await supabase
      .from("contracts")
      .select("id, project_id, total_cents, retainage_percent, retainage_applies_to_fee, snapshot, status")
      .eq("org_id", orgId)
      .eq("id", contractId)
      .maybeSingle()

    if (contractError) {
      throw new Error(`Failed to load billing contract: ${contractError.message}`)
    }
    contract = linkedContract
  } else if (contractProjectId) {
    const { data: activeContract, error: contractError } = await supabase
      .from("contracts")
      .select("id, project_id, total_cents, retainage_percent, retainage_applies_to_fee, snapshot, status")
      .eq("org_id", orgId)
      .eq("project_id", contractProjectId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (contractError) {
      throw new Error(`Failed to load active billing contract: ${contractError.message}`)
    }
    contract = activeContract
    contractId = activeContract?.id ?? null
  }

  // Fallback to project-level settings if no contract found
  let effectiveRetainagePercent = Number(contract?.retainage_percent ?? 0)
  const retainageAppliesToFee = Boolean(contract?.retainage_applies_to_fee ?? contract?.snapshot?.retainage_applies_to_fee ?? false)
  let effectiveContractTotalCents = contract?.total_cents ?? null

  if (!contract && contractProjectId) {
    const { data: project } = await supabase
      .from("projects")
      .select("retainage_percent, total_contract_value_cents")
      .eq("org_id", orgId)
      .eq("id", contractProjectId)
      .maybeSingle()

    if (project) {
      effectiveRetainagePercent = Number(project.retainage_percent ?? 0)
      effectiveContractTotalCents = project.total_contract_value_cents ?? null
    }
  }

  const effectiveBaseLines = stripSystemGeneratedBillingLines(baseLines).filter(
    (line) => retainageAppliesToFee || !isInvoiceFeeLine(line),
  )
  const grossAmountCents = effectiveBaseLines.reduce(
    (sum, line) => sum + Math.round(line.quantity * line.unit_cost_cents),
    0,
  )
  const retainageAmountCents =
    effectiveRetainagePercent > 0 ? Math.round(Math.max(grossAmountCents, 0) * (effectiveRetainagePercent / 100)) : 0

  return {
    contractId,
    retainagePercent: effectiveRetainagePercent,
    retainageAppliesToFee,
    retainageAmountCents,
    metadata: {
      ...sourceMetadata,
      contract_id: contractId,
      contract_total_cents: effectiveContractTotalCents,
      approved_change_orders_cents: contract?.snapshot?.approved_change_orders_cents ?? null,
      revised_contract_total_cents: contract?.snapshot?.revised_total_cents ?? effectiveContractTotalCents ?? null,
      retainage_percent: effectiveRetainagePercent > 0 ? effectiveRetainagePercent : null,
      retainage_applies_to_fee: retainageAppliesToFee,
      retainage_amount_cents: retainageAmountCents > 0 ? retainageAmountCents : null,
      gross_amount_cents: grossAmountCents,
    },
  } satisfies SourceBillingContext
}

function applySourceDerivedBillingLines(lines: InvoiceLine[], sourceContext: SourceBillingContext | null) {
  const nextLines = stripSystemGeneratedBillingLines(lines)
  if (!sourceContext || sourceContext.retainageAmountCents <= 0) {
    return nextLines
  }

  return [
    ...nextLines,
    {
      description: sourceContext.retainageLabel ?? `Retainage held (${sourceContext.retainagePercent}%)`,
      quantity: 1,
      unit: "retainage",
      unit_cost_cents: -Math.abs(sourceContext.retainageAmountCents),
      taxable: false,
      qbo_income_account_id: null,
      qbo_income_account_name: null,
    },
  ]
}

async function upsertRetainageForInvoice(params: {
  supabase: SupabaseClient
  orgId: string
  projectId?: string | null
  invoiceId: string
  sourceContext: SourceBillingContext | null
}) {
  const { supabase, orgId, projectId, invoiceId, sourceContext } = params
  if (!projectId || !sourceContext?.contractId || sourceContext.retainageAmountCents <= 0) return

  const { data: existing } = await supabase
    .from("retainage")
    .select("id, status")
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)
    .maybeSingle()

  if (existing?.id) {
    if (existing.status === "paid") return

    const { error: updateError } = await supabase
      .from("retainage")
      .update({
        project_id: projectId,
        contract_id: sourceContext.contractId,
        amount_cents: sourceContext.retainageAmountCents,
      })
      .eq("org_id", orgId)
      .eq("id", existing.id)
    if (updateError) {
      throw new Error(`Failed to update invoice retainage: ${updateError.message}`)
    }
    return
  }

  const { error: insertError } = await supabase.from("retainage").insert({
    org_id: orgId,
    project_id: projectId,
    contract_id: sourceContext.contractId,
    invoice_id: invoiceId,
    amount_cents: sourceContext.retainageAmountCents,
    status: "held",
  })
  if (insertError) {
    throw new Error(`Failed to record invoice retainage: ${insertError.message}`)
  }
}

/**
 * Which invoices reach the external accounting system. The set itself lives in
 * `lib/financials/ledger-status.ts` next to the GL sets it intentionally
 * differs from — read the note there before widening or narrowing it.
 */
function shouldQueueQboSync(status?: string | null, clientVisible?: boolean | null) {
  if (clientVisible) return true
  return isSyncableInvoiceStatus(status)
}

function invoiceMetadataDrawIds(metadata: Record<string, any> | null | undefined): string[] {
  const sourceDrawIds = Array.isArray(metadata?.source_draw_ids) ? metadata?.source_draw_ids : []
  return Array.from(
    new Set(
      [metadata?.source_draw_id, metadata?.draw_id, ...sourceDrawIds].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  )
}

/**
 * Pre-flight duplicate-billing check via the indexed source columns. The DB is
 * the real enforcer (partial unique indexes on org_id + source id, see migration
 * 20260715100002); this exists to return a friendly message before the insert.
 * Draws are additionally guarded by draw_schedules.invoice_id at link time.
 */
async function assertSourceNotAlreadyBilled(params: {
  supabase: SupabaseClient
  orgId: string
  sourceType?: string
  sourceDrawId?: string | null
  sourceChangeOrderId?: string | null
  sourcePayApplicationId?: string | null
  excludeInvoiceId?: string
}) {
  const { supabase, orgId, sourceType, sourceDrawId, sourceChangeOrderId, sourcePayApplicationId, excludeInvoiceId } = params

  const findConflict = async (column: string, value: string) => {
    let query = supabase
      .from("invoices")
      .select("id")
      .eq("org_id", orgId)
      .eq(column, value)
      .neq("status", "void")
      .limit(1)
    if (excludeInvoiceId) query = query.neq("id", excludeInvoiceId)
    const { data, error } = await query.maybeSingle()
    if (error) {
      throw new Error(`Failed to validate invoice source linkage: ${error.message}`)
    }
    return Boolean(data)
  }

  if (sourceType === "draw" && sourceDrawId) {
    let drawQuery = supabase
      .from("draw_schedules")
      .select("id, invoice_id")
      .eq("org_id", orgId)
      .eq("id", sourceDrawId)
      .not("invoice_id", "is", null)
      .limit(1)
    if (excludeInvoiceId) drawQuery = drawQuery.neq("invoice_id", excludeInvoiceId)
    const { data: linkedDraw, error: drawError } = await drawQuery.maybeSingle()
    if (drawError) {
      throw new Error(`Failed to validate invoice source linkage: ${drawError.message}`)
    }
    if (linkedDraw || (await findConflict("source_draw_id", sourceDrawId))) {
      throw new Error("This draw is already linked to another invoice.")
    }
  }

  if (sourceType === "change_order" && sourceChangeOrderId) {
    if (await findConflict("source_change_order_id", sourceChangeOrderId)) {
      throw new Error("This change order is already linked to another invoice.")
    }
  }

  if (sourceType === "pay_application" && sourcePayApplicationId) {
    if (await findConflict("source_pay_application_id", sourcePayApplicationId)) {
      throw new Error("This pay application is already linked to another invoice.")
    }
  }
}

async function assertDirectChangeOrderInvoiceAllowed(params: {
  supabase: SupabaseClient
  orgId: string
  projectId?: string | null
  sourceType?: string | null
  sourceChangeOrderId?: string | null
}) {
  if (params.sourceType !== "change_order" || !params.sourceChangeOrderId) return

  let projectId = params.projectId ?? null
  if (!projectId) {
    const { data: changeOrder, error: changeOrderError } = await params.supabase
      .from("change_orders")
      .select("project_id")
      .eq("org_id", params.orgId)
      .eq("id", params.sourceChangeOrderId)
      .maybeSingle()

    if (changeOrderError) {
      throw new Error(`Failed to load change order billing model: ${changeOrderError.message}`)
    }
    projectId = changeOrder?.project_id ?? null
  }
  if (!projectId) return

  const [settingsResult, contractResult] = await Promise.all([
    params.supabase
      .from("project_financial_settings")
      .select("billing_model")
      .eq("org_id", params.orgId)
      .eq("project_id", projectId)
      .maybeSingle(),
    params.supabase
      .from("contracts")
      .select("contract_type, fixed_fee_cents, gmp_cents, snapshot")
      .eq("org_id", params.orgId)
      .eq("project_id", projectId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (settingsResult.error) {
    throw new Error(`Failed to load project billing settings: ${settingsResult.error.message}`)
  }
  if (contractResult.error) {
    throw new Error(`Failed to load project contract billing model: ${contractResult.error.message}`)
  }

  const billingModel = resolveProjectBillingModel({
    status: "active",
    financial_settings: settingsResult.data ?? null,
    billing_contract: contractResult.data ?? null,
  } as any)

  if (isCostDrivenBillingModel(billingModel)) {
    throw new Error(
      "Cost-driven projects bill approved costs through the cost ledger. Do not invoice change orders directly.",
    )
  }
}

async function syncDrawInvoiceLink(params: {
  supabase: SupabaseClient
  orgId: string
  drawId?: string | null
  invoiceId: string
}) {
  const { supabase, orgId, drawId, invoiceId } = params
  if (!drawId) return

  const { data: draw, error } = await supabase
    .from("draw_schedules")
    .select("id, invoice_id, status")
    .eq("org_id", orgId)
    .eq("id", drawId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to validate draw linkage: ${error.message}`)
  }

  if (!draw) {
    throw new Error("Selected draw no longer exists.")
  }

  if (draw.invoice_id && draw.invoice_id !== invoiceId) {
    throw new Error("Selected draw is already linked to another invoice.")
  }

  const nextStatus = draw.status === "paid" || draw.status === "partial" ? draw.status : "invoiced"
  const { error: updateError } = await supabase
    .from("draw_schedules")
    .update({
      invoice_id: invoiceId,
      status: nextStatus,
    })
    .eq("org_id", orgId)
    .eq("id", drawId)

  if (updateError) {
    throw new Error(`Failed to link draw to invoice: ${updateError.message}`)
  }
}

async function releaseInvoiceSourceLinks(params: {
  supabase: SupabaseClient
  orgId: string
  invoiceId: string
  metadata?: Record<string, any> | null
}) {
  const { supabase, orgId, invoiceId, metadata } = params
  const sourceDrawIds = invoiceMetadataDrawIds(metadata)
  const sourceType = typeof metadata?.source_type === "string" ? metadata.source_type : null

  await releaseInvoiceFromBillingPeriod({
    supabase,
    orgId,
    invoiceId,
  })

  if (sourceDrawIds.length > 0) {
    const { error } = await supabase
      .from("draw_schedules")
      .update({ invoice_id: null, status: "pending" })
      .eq("org_id", orgId)
      .in("id", sourceDrawIds)
      .eq("invoice_id", invoiceId)

    if (error) {
      throw new Error(`Failed to release draw invoice link: ${error.message}`)
    }
  }

  if (sourceType === "fee") {
    const { data: feeBillings, error: feeBillingError } = await supabase
      .from("project_fee_billings")
      .select("id, metadata")
      .eq("org_id", orgId)
      .eq("invoice_id", invoiceId)
      .neq("status", "voided")

    if (feeBillingError) {
      throw new Error(`Failed to load fee billing links: ${feeBillingError.message}`)
    }

    const now = new Date().toISOString()
    for (const billing of feeBillings ?? []) {
      const allocations = Array.isArray((billing.metadata as any)?.allocations)
        ? ((billing.metadata as any).allocations as Array<{ line_id?: string; amount_cents?: number }>)
        : []

      if (allocations.length > 0) {
        const lineIds = allocations.map((allocation) => allocation.line_id).filter((id): id is string => Boolean(id))
        const { data: feeLines, error: feeLinesError } =
          lineIds.length === 0
            ? { data: [], error: null }
            : await supabase
                .from("project_fee_schedule_lines")
                .select("id, scheduled_fee_cents, earned_fee_cents, billed_fee_cents")
                .eq("org_id", orgId)
                .in("id", lineIds)

        if (feeLinesError) {
          throw new Error(`Failed to load fee lines for void: ${feeLinesError.message}`)
        }

        const feeLineById = new Map((feeLines ?? []).map((line: any) => [line.id, line]))
        for (const allocation of allocations) {
          if (!allocation.line_id) continue
          const line = feeLineById.get(allocation.line_id)
          if (!line) continue
          const nextBilled = Math.max(0, Number(line.billed_fee_cents ?? 0) - Number(allocation.amount_cents ?? 0))
          const nextStatus =
            nextBilled <= 0
              ? Number(line.earned_fee_cents ?? 0) > 0
                ? "earned"
                : "unbilled"
              : nextBilled >= Number(line.scheduled_fee_cents ?? 0)
                ? "billed"
                : "partially_billed"

          const { error: lineUpdateError } = await supabase
            .from("project_fee_schedule_lines")
            .update({
              billed_fee_cents: nextBilled,
              invoice_id: null,
              invoice_line_id: null,
              billed_at: nextBilled > 0 ? undefined : null,
              status: nextStatus,
            })
            .eq("org_id", orgId)
            .eq("id", allocation.line_id)

          if (lineUpdateError) {
            throw new Error(`Failed to release fee line billing: ${lineUpdateError.message}`)
          }
        }
      }

      const { error: billingUpdateError } = await supabase
        .from("project_fee_billings")
        .update({ status: "voided", voided_at: now })
        .eq("org_id", orgId)
        .eq("id", billing.id)

      if (billingUpdateError) {
        throw new Error(`Failed to void fee billing link: ${billingUpdateError.message}`)
      }
    }
  }

  const { error: costError } = await supabase
    .from("billable_costs")
    .update({
      invoice_id: null,
      invoice_line_id: null,
      status: "open",
      billed_at: null,
    })
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)

  if (costError) {
    throw new Error(`Failed to release billed costs: ${costError.message}`)
  }

  const { error: invoiceRetainageError } = await supabase
    .from("retainage")
    .delete()
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)
    .neq("status", "paid")

  if (invoiceRetainageError) {
    throw new Error(`Failed to remove invoice retainage: ${invoiceRetainageError.message}`)
  }
}

function mapInvoiceRow(row: InvoiceRow, accountingState?: AccountingSyncState | null): Invoice {
  const metadata = row.metadata ?? {}
  const lines = (metadata.lines as InvoiceLine[] | undefined) ?? []
  const totalsFromMetadata = (metadata.totals as InvoiceTotals | undefined) ?? undefined

  const totals: InvoiceTotals | undefined =
    totalsFromMetadata ??
    (row.total_cents != null
      ? {
        subtotal_cents: row.subtotal_cents ?? row.total_cents,
        tax_cents: row.tax_cents ?? 0,
        total_cents: row.total_cents,
        balance_due_cents: row.balance_due_cents ?? row.total_cents,
        tax_rate: metadata.tax_rate,
      }
      : undefined)

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    file_id: row.file_id ?? undefined,
    billing_period_id: row.billing_period_id ?? undefined,
    token: row.token ?? undefined,
    invoice_number: row.invoice_number,
    title: row.title ?? `Invoice ${row.invoice_number}`,
    status: (row.status as Invoice["status"]) ?? "saved",
    qbo_id: accountingState?.externalId ?? undefined,
    qbo_synced_at: accountingState?.syncedAt ?? undefined,
    qbo_sync_status: (accountingState?.status as Invoice["qbo_sync_status"]) ?? null,
    issue_date: row.issue_date ?? undefined,
    due_date: row.due_date ?? undefined,
    notes: row.notes ?? undefined,
    client_visible: row.client_visible ?? undefined,
    subtotal_cents: row.subtotal_cents ?? totals?.subtotal_cents,
    tax_cents: row.tax_cents ?? totals?.tax_cents,
    total_cents: row.total_cents ?? totals?.total_cents,
    currency: "usd",
    balance_due_cents: row.balance_due_cents ?? totals?.balance_due_cents,
    metadata: metadata ?? undefined,
    source_type: row.source_type ?? (metadata as any)?.source_type ?? undefined,
    customer_name: (metadata as any)?.customer_name ?? (row as any).customer_name,
    lines,
    totals,
    created_at: row.created_at,
    updated_at: row.updated_at,
    viewed_at: row.viewed_at ?? undefined,
    sent_at: row.sent_at ?? (metadata as any)?.sent_at ?? undefined,
    sent_to_emails: row.sent_to_emails ?? undefined,
    product_posture: row.product_posture ?? undefined,
    approval_status: row.approval_status ?? undefined,
    delivery_status: row.delivery_status ?? undefined,
    issued_snapshot: row.issued_snapshot ?? undefined,
  }
}

async function mapInvoiceRowsWithAccounting(
  supabase: SupabaseClient,
  orgId: string,
  rows: InvoiceRow[],
) {
  const states = await getAccountingSyncStates(supabase, {
    orgId,
    entityType: "invoice",
    entityIds: rows.map((row) => row.id),
  })
  return rows.map((row) => mapInvoiceRow(row, states.get(row.id)))
}

function mapInvoiceWithLines(row: any, accountingState?: AccountingSyncState | null) {
  const mapped = mapInvoiceRow(row as InvoiceRow, accountingState)
  const rawLines = (row as any).invoice_lines || []
  const mappedLines = rawLines.map((l: any) => ({
    ...l,
    cost_code_id: l.cost_code_id ?? null,
    unit_cost_cents: l.unit_price_cents,
    taxable: (l.metadata as any)?.taxable ?? l.taxable ?? undefined,
    tax_rate_percent: (l.metadata as any)?.tax_rate_percent ?? null,
    qbo_income_account_id: (l.metadata as any)?.qbo_income_account_id ?? null,
    qbo_income_account_name: (l.metadata as any)?.qbo_income_account_name ?? null,
    billable_cost_ids: (l.metadata as any)?.billable_cost_ids ?? undefined,
    cost_cents: (l.metadata as any)?.cost_cents ?? null,
    markup_cents: (l.metadata as any)?.markup_cents ?? null,
    markup_percent: (l.metadata as any)?.markup_percent ?? null,
  }))

  return {
    ...mapped,
    lines: mappedLines.length > 0 ? mappedLines : mapped.lines ?? [],
  }
}

async function safeSelect<T>(
  supabase: SupabaseClient,
  query: () => Promise<{ data: T | null; error: any }>,
  fallback: T,
): Promise<T> {
  try {
    const { data, error } = await query()
    if (error) {
      console.warn("Invoices query failed, returning fallback", error)
      return fallback
    }
    return data ?? fallback
  } catch (err) {
    console.warn("Invoices query threw, returning fallback", err)
    return fallback
  }
}

export async function listInvoices({
  orgId,
  projectId,
  limit,
  offset,
  search,
}: {
  orgId?: string
  projectId?: string
  limit?: number
  offset?: number
  /** Case-insensitive match on invoice number, title, or customer name. */
  search?: string
} = {}): Promise<Invoice[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.read",
    projectId,
  })

  let query = supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, sent_at, sent_to_emails, product_posture, approval_status, delivery_status, issued_snapshot",
    )
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }
  const term = search?.trim()
  if (term) {
    // Escape PostgREST or-filter specials so user input can't break the filter expression.
    const sanitized = term.replace(/[%_]/g, (match) => `\\${match}`).replace(/[(),.]/g, " ").trim()
    if (sanitized) {
      query = query.or(
        `invoice_number.ilike.%${sanitized}%,title.ilike.%${sanitized}%,metadata->>customer_name.ilike.%${sanitized}%`,
      )
    }
  }
  if (typeof limit === "number" && limit > 0) {
    const start = Math.max(0, offset ?? 0)
    query = query.range(start, start + limit - 1)
  }

  const { data, error } = await query

  if (error) throw new Error(`Failed to list invoices: ${error.message}`)

  return mapInvoiceRowsWithAccounting(supabase, resolvedOrgId, (data ?? []) as InvoiceRow[])
}

export interface InvoiceArSummary {
  outstandingCents: number
  overdueCents: number
  /** Balance past due by 1–30 / 31–60 / 61–90 / 90+ days. */
  buckets: [number, number, number, number]
}

/**
 * AR aging over the project's whole invoice book — computed server-side so the numbers stay
 * correct even when the client has only a page of rows loaded.
 */
export async function getProjectInvoiceArSummary({
  projectId,
  orgId,
}: {
  projectId: string
  orgId?: string
}): Promise<InvoiceArSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.read",
    projectId,
  })

  const { data, error } = await supabase
    .from("invoices")
    .select("status, balance_due_cents, total_cents, due_date")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .in("status", ["sent", "partial", "overdue"])

  if (error) throw new Error(`Failed to load AR summary: ${error.message}`)

  // One aging ladder for the whole app: lib/services/reports/aging.ts.
  const summary: InvoiceArSummary = { outstandingCents: 0, overdueCents: 0, buckets: [0, 0, 0, 0] }
  const bucketIndex: Partial<Record<ReportAgingBucket, 0 | 1 | 2 | 3>> = {
    "1_30": 0,
    "31_60": 1,
    "61_90": 2,
    "90_plus": 3,
  }

  for (const row of data ?? []) {
    const balance = Number(row.balance_due_cents ?? row.total_cents ?? 0)
    if (balance <= 0) continue
    summary.outstandingCents += balance
    const { bucket } = getAgingBucket({ dueDate: row.due_date, isPaid: false })
    const index = bucketIndex[bucket]
    if (index === undefined) continue
    summary.overdueCents += balance
    summary.buckets[index] += balance
  }

  return summary
}

export async function createInvoice({
  input,
  orgId,
  context,
  authorizationPermission = "invoice.write",
  sendAuthorizationPermission = "invoice.send",
}: {
  input: InvoiceInput
  orgId?: string
  /**
   * Pre-resolved context for callers without a browser session (recurring-invoice cron).
   * Runs as context.userId with the provided client — permission checks still apply.
   */
  context?: OrgServiceContext
  authorizationPermission?: string
  sendAuthorizationPermission?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = context ?? (await requireOrgContext(orgId))
  const reservationId = input.reservation_id ?? undefined
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: authorizationPermission,
    projectId: input.project_id,
  })
  if (input.status === "sent" || input.client_visible) {
    await requireInvoicePermission({
      supabase,
      orgId: resolvedOrgId,
      userId,
      permission: sendAuthorizationPermission,
      projectId: input.project_id,
    })
  }

  // Fetch org info for "From" section on invoice
  const { data: orgData } = await supabase
    .from("orgs")
    .select("name, email, phone, address")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  const sourceType = input.source_type ?? "manual"
  const sourceDrawId = input.source_draw_id ?? null
  const sourceChangeOrderId = input.source_change_order_id ?? null
  const sourcePayApplicationId = input.source_pay_application_id ?? null
  const productPosture = await resolveInvoicePosture({
    supabase,
    projectId: input.project_id,
    productTier,
  })
  const receivablesPolicy = getReceivablesPosturePolicy(productPosture)
  await assertDirectChangeOrderInvoiceAllowed({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.project_id ?? null,
    sourceType,
    sourceChangeOrderId,
  })
  const resolvedSourceContext = await resolveInvoiceSourceBillingContext({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.project_id ?? null,
    sourceType,
    sourceDrawId,
    sourceChangeOrderId,
    sourcePayApplicationId,
    baseLines: normalizeLines(input.lines),
  })
  const sourceContext = receivablesPolicy.supportsRetainage
    ? resolvedSourceContext
    : resolvedSourceContext
      ? { ...resolvedSourceContext, retainagePercent: 0, retainageAmountCents: 0 }
      : null
  const lines = applySourceDerivedBillingLines(normalizeLines(input.lines), sourceContext)
  const fromCostIds =
    sourceType === "from_costs"
      ? Array.from(new Set(lines.flatMap((line) => line.billable_cost_ids ?? [])))
      : []
  if (sourceType === "from_costs" && !input.project_id) {
    throw new Error("Project is required to invoice approved costs")
  }
  const totals = calculateInvoiceTotalsWithRetainage(lines, input.tax_rate, discountFromInput(input))
  const shouldGenerateToken = input.client_visible === true || input.status === "sent"
  const approvalStatus =
    sourceType === "pay_application"
      ? "approved"
      : receivablesPolicy.approvalMode === "required_review"
        ? "draft"
        : "not_required"
  if (shouldGenerateToken && approvalStatus !== "approved" && approvalStatus !== "not_required") {
    throw new Error(`${receivablesPolicy.customerLabel} billing must be approved before it can be issued.`)
  }
  const token = shouldGenerateToken ? randomUUID() : null

  if (sourceType === "from_costs") {
    const costIds = Array.from(new Set(lines.flatMap((line) => line.billable_cost_ids ?? [])))
    if (costIds.length === 0) {
      throw new Error("Select approved costs before creating an approved-cost invoice")
    }

    const parsedCustomerDetails = {
      customer_id: input.customer_id ?? null,
      customer_name: input.customer_name ?? null,
      customer_address: input.customer_address ?? null,
      customer_email: input.sent_to_emails?.[0] ?? null,
      from_name: input.from_name ?? orgData?.name ?? null,
      from_email: input.from_email ?? orgData?.email ?? null,
      from_address: input.from_address ?? orgData?.address ?? null,
    }
    const preview = buildApprovedCostInvoicePreview({
      projectId: input.project_id as string,
      title: input.title,
      issueDate: input.issue_date,
      dueDate: input.due_date,
      lines,
      totals,
    })

    const approvedCostInvoice = await createApprovedCostInvoiceFromPreview({
      supabase,
      orgId: resolvedOrgId,
      projectId: input.project_id as string,
      actorId: userId,
      invoiceNumber: input.invoice_number,
      token: token ?? randomUUID(),
      title: input.title,
      issueDate: input.issue_date ?? new Date().toISOString().slice(0, 10),
      dueDate: input.due_date ?? new Date().toISOString().slice(0, 10),
      fromDate: input.issue_date ?? new Date().toISOString().slice(0, 10),
      toDate: input.issue_date ?? new Date().toISOString().slice(0, 10),
      groupBy: "cost_code",
      costIds,
      preview,
      reservationId: reservationId ?? null,
      status: input.status ?? "saved",
      clientVisible: shouldGenerateToken,
      notes: input.notes ?? null,
      sentToEmails: input.sent_to_emails ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        lines,
        totals,
        tax_rate: input.tax_rate,
        tax_jurisdiction_id: input.tax_jurisdiction_id ?? null,
        tax_jurisdiction: input.tax_jurisdiction_name ?? null,
        created_by: userId,
        payment_terms_days: input.payment_terms_days,
        source_type: sourceType,
        ...parsedCustomerDetails,
        accounting_customer_ref: input.qbo_customer_id
          ? { id: input.qbo_customer_id, name: input.qbo_customer_name ?? null }
          : null,
        qbo_income_account_id: input.qbo_income_account_id ?? null,
        qbo_income_account_name: input.qbo_income_account_name ?? null,
        org_name: orgData?.name ?? null,
        org_email: orgData?.email ?? null,
        org_phone: orgData?.phone ?? null,
        org_address: orgData?.address ?? null,
      },
      auditLabel: "invoice_composer",
    })

    const invoiceId = approvedCostInvoice.invoiceId

    const { error: postureError } = await supabase
      .from("invoices")
      .update({
        product_posture: productPosture,
        approval_status: approvalStatus,
        delivery_status: shouldGenerateToken ? "queued" : "not_sent",
        issued_snapshot: shouldGenerateToken
          ? issuedInvoiceSnapshot({ posture: productPosture, input, lines, totals })
          : null,
      })
      .eq("org_id", resolvedOrgId)
      .eq("id", invoiceId)
    if (postureError) {
      throw new Error(`Failed to apply the invoice workflow: ${postureError.message}`)
    }

    if (shouldGenerateToken) {
      await recordEvent({
        orgId: resolvedOrgId,
        eventType: "invoice_sent",
        entityType: "invoice",
        entityId: invoiceId,
        payload: { invoice_number: input.invoice_number, project_id: input.project_id, total_cents: totals.total_cents, sent_to_emails: input.sent_to_emails ?? [] },
        channel: "notification",
      })
      await sendInvoiceEmail({ orgId: resolvedOrgId, invoiceId, totalCents: totals.total_cents, dueDate: input.due_date ?? undefined })
    }
    const created = await getInvoiceWithLines(invoiceId, resolvedOrgId)
    if (!created) throw new Error("Approved-cost invoice was created but could not be reloaded")
    return created
  }

  await assertSourceNotAlreadyBilled({
    supabase,
    orgId: resolvedOrgId,
    sourceType,
    sourceDrawId,
    sourceChangeOrderId,
    sourcePayApplicationId,
  })

  if (fromCostIds.length > 0) {
    const { data: lockedRows, error: lockError } = await supabase
      .from("billable_costs")
      .update({ status: "locked" })
      .eq("org_id", resolvedOrgId)
      .eq("project_id", input.project_id)
      .eq("status", "open")
      .in("id", fromCostIds)
      .select("id")

    if (lockError) throw new Error(`Failed to lock billable costs: ${lockError.message}`)
    if ((lockedRows ?? []).length !== fromCostIds.length) {
      throw new Error("Some approved costs were already claimed by another invoice. Refresh and try again.")
    }
  }

  const payload = {
    org_id: resolvedOrgId,
    project_id: input.project_id ?? null,
    token,
    invoice_number: input.invoice_number,
    title: input.title,
    status: input.status ?? "saved",
    issue_date: input.issue_date ?? null,
    due_date: input.due_date ?? null,
    notes: input.notes ?? null,
    client_visible: shouldGenerateToken,
    subtotal_cents: totals.subtotal_cents,
    tax_cents: totals.tax_cents,
    tax_jurisdiction_id: input.tax_jurisdiction_id ?? null,
    total_cents: totals.total_cents,
    balance_due_cents: totals.total_cents,
    product_posture: productPosture,
    approval_status: approvalStatus,
    delivery_status: shouldGenerateToken ? "queued" : "not_sent",
    issued_snapshot: shouldGenerateToken
      ? issuedInvoiceSnapshot({ posture: productPosture, input, lines, totals })
      : null,
    source_type: sourceType,
    source_draw_id: sourceDrawId,
    source_change_order_id: sourceChangeOrderId,
    source_pay_application_id: sourcePayApplicationId,
    metadata: {
      ...(input.metadata ?? {}),
      lines,
      totals,
      tax_rate: input.tax_rate,
      tax_jurisdiction_id: input.tax_jurisdiction_id ?? null,
      tax_jurisdiction: input.tax_jurisdiction_name ?? null,
      created_by: userId,
      payment_terms_days: input.payment_terms_days,
      customer_id: input.customer_id,
      customer_name: input.customer_name,
      customer_address: input.customer_address,
      customer_email: input.sent_to_emails?.[0],
      accounting_customer_ref: input.qbo_customer_id
        ? { id: input.qbo_customer_id, name: input.qbo_customer_name ?? null }
        : null,
      from_name: input.from_name ?? orgData?.name ?? null,
      from_email: input.from_email ?? orgData?.email ?? null,
      from_address: input.from_address ?? orgData?.address ?? null,
      source_type: sourceType,
      source_draw_id: sourceDrawId,
      source_change_order_id: sourceChangeOrderId,
      source_pay_application_id: sourcePayApplicationId,
      source_contract_id: sourceContext?.contractId ?? null,
      billing_context: sourceContext?.metadata ?? null,
      retainage_percent: sourceContext?.retainagePercent ?? null,
      retainage_applies_to_fee: sourceContext?.retainageAppliesToFee ?? null,
      retainage_amount_cents: sourceContext?.retainageAmountCents ?? null,
      qbo_income_account_id: input.qbo_income_account_id ?? null,
      qbo_income_account_name: input.qbo_income_account_name ?? null,
      // Store org info for invoice display
      org_name: orgData?.name ?? null,
      org_email: orgData?.email ?? null,
      org_phone: orgData?.phone ?? null,
      org_address: orgData?.address ?? null,
    },
    sent_at: shouldGenerateToken ? new Date().toISOString() : null,
    sent_to_emails: input.sent_to_emails ?? null,
  }

  // Header + lines land in one transaction (create_invoice_atomic) so a failure
  // anywhere leaves no partial invoice behind; only the cost locks need undoing.
  const service = createServiceSupabaseClient()
  const { data: rpcResult, error } = await service.rpc("create_invoice_atomic", {
    p_org_id: resolvedOrgId,
    p_invoice: payload,
    p_lines: invoiceLineRows(lines, sourceType),
  })

  const created = rpcResult as { invoice: InvoiceRow; lines: Array<{ id: string; metadata: Record<string, any> }> } | null
  if (error || !created?.invoice) {
    if (fromCostIds.length > 0) {
      await supabase.from("billable_costs").update({ status: "open" }).eq("org_id", resolvedOrgId).in("id", fromCostIds)
    }
    throw new Error(`Failed to create invoice: ${error?.message ?? "unknown error"}`)
  }
  const data = created.invoice
  const insertedLines = created.lines

  if (fromCostIds.length > 0) {
    for (const line of insertedLines ?? []) {
      const lineCostIds = ((line.metadata as any)?.billable_cost_ids ?? []) as string[]
      if (lineCostIds.length === 0) continue
      const { error: costUpdateError } = await supabase
        .from("billable_costs")
        .update({
          invoice_id: data.id,
          invoice_line_id: line.id,
          status: "billed",
          billed_at: new Date().toISOString(),
        })
        .eq("org_id", resolvedOrgId)
        .in("id", lineCostIds)

      if (costUpdateError) {
        throw new Error(`Failed to mark approved costs billed: ${costUpdateError.message}`)
      }
    }
  }

  if (reservationId) {
    await markReservationUsed(reservationId, data.id, resolvedOrgId)
  }

  if (sourceType === "draw" && sourceDrawId) {
    await syncDrawInvoiceLink({
      supabase,
      orgId: resolvedOrgId,
      drawId: sourceDrawId,
      invoiceId: data.id,
    })
  }

  await upsertRetainageForInvoice({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.project_id ?? null,
    invoiceId: data.id,
    sourceContext,
  })

  // Bookkeeping tail: events, audit, email, and sync enqueue are independent of
  // each other — run them together. The invoice is already committed, so a
  // failure here must not make the caller believe creation failed; log and move on.
  const wasSent = payload.client_visible || payload.status === "sent"
  const bookkeepingResults = await Promise.allSettled([
    recordEvent({
      orgId: resolvedOrgId,
      eventType: "invoice_created",
      entityType: "invoice",
      entityId: data.id,
      payload: { invoice_number: input.invoice_number, project_id: input.project_id, total_cents: totals.total_cents },
    }),
    wasSent
      ? recordEvent({
          orgId: resolvedOrgId,
          eventType: "invoice_sent",
          entityType: "invoice",
          entityId: data.id,
          payload: {
            invoice_number: input.invoice_number,
            project_id: input.project_id,
            total_cents: totals.total_cents,
            sent_to_emails: payload.sent_to_emails,
          },
          channel: "notification",
        })
      : Promise.resolve(),
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "insert",
      entityType: "invoice",
      entityId: data.id,
      after: payload,
    }),
    wasSent
      ? sendInvoiceEmail({
          orgId: resolvedOrgId,
          invoiceId: data.id,
          totalCents: totals.total_cents,
          dueDate: input.due_date ?? undefined,
        })
      : Promise.resolve(),
    shouldQueueQboSync(payload.status, payload.client_visible)
      ? enqueueInvoiceSync(data.id, resolvedOrgId)
      : Promise.resolve(),
  ])
  for (const settled of bookkeepingResults) {
    if (settled.status === "rejected") {
      console.error("[invoices.createInvoice] post-commit bookkeeping failed", data.id, settled.reason)
    }
  }

  const fresh = await getInvoiceWithLines(data.id, resolvedOrgId)
  return fresh ?? mapInvoiceRow(data as InvoiceRow)
}

export async function updateInvoice({
  invoiceId,
  input,
  orgId,
}: {
  invoiceId: string
  input: InvoiceInput
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)
  const { data: existing, error: existingError } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, token, client_visible, status, sent_at, sent_to_emails, balance_due_cents, metadata, updated_at, product_posture, approval_status, delivery_status")
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error(existingError?.message ?? "Invoice not found")
  }
  const existingAccountingState = await getAccountingSyncState(supabase, {
    orgId: resolvedOrgId,
    entityType: "invoice",
    entityId: invoiceId,
  })
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.write",
    projectId: existing.project_id,
    invoiceId,
  })
  if (existing.sent_at || hasAccountingExternalId(existingAccountingState) || !["draft", "saved"].includes(existing.status)) {
    throw new Error("Issued or accounting-synced invoices are immutable. Void and reissue the invoice instead.")
  }
  if (input.status === "sent" || input.client_visible) {
    await requireInvoicePermission({
      supabase,
      orgId: resolvedOrgId,
      userId,
      permission: "invoice.send",
      projectId: existing.project_id,
      invoiceId,
    })
  }

  const sourceType = input.source_type ?? (existing.metadata as any)?.source_type ?? "manual"
  const sourceDrawId = input.source_draw_id ?? (existing.metadata as any)?.source_draw_id ?? null
  const sourceChangeOrderId = input.source_change_order_id ?? (existing.metadata as any)?.source_change_order_id ?? null
  const productPosture = await resolveInvoicePosture({
    supabase,
    projectId: input.project_id ?? existing.project_id,
    productTier,
  })
  const receivablesPolicy = getReceivablesPosturePolicy(productPosture)
  if (sourceType === "from_costs" || (existing.metadata as any)?.source_type === "from_costs") {
    throw new Error("Approved-cost invoices are controlled by the cost ledger. Revise and reissue instead of editing.")
  }
  if (sourceType === "pay_application" || (existing.metadata as any)?.source_type === "pay_application") {
    throw new Error("Pay application invoices are generated from the pay app. Void the pay application and resubmit instead.")
  }
  if (sourceType === "fee" || (existing.metadata as any)?.source_type === "fee") {
    throw new Error("Fee invoices are generated from the fee schedule. Void this invoice and re-invoice from the Fee tab instead.")
  }
  await assertDirectChangeOrderInvoiceAllowed({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.project_id ?? existing.project_id ?? null,
    sourceType,
    sourceChangeOrderId,
  })
  const resolvedSourceContext = await resolveInvoiceSourceBillingContext({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.project_id ?? existing.project_id ?? null,
    sourceType,
    sourceDrawId,
    sourceChangeOrderId,
    baseLines: normalizeLines(input.lines),
  })
  const sourceContext = receivablesPolicy.supportsRetainage
    ? resolvedSourceContext
    : resolvedSourceContext
      ? { ...resolvedSourceContext, retainagePercent: 0, retainageAmountCents: 0 }
      : null
  const lines = applySourceDerivedBillingLines(normalizeLines(input.lines), sourceContext)
  const totals = calculateInvoiceTotalsWithRetainage(lines, input.tax_rate, discountFromInput(input))
  // Internal PDF rendering may create a token without publishing the invoice.
  // Only an explicit publish input (or an already-published invoice) can advance
  // the lifecycle; token possession alone is never authority to send.
  const shouldPublish = existing.client_visible === true || input.client_visible === true || input.status === "sent"
  const approvalStatus =
    receivablesPolicy.approvalMode !== "required_review"
      ? "not_required"
      : sourceType === "pay_application"
        ? "approved"
        : shouldPublish
          ? existing.approval_status ?? "draft"
          : "draft"
  if (shouldPublish && approvalStatus !== "approved" && approvalStatus !== "not_required") {
    throw new Error(`${receivablesPolicy.customerLabel} billing must be approved before it can be issued.`)
  }
  const token = shouldPublish ? existing.token ?? randomUUID() : existing.token ?? null
  const sentAt = shouldPublish ? existing.sent_at ?? new Date().toISOString() : existing.sent_at ?? null
  const isFirstSend = shouldPublish && !existing.sent_at
  const sentTo =
    input.sent_to_emails && input.sent_to_emails.length > 0 ? input.sent_to_emails : existing.sent_to_emails ?? null

  await assertSourceNotAlreadyBilled({
    supabase,
    orgId: resolvedOrgId,
    sourceType,
    sourceDrawId,
    sourceChangeOrderId,
    excludeInvoiceId: invoiceId,
  })

  const payload = {
    project_id: input.project_id ?? null,
    token,
    invoice_number: input.invoice_number,
    title: input.title,
    status: input.status ?? "saved",
    issue_date: input.issue_date ?? null,
    due_date: input.due_date ?? null,
    notes: input.notes ?? null,
    client_visible: shouldPublish,
    subtotal_cents: totals.subtotal_cents,
    tax_cents: totals.tax_cents,
    tax_jurisdiction_id: input.tax_jurisdiction_id ?? null,
    total_cents: totals.total_cents,
    balance_due_cents: totals.total_cents,
    product_posture: productPosture,
    approval_status: approvalStatus,
    delivery_status: shouldPublish ? "queued" : "not_sent",
    issued_snapshot: shouldPublish
      ? issuedInvoiceSnapshot({ posture: productPosture, input, lines, totals })
      : null,
    source_type: sourceType,
    source_draw_id: sourceDrawId,
    source_change_order_id: sourceChangeOrderId,
    metadata: {
      ...(existing.metadata ?? {}),
      ...(input.metadata ?? {}),
      lines,
      totals,
      tax_rate: input.tax_rate,
      tax_jurisdiction_id: input.tax_jurisdiction_id ?? null,
      tax_jurisdiction: input.tax_jurisdiction_name ?? null,
      payment_terms_days: input.payment_terms_days,
      updated_by: userId,
      customer_id: input.customer_id ?? (existing.metadata as any)?.customer_id,
      customer_name: input.customer_name ?? (existing.metadata as any)?.customer_name,
      customer_address: input.customer_address ?? (existing.metadata as any)?.customer_address,
      customer_email: (input.sent_to_emails ?? [])[0] ?? (existing.metadata as any)?.customer_email,
      accounting_customer_ref: input.qbo_customer_id
        ? { id: input.qbo_customer_id, name: input.qbo_customer_name ?? null }
        : null,
      from_name: input.from_name ?? (existing.metadata as any)?.from_name ?? null,
      from_email: input.from_email ?? (existing.metadata as any)?.from_email ?? null,
      from_address: input.from_address ?? (existing.metadata as any)?.from_address ?? null,
      source_type: sourceType,
      source_draw_id: sourceDrawId,
      source_change_order_id: sourceChangeOrderId,
      source_contract_id: sourceContext?.contractId ?? (existing.metadata as any)?.source_contract_id ?? null,
      billing_context: sourceContext?.metadata ?? (existing.metadata as any)?.billing_context ?? null,
      retainage_percent: sourceContext?.retainagePercent ?? (existing.metadata as any)?.retainage_percent ?? null,
      retainage_applies_to_fee:
        sourceContext?.retainageAppliesToFee ?? (existing.metadata as any)?.retainage_applies_to_fee ?? null,
      retainage_amount_cents: sourceContext?.retainageAmountCents ?? (existing.metadata as any)?.retainage_amount_cents ?? null,
      qbo_income_account_id: input.qbo_income_account_id ?? null,
      qbo_income_account_name: input.qbo_income_account_name ?? null,
    },
    sent_at: sentAt,
    sent_to_emails: sentTo,
  }

  const service = createServiceSupabaseClient()
  const { data: rpcResult, error } = await service.rpc("update_invoice_atomic", {
    p_org_id: resolvedOrgId,
    p_invoice_id: invoiceId,
    p_invoice: payload,
    p_lines: invoiceLineRows(lines, sourceType),
    p_expected_updated_at: existing.updated_at ?? null,
  })
  const updated = rpcResult as { invoice?: InvoiceRow } | null
  const data = updated?.invoice
  if (error || !data) {
    throw new Error(`Failed to update invoice: ${error?.message ?? "unknown error"}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_updated",
    entityType: "invoice",
    entityId: invoiceId,
    payload: { invoice_number: input.invoice_number, project_id: input.project_id, total_cents: totals.total_cents },
  })

  if (isFirstSend) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "invoice_sent",
      entityType: "invoice",
      entityId: invoiceId,
      payload: {
        invoice_number: input.invoice_number,
        project_id: input.project_id,
        total_cents: totals.total_cents,
        sent_to_emails: sentTo,
      },
      channel: "notification",
    })
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "invoice",
    entityId: invoiceId,
    before: existing,
    after: payload,
  })

  const sendTransition = existing.status !== "sent" && payload.status === "sent"
  if (isFirstSend || sendTransition) {
    await sendInvoiceEmail({
      orgId: resolvedOrgId,
      invoiceId,
      totalCents: totals.total_cents,
      dueDate: input.due_date ?? undefined,
    })
  }

  if (
    shouldQueueQboSync(payload.status, payload.client_visible) ||
    shouldQueueQboSync(existing.status, existing.client_visible) ||
    hasAccountingExternalId(existingAccountingState)
  ) {
    await enqueueInvoiceSync(invoiceId, resolvedOrgId)
  }

  const fresh = await getInvoiceWithLines(invoiceId, resolvedOrgId)
  return fresh ?? mapInvoiceRow(data as InvoiceRow)
}

export async function requestInvoiceApproval({
  invoiceId,
  note,
  orgId,
}: {
  invoiceId: string
  note?: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select("id, project_id, invoice_number, approval_status")
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .maybeSingle()
  if (error || !invoice) throw new Error(error?.message ?? "Invoice not found")
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.write",
    projectId: invoice.project_id,
    invoiceId,
  })
  const service = createServiceSupabaseClient()
  const { data: request, error: requestError } = await service.rpc("request_invoice_approval", {
    p_org_id: resolvedOrgId,
    p_invoice_id: invoiceId,
    p_actor_id: userId,
    p_note: note?.trim() || null,
  })
  if (requestError || !request) {
    throw new Error(requestError?.message ?? "Failed to request invoice approval")
  }
  await Promise.all([
    recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "invoice_approval_requested",
      entityType: "invoice",
      entityId: invoiceId,
      payload: { invoice_number: invoice.invoice_number },
    }),
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "update",
      entityType: "invoice",
      entityId: invoiceId,
      before: { approval_status: invoice.approval_status },
      after: { approval_status: "pending", approval_request_id: (request as any).id },
    }),
  ])
  return getInvoiceWithLines(invoiceId, resolvedOrgId)
}

export async function decideInvoiceApproval({
  invoiceId,
  decision,
  note,
  orgId,
}: {
  invoiceId: string
  decision: "approved" | "rejected"
  note?: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select("id, project_id, invoice_number, approval_status")
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .maybeSingle()
  if (error || !invoice) throw new Error(error?.message ?? "Invoice not found")
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.send",
    projectId: invoice.project_id,
    invoiceId,
  })
  const service = createServiceSupabaseClient()
  const { data: request, error: decisionError } = await service.rpc("decide_invoice_approval", {
    p_org_id: resolvedOrgId,
    p_invoice_id: invoiceId,
    p_actor_id: userId,
    p_decision: decision,
    p_note: note?.trim() || null,
  })
  if (decisionError || !request) {
    throw new Error(decisionError?.message ?? "Failed to decide invoice approval")
  }
  await Promise.all([
    recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: `invoice_${decision}`,
      entityType: "invoice",
      entityId: invoiceId,
      payload: { invoice_number: invoice.invoice_number, approval_request_id: (request as any).id },
    }),
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "update",
      entityType: "invoice",
      entityId: invoiceId,
      before: { approval_status: invoice.approval_status },
      after: { approval_status: decision, approval_request_id: (request as any).id },
    }),
  ])
  return getInvoiceWithLines(invoiceId, resolvedOrgId)
}

async function assertInvoiceHasNoPayments(params: { supabase: SupabaseClient; orgId: string; invoiceId: string }) {
  const { supabase, orgId, invoiceId } = params
  const [paymentsResult, allocationsResult] = await Promise.all([
    supabase
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("invoice_id", invoiceId)
      .neq("status", "failed"),
    supabase
      .from("payment_allocations")
      .select("id, payment:payments!inner(status)", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("invoice_id", invoiceId)
      .neq("payment.status", "failed"),
  ])

  if (paymentsResult.error) {
    throw new Error(`Failed to check invoice payments: ${paymentsResult.error.message}`)
  }
  if (allocationsResult.error) {
    throw new Error(`Failed to check invoice payment allocations: ${allocationsResult.error.message}`)
  }
  if ((paymentsResult.count ?? 0) + (allocationsResult.count ?? 0) > 0) {
    throw new Error("Invoices with recorded payments cannot be deleted or voided.")
  }
}

export async function voidInvoice({ invoiceId, orgId }: { invoiceId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: existing, error } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, status, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .maybeSingle()

  if (error || !existing) {
    throw new Error(error?.message ?? "Invoice not found")
  }
  const existingAccountingState = await getAccountingSyncState(supabase, {
    orgId: resolvedOrgId,
    entityType: "invoice",
    entityId: invoiceId,
  })
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.write",
    projectId: existing.project_id,
    invoiceId,
  })
  if (existing.status === "void") {
    return mapInvoiceRow(existing as InvoiceRow, existingAccountingState)
  }
  if (existing.status === "paid" || existing.status === "partial") {
    throw new Error("Paid or partially paid invoices cannot be voided.")
  }

  const sourcePayApplicationId = (existing.metadata as Record<string, any> | null)?.source_pay_application_id
  if (typeof sourcePayApplicationId === "string" && sourcePayApplicationId.length > 0) {
    const { data: payApp } = await supabase
      .from("pay_applications")
      .select("id, status")
      .eq("org_id", resolvedOrgId)
      .eq("id", sourcePayApplicationId)
      .maybeSingle()
    // Draft pay apps have not posted SOV rollups yet, so their invoice can be
    // voided directly (this is the submit-failure compensation path).
    if (payApp && payApp.status !== "void" && payApp.status !== "draft") {
      throw new Error("Void the pay application instead, so its schedule-of-values rollups reverse with the invoice.")
    }
  }

  // The request client proves invoice.write above. The SECURITY DEFINER RPC is
  // service-only so a lower-privilege org member cannot invoke it directly.
  const service = createServiceSupabaseClient()
  const { data: rpcData, error: updateError } = await service.rpc("void_invoice_atomic", {
    p_org_id: resolvedOrgId,
    p_invoice_id: invoiceId,
    p_actor_id: userId,
  })
  const data = rpcData as InvoiceRow | null

  if (updateError || !data) {
    throw new Error(`Failed to void invoice: ${updateError?.message ?? "unknown error"}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_voided",
    entityType: "invoice",
    entityId: invoiceId,
    payload: { invoice_number: existing.invoice_number, project_id: existing.project_id },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "invoice",
    entityId: invoiceId,
    before: existing,
    after: data,
  })
  if (hasAccountingExternalId(existingAccountingState)) {
    await enqueueInvoiceSync(invoiceId, resolvedOrgId)
  }

  return mapInvoiceRow(data as InvoiceRow, existingAccountingState)
}

export async function deleteInvoice({ invoiceId, orgId }: { invoiceId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: existing, error } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, status, client_visible, sent_at, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .maybeSingle()

  if (error || !existing) {
    throw new Error(error?.message ?? "Invoice not found")
  }
  const existingAccountingState = await getAccountingSyncState(supabase, {
    orgId: resolvedOrgId,
    entityType: "invoice",
    entityId: invoiceId,
  })
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.write",
    projectId: existing.project_id,
    invoiceId,
  })
  if (!["draft", "saved"].includes(existing.status) || existing.client_visible || existing.sent_at || hasAccountingExternalId(existingAccountingState)) {
    throw new Error("Only unsent draft or saved invoices can be deleted. Void sent or synced invoices instead.")
  }

  await assertInvoiceHasNoPayments({ supabase, orgId: resolvedOrgId, invoiceId })
  await releaseInvoiceSourceLinks({
    supabase,
    orgId: resolvedOrgId,
    invoiceId,
    metadata: (existing.metadata as Record<string, any> | null) ?? null,
  })

  await supabase.from("invoice_lines").delete().eq("org_id", resolvedOrgId).eq("invoice_id", invoiceId)
  await supabase.from("accounting_sync_records").delete().eq("org_id", resolvedOrgId).eq("entity_type", "invoice").eq("entity_id", invoiceId)
  await supabase.from("invoice_views").delete().eq("org_id", resolvedOrgId).eq("invoice_id", invoiceId)

  const { error: deleteError } = await supabase.from("invoices").delete().eq("org_id", resolvedOrgId).eq("id", invoiceId)
  if (deleteError) {
    throw new Error(`Failed to delete invoice: ${deleteError.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_deleted",
    entityType: "invoice",
    entityId: invoiceId,
    payload: { invoice_number: existing.invoice_number, project_id: existing.project_id },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "invoice",
    entityId: invoiceId,
    before: existing,
  })

  return { projectId: existing.project_id as string | null }
}

export async function moveInvoiceToProject({
  invoiceId,
  targetProjectId,
  orgId,
}: {
  invoiceId: string
  targetProjectId: string
  orgId?: string
}) {
  if (!targetProjectId) throw new Error("A destination project is required")
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, status, metadata, billing_period_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .maybeSingle()

  if (error || !existing) {
    throw new Error(error?.message ?? "Invoice not found")
  }
  const existingAccountingState = await getAccountingSyncState(supabase, {
    orgId: resolvedOrgId,
    entityType: "invoice",
    entityId: invoiceId,
  })
  if (hasAccountingExternalId(existingAccountingState)) {
    throw new Error("Accounting-synced invoices cannot be moved between projects. Void and reissue the invoice instead.")
  }
  if (existing.project_id === targetProjectId) {
    throw new Error("Invoice is already on this project")
  }

  // Require write access on both the current and the destination project.
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.write",
    projectId: existing.project_id,
    invoiceId,
  })
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.write",
    projectId: targetProjectId,
    invoiceId,
  })

  // Verify the destination project exists in this org.
  const { data: targetProject, error: projectError } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", resolvedOrgId)
    .eq("id", targetProjectId)
    .maybeSingle()
  if (projectError || !targetProject) {
    throw new Error("Destination project not found")
  }

  // Source-derived links (draw schedules, fee billings, billable costs, retainage)
  // belong to the original project and cannot follow the invoice. Release them so the
  // original project's draws/costs return to an unbilled state, then detach the invoice
  // from any project-specific source so it becomes a plain manual invoice on the new project.
  const metadata = (existing.metadata as Record<string, any> | null) ?? null
  await releaseInvoiceSourceLinks({
    supabase,
    orgId: resolvedOrgId,
    invoiceId,
    metadata,
  })

  const nextMetadata = {
    ...(metadata ?? {}),
    source_type: "manual",
    source_draw_id: null,
    source_change_order_id: null,
    source_contract_id: null,
    moved_from_project_id: existing.project_id ?? null,
    moved_by: userId,
    moved_at: new Date().toISOString(),
  }

  const { data: updated, error: updateError } = await supabase
    .from("invoices")
    .update({
      project_id: targetProjectId,
      billing_period_id: null,
      source_type: "manual",
      source_draw_id: null,
      source_change_order_id: null,
      source_pay_application_id: null,
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, sent_to_emails, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, sent_at, product_posture, approval_status, delivery_status, issued_snapshot",
    )
    .single()

  if (updateError || !updated) {
    throw new Error(`Failed to move invoice: ${updateError?.message ?? "unknown error"}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_moved",
    entityType: "invoice",
    entityId: invoiceId,
    payload: {
      invoice_number: existing.invoice_number,
      from_project_id: existing.project_id,
      to_project_id: targetProjectId,
    },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "invoice",
    entityId: invoiceId,
    before: { project_id: existing.project_id },
    after: { project_id: targetProjectId },
  })

  return {
    invoice: mapInvoiceRow(updated as InvoiceRow, existingAccountingState),
    fromProjectId: existing.project_id as string | null,
    toProjectId: targetProjectId,
  }
}

export async function reviseInvoice({ invoiceId, orgId }: { invoiceId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const original = await getInvoiceWithLines(invoiceId, resolvedOrgId)
  if (!original) throw new Error("Invoice not found")
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.write",
    projectId: original.project_id,
    invoiceId,
  })
  if (["draft", "saved"].includes(original.status) && !original.sent_at && !original.qbo_id) {
    throw new Error("This invoice is still editable and does not need to be revised.")
  }
  if (original.status === "paid" || original.status === "partial") {
    throw new Error("Paid or partially paid invoices require a credit or adjustment workflow.")
  }
  if (original.status === "void") {
    throw new Error("This invoice has already been voided.")
  }

  const next = await getNextInvoiceNumber(resolvedOrgId)
  try {
    // Permission is checked with the caller's request client above; only the
    // trusted service boundary may execute the atomic database mutation.
    const service = createServiceSupabaseClient()
    const { data: rpcData, error } = await service.rpc("revise_invoice_atomic", {
      p_org_id: resolvedOrgId,
      p_invoice_id: invoiceId,
      p_actor_id: userId,
      p_invoice_number: next.number,
      p_reservation_id: next.reservation_id ?? null,
    })
    if (error) throw new Error(`Failed to revise invoice: ${error.message}`)
    const result = rpcData as { original?: InvoiceRow; replacement?: InvoiceRow } | null
    if (!result?.original || !result.replacement) {
      throw new Error("Failed to revise invoice: the database returned no replacement")
    }

    await Promise.all([
      recordEvent({
        orgId: resolvedOrgId,
        eventType: "invoice_voided",
        entityType: "invoice",
        entityId: original.id,
        payload: {
          invoice_number: original.invoice_number,
          project_id: original.project_id,
          replaced_by_invoice_id: result.replacement.id,
        },
      }),
      recordEvent({
        orgId: resolvedOrgId,
        eventType: "invoice_created",
        entityType: "invoice",
        entityId: result.replacement.id,
        payload: {
          invoice_number: result.replacement.invoice_number,
          project_id: result.replacement.project_id,
          revision_of_invoice_id: original.id,
        },
      }),
      recordAudit({
        orgId: resolvedOrgId,
        actorId: userId,
        action: "update",
        entityType: "invoice",
        entityId: original.id,
        before: { ...original },
        after: { ...result.original },
      }),
      recordAudit({
        orgId: resolvedOrgId,
        actorId: userId,
        action: "insert",
        entityType: "invoice",
        entityId: result.replacement.id,
        after: { ...result.replacement },
      }),
    ])
    if (original.qbo_id) await enqueueInvoiceSync(original.id, resolvedOrgId)

    return (await getInvoiceWithLines(result.replacement.id, resolvedOrgId)) ?? mapInvoiceRow(result.replacement)
  } catch (error) {
    if (next.reservation_id) {
      await releaseInvoiceNumberReservation(next.reservation_id, resolvedOrgId)
    }
    throw error
  }
}

export async function getInvoiceForPortal(invoiceId: string, orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, sent_at, sent_to_emails, product_posture, approval_status, delivery_status, issued_snapshot, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
    )
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("client_visible", true)
    .neq("status", "void")
    .maybeSingle()

  if (error) throw new Error(`Failed to load invoice: ${error.message}`)
  if (!data) return null
  const accountingState = await getAccountingSyncState(supabase, { orgId, entityType: "invoice", entityId: invoiceId })
  return mapInvoiceWithLines(data, accountingState)
}

export async function getInvoiceByToken(token: string) {
  if (!token) return null
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, sent_at, sent_to_emails, product_posture, approval_status, delivery_status, issued_snapshot, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
    )
    .eq("token", token)
    .eq("client_visible", true)
    .neq("status", "void")
    .maybeSingle()

  if (error) {
    console.error("Failed to load invoice by token", error)
    return null
  }

  if (!data) return null
  const accountingState = await getAccountingSyncState(supabase, { orgId: data.org_id, entityType: "invoice", entityId: data.id })
  return mapInvoiceWithLines(data, accountingState)
}

export async function getInvoiceWithLines(invoiceId: string, orgId?: string): Promise<Invoice | null> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, sent_to_emails, sent_at, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, product_posture, approval_status, delivery_status, issued_snapshot, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
    )
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (error) {
    console.error("Failed to load invoice with lines", error)
    return null
  }

  if (!data) return null
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.read",
    projectId: data.project_id,
    invoiceId,
  })
  const accountingState = await getAccountingSyncState(supabase, { orgId: resolvedOrgId, entityType: "invoice", entityId: invoiceId })
  return mapInvoiceWithLines(data, accountingState)
}

/**
 * Read-side token access: guarantees the invoice has a token WITHOUT touching its
 * lifecycle. The token alone does not expose the invoice — portal reads also require
 * client_visible, which only ensureInvoiceToken (an explicit publish) sets.
 */
export async function getOrCreateInvoiceToken(invoiceId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("invoices")
    .select("id, project_id, token")
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()
  if (error || !data) {
    throw new Error(error?.message ?? "Invoice not found")
  }
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.read",
    projectId: data.project_id,
    invoiceId,
  })
  if (data.token) return data.token

  const { data: updated, error: updateError } = await supabase
    .from("invoices")
    .update({ token: randomUUID() })
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .select("token")
    .single()
  if (updateError || !updated?.token) {
    throw new Error(updateError?.message ?? "Failed to generate invoice token")
  }
  return updated.token
}

/**
 * Publish an invoice share link: guarantees a token AND marks the invoice sent
 * (client_visible, sent_at, draft/saved → sent). Never downgrades a later status
 * (partial/paid/overdue keep their status). Flows that only need the token for
 * internal rendering must use getOrCreateInvoiceToken instead — reading an
 * invoice must never mutate its lifecycle.
 */
export async function ensureInvoiceToken(invoiceId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId, productTier } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, token, invoice_number, title, issue_date, due_date, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, client_visible, status, sent_at, product_posture, approval_status, delivery_status, issued_snapshot")
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (error || !data) {
    throw new Error(error?.message ?? "Invoice not found")
  }
  await requireInvoicePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    permission: "invoice.send",
    projectId: data.project_id,
    invoiceId,
  })
  if (data.status === "void") {
    throw new Error("Void invoices cannot be shared.")
  }
  const productPosture = data.product_posture ?? await resolveInvoicePosture({
    supabase,
    projectId: data.project_id,
    productTier,
  })
  const policy = getReceivablesPosturePolicy(productPosture)
  if (policy.approvalMode === "required_review" && data.approval_status !== "approved") {
    throw new Error(`${policy.customerLabel} billing must be approved before its share link is published.`)
  }

  const token = data.token ?? randomUUID()
  const nextStatus = data.status === "draft" || data.status === "saved" ? "sent" : data.status
  const sentAt = data.sent_at ?? new Date().toISOString()
  const alreadyPublished = Boolean(data.token) && data.client_visible && Boolean(data.sent_at) && nextStatus === data.status
  if (alreadyPublished) return token

  const { data: updated, error: updateError } = await supabase
    .from("invoices")
    .update({
      token,
      client_visible: true,
      status: nextStatus,
      sent_at: sentAt,
      product_posture: productPosture,
      delivery_status: "sent",
      issued_snapshot: data.issued_snapshot ?? {
        issued_at: sentAt,
        posture: productPosture,
        invoice_number: data.invoice_number,
        title: data.title,
        issue_date: data.issue_date,
        due_date: data.due_date,
        subtotal_cents: data.subtotal_cents,
        tax_cents: data.tax_cents,
        total_cents: data.total_cents,
        metadata: data.metadata,
      },
    })
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .select("token")
    .single()

  if (updateError || !updated) {
    throw new Error(updateError?.message ?? "Failed to generate invoice link")
  }

  const transitioned = nextStatus !== data.status || !data.client_visible || !data.sent_at
  if (transitioned) {
    await supabase.from("invoice_deliveries").upsert(
      {
        org_id: resolvedOrgId,
        invoice_id: invoiceId,
        channel: "link",
        status: "sent",
        attempt_count: 1,
        idempotency_key: `${invoiceId}:${sentAt}:share-link`,
        sent_at: sentAt,
        metadata: { kind: "share_link" },
      },
      { onConflict: "org_id,idempotency_key" },
    )
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "invoice_sent",
      entityType: "invoice",
      entityId: invoiceId,
      payload: { delivery: "share_link" },
      channel: "notification",
    })
    await recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "update",
      entityType: "invoice",
      entityId: invoiceId,
      before: data,
      after: { ...data, token: updated.token, client_visible: true, status: nextStatus, sent_at: sentAt },
    })
    await enqueueInvoiceSync(invoiceId, resolvedOrgId)
  }

  return updated.token
}

// Email clients and chat apps prefetch links, which would otherwise register phantom
// "client viewed" activity. Skip anything that self-identifies as automated.
const BOT_USER_AGENT_PATTERN =
  /bot|crawl|spider|preview|prerender|headless|facebookexternalhit|slack|whatsapp|telegram|skypeuripreview|discord|twitterbot|linkedinbot|pinterest|embedly|quora link preview|vkshare|outbrain|w3c_validator|googleimageproxy|snapchat|viber|bitlybot/i

export async function recordInvoiceViewed({
  invoiceId,
  orgId,
  token,
  userAgent,
  ipAddress,
}: {
  invoiceId: string
  orgId: string
  token?: string | null
  userAgent?: string | null
  ipAddress?: string | null
}) {
  if (!invoiceId || !orgId) return
  if (userAgent && BOT_USER_AGENT_PATTERN.test(userAgent)) return
  const supabase = createServiceSupabaseClient()
  try {
    const viewedAt = new Date().toISOString()

    await Promise.all([
      supabase.from("invoices").update({ viewed_at: viewedAt }).eq("id", invoiceId).eq("org_id", orgId),
      supabase
        .from("invoice_views")
        .insert({
          invoice_id: invoiceId,
          org_id: orgId,
          token: token ?? null,
          user_agent: userAgent ?? null,
          ip_address: ipAddress ?? null,
          viewed_at: viewedAt,
        })
        .select("id")
        .maybeSingle(),
    ])
  } catch (err) {
    console.warn("Failed to record invoice view", err)
  }
}

export async function listInvoiceViews(invoiceId: string, orgId?: string): Promise<InvoiceView[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireInvoicePermission({ supabase, orgId: resolvedOrgId, userId, permission: "invoice.read", invoiceId })
  const { data, error } = await supabase
    .from("invoice_views")
    .select("id, org_id, invoice_id, token, user_agent, ip_address, viewed_at, created_at")
    .eq("invoice_id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .order("viewed_at", { ascending: false })
    .limit(50)

  if (error) {
    console.error("Failed to list invoice views", error)
    return []
  }

  return data ?? []
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"

async function sendInvoiceEmail({
  orgId,
  invoiceId,
  totalCents,
  dueDate,
}: {
  orgId: string
  invoiceId: string
  totalCents?: number
  dueDate?: string
}) {
  const supabase = createServiceSupabaseClient()
  const [{ data: invoice, error }, { data: org }] = await Promise.all([
    supabase
      .from("invoices")
      .select("invoice_number, title, token, sent_at, sent_to_emails, project:projects(name)")
      .eq("id", invoiceId)
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase.from("orgs").select("name, logo_url, slug").eq("id", orgId).maybeSingle(),
  ])

  if (error || !invoice) {
    throw new Error(`Unable to load invoice for delivery: ${error?.message ?? "invoice not found"}`)
  }

  const recipients = new Set<string>()

  for (const email of invoice.sent_to_emails ?? []) {
    if (email) recipients.add(email)
  }

  const uniqueRecipients = Array.from(recipients)

  if (uniqueRecipients.length === 0) {
    await supabase
      .from("invoices")
      .update({ delivery_status: "failed" })
      .eq("id", invoiceId)
      .eq("org_id", orgId)
    throw new Error("Add at least one recipient before issuing this invoice.")
  }

  const issueKey = invoice.sent_at ?? new Date().toISOString()
  const { data: deliveries, error: deliveryError } = await supabase
    .from("invoice_deliveries")
    .upsert(
      uniqueRecipients.map((recipient) => ({
        org_id: orgId,
        invoice_id: invoiceId,
        channel: "email",
        recipient,
        status: "sending",
        attempt_count: 1,
        idempotency_key: `${invoiceId}:${issueKey}:${recipient.toLowerCase()}`,
        metadata: { invoice_number: invoice.invoice_number },
      })),
      { onConflict: "org_id,idempotency_key" },
    )
    .select("id")
  if (deliveryError) {
    throw new Error(`Failed to queue invoice delivery: ${deliveryError.message}`)
  }
  const deliveryIds = (deliveries ?? []).map((delivery) => delivery.id)
  await supabase
    .from("invoices")
    .update({ delivery_status: "sending" })
    .eq("id", invoiceId)
    .eq("org_id", orgId)

  const subject = `Invoice ${invoice.invoice_number}: ${invoice.title ?? "New invoice"}`
  const amount =
    totalCents != null
      ? `$${(totalCents / 100).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`
      : "$0.00"
  const dueDisplay = dueDate
    ? new Date(dueDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : undefined
  const invoiceLink = invoice.token ? `${APP_URL}/i/${invoice.token}` : `${APP_URL}/invoices`

  const html = await renderEmailTemplate(
    InvoiceEmail({
      invoiceNumber: invoice.invoice_number,
      invoiceTitle: invoice.title ?? "New invoice",
      projectName: (Array.isArray(invoice.project) ? invoice.project[0] : invoice.project)?.name ?? "Project",
      amount,
      dueDate: dueDisplay,
      invoiceLink,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
    })
  )

  try {
    await sendEmail({
      to: uniqueRecipients,
      subject,
      html,
      from: getOrgSenderEmail(org?.slug, org?.name),
    })
  } catch (sendError) {
    const message = sendError instanceof Error ? sendError.message : "Unknown email provider error"
    if (deliveryIds.length > 0) {
      await supabase
        .from("invoice_deliveries")
        .update({ status: "failed", failed_at: new Date().toISOString(), error_message: message })
        .in("id", deliveryIds)
    }
    await supabase
      .from("invoices")
      .update({ delivery_status: "failed" })
      .eq("id", invoiceId)
      .eq("org_id", orgId)
    throw sendError
  }

  const sentAt = new Date().toISOString()
  if (deliveryIds.length > 0) {
    await supabase
      .from("invoice_deliveries")
      .update({ status: "sent", sent_at: sentAt, error_message: null })
      .in("id", deliveryIds)
  }
  await supabase
    .from("invoices")
    .update({ delivery_status: "sent" })
    .eq("id", invoiceId)
    .eq("org_id", orgId)

  const mergedRecipients = Array.from(new Set([...(invoice.sent_to_emails ?? []), ...uniqueRecipients]))
  const existingRecipients = invoice.sent_to_emails ?? []
  const shouldUpdateRecipients =
    mergedRecipients.length !== existingRecipients.length ||
    mergedRecipients.some((email) => !existingRecipients.includes(email))

  if (shouldUpdateRecipients) {
    await supabase
      .from("invoices")
      .update({ sent_to_emails: mergedRecipients })
      .eq("id", invoiceId)
      .eq("org_id", orgId)
  }
}

async function fetchContactEmail(
  supabase: any,
  contactId: string,
): Promise<{ email: string | null; full_name?: string } | null> {
  const { data, error } = await supabase.from("contacts").select("email, full_name").eq("id", contactId).maybeSingle()
  if (error) {
    console.warn("Failed to fetch contact email", error)
    return null
  }
  return data
}
