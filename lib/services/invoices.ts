import { randomUUID } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { Invoice, InvoiceLine, InvoiceTotals, InvoiceView } from "@/lib/types"
import type { InvoiceInput, InvoiceLineInput } from "@/lib/validation/invoices"
import { createApprovedCostInvoiceFromPreview } from "@/lib/services/approved-cost-invoicing"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { sendEmail, renderEmailTemplate, getOrgSenderEmail } from "@/lib/services/mailer"
import { InvoiceEmail } from "@/lib/emails/invoice-email"
import { markReservationUsed } from "@/lib/services/invoice-numbers"
import { enqueueInvoiceSync } from "@/lib/services/qbo-sync"
import { recalcInvoiceBalanceAndStatus } from "@/lib/services/invoice-balance"

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
}

type SourceBillingContext = {
  contractId?: string | null
  retainagePercent: number
  retainageAmountCents: number
  metadata: Record<string, any>
}

function toCents(value: number): number {
  if (!Number.isFinite(value)) return 0
  // If a very large number is passed (likely already in cents), avoid double-multiplying.
  if (Math.abs(value) > 100000) {
    return Math.round(value)
  }
  return Math.round(value * 100)
}

function normalizeLines(lines: InvoiceLineInput[]): InvoiceLine[] {
  return lines.map((line) => ({
    cost_code_id: line.cost_code_id ?? null,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: toCents(line.unit_cost),
    taxable: line.taxable ?? true,
    qbo_income_account_id: line.qbo_income_account_id ?? null,
    qbo_income_account_name: line.qbo_income_account_name ?? null,
    billable_cost_ids: line.billable_cost_ids ?? undefined,
    cost_cents: line.cost_cents ?? null,
    markup_cents: line.markup_cents ?? null,
    markup_percent: line.markup_percent ?? null,
  }))
}

function calculateNormalizedTotals(lines: InvoiceLine[], taxRate = 0): InvoiceTotals {
  const subtotal_cents = lines.reduce((sum, line) => {
    return sum + Math.round(line.quantity * line.unit_cost_cents)
  }, 0)

  const taxableBase = lines.reduce((sum, line) => {
    const lineSubtotal = Math.round(line.quantity * line.unit_cost_cents)
    return line.taxable === false ? sum : sum + lineSubtotal
  }, 0)

  const tax_cents = Math.round(taxableBase * (taxRate / 100))
  const total_cents = subtotal_cents + tax_cents

  return {
    subtotal_cents,
    tax_cents,
    total_cents,
    balance_due_cents: total_cents,
    tax_rate: taxRate,
  }
}

function calculateTotals(lines: InvoiceLineInput[], taxRate = 0): InvoiceTotals {
  return calculateNormalizedTotals(normalizeLines(lines), taxRate)
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
      cost_cents: line.cost_cents ?? line.unit_cost_cents,
      markup_cents: line.markup_cents ?? 0,
      billable_cents: Math.round(line.quantity * line.unit_cost_cents),
      markup_percent: line.markup_percent ?? 0,
      billable_cost_ids: line.billable_cost_ids ?? [],
      sort_order: index,
    })),
    totals: {
      cost_cents: lines.reduce((sum, line) => sum + (line.cost_cents ?? line.unit_cost_cents), 0),
      markup_cents: lines.reduce((sum, line) => sum + (line.markup_cents ?? 0), 0),
      billable_cents: totals.total_cents,
    },
  }
}

function isSystemGeneratedRetainageLine(line: Pick<InvoiceLine, "description" | "unit">) {
  const normalizedUnit = String(line.unit ?? "").toLowerCase()
  const normalizedDescription = String(line.description ?? "").toLowerCase()
  return normalizedUnit === "retainage" || normalizedDescription.startsWith("retainage held")
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
  baseLines: InvoiceLine[]
}) {
  const { supabase, orgId, projectId, sourceType, sourceDrawId, sourceChangeOrderId, baseLines } = params

  if (sourceType !== "draw" && sourceType !== "change_order") {
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
      .select("id, project_id, total_cents, retainage_percent, snapshot, status")
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
      .select("id, project_id, total_cents, retainage_percent, snapshot, status")
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

  const effectiveBaseLines = stripSystemGeneratedBillingLines(baseLines)
  const grossAmountCents = effectiveBaseLines.reduce(
    (sum, line) => sum + Math.round(line.quantity * line.unit_cost_cents),
    0,
  )
  const retainageAmountCents =
    effectiveRetainagePercent > 0 ? Math.round(Math.max(grossAmountCents, 0) * (effectiveRetainagePercent / 100)) : 0

  return {
    contractId,
    retainagePercent: effectiveRetainagePercent,
    retainageAmountCents,
    metadata: {
      ...sourceMetadata,
      contract_id: contractId,
      contract_total_cents: effectiveContractTotalCents,
      approved_change_orders_cents: contract?.snapshot?.approved_change_orders_cents ?? null,
      revised_contract_total_cents: contract?.snapshot?.revised_total_cents ?? effectiveContractTotalCents ?? null,
      retainage_percent: effectiveRetainagePercent > 0 ? effectiveRetainagePercent : null,
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
      description: `Retainage held (${sourceContext.retainagePercent}%)`,
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

    await supabase
      .from("retainage")
      .update({
        project_id: projectId,
        contract_id: sourceContext.contractId,
        amount_cents: sourceContext.retainageAmountCents,
      })
      .eq("org_id", orgId)
      .eq("id", existing.id)
    return
  }

  await supabase.from("retainage").insert({
    org_id: orgId,
    project_id: projectId,
    contract_id: sourceContext.contractId,
    invoice_id: invoiceId,
    amount_cents: sourceContext.retainageAmountCents,
    status: "held",
  })
}

function shouldQueueQboSync(status?: string | null, clientVisible?: boolean | null) {
  if (clientVisible) return true
  const normalized = String(status ?? "").toLowerCase()
  return normalized === "saved" || normalized === "sent" || normalized === "partial" || normalized === "paid" || normalized === "overdue"
}

async function assertSourceNotAlreadyBilled(params: {
  supabase: SupabaseClient
  orgId: string
  sourceType?: string
  sourceDrawId?: string | null
  sourceChangeOrderId?: string | null
  excludeInvoiceId?: string
}) {
  const { supabase, orgId, sourceType, sourceDrawId, sourceChangeOrderId, excludeInvoiceId } = params
  const { data: rows, error } = await supabase
    .from("invoices")
    .select("id, status, metadata")
    .eq("org_id", orgId)

  if (error) {
    throw new Error(`Failed to validate invoice source linkage: ${error.message}`)
  }

  const conflicting = (rows ?? []).find((row: any) => {
    if (excludeInvoiceId && row.id === excludeInvoiceId) return false
    if (row.status === "void") return false
    const metadata = (row.metadata ?? {}) as Record<string, any>
    if (sourceType === "draw" && sourceDrawId) {
      return metadata.source_type === "draw" && metadata.source_draw_id === sourceDrawId
    }
    if (sourceType === "change_order" && sourceChangeOrderId) {
      return metadata.source_type === "change_order" && metadata.source_change_order_id === sourceChangeOrderId
    }
    return false
  })

  if (conflicting && sourceType === "draw" && sourceDrawId) {
    throw new Error("This draw is already linked to another invoice.")
  }

  if (conflicting && sourceType === "change_order" && sourceChangeOrderId) {
    throw new Error("This change order is already linked to another invoice.")
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
  const sourceDrawId = typeof metadata?.source_draw_id === "string" ? metadata.source_draw_id : null
  const sourceType = typeof metadata?.source_type === "string" ? metadata.source_type : null

  if (sourceDrawId) {
    const { error } = await supabase
      .from("draw_schedules")
      .update({ invoice_id: null, status: "pending" })
      .eq("org_id", orgId)
      .eq("id", sourceDrawId)
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

  const { error: retainageError } = await supabase
    .from("retainage")
    .update({ status: "released", release_invoice_id: null })
    .eq("org_id", orgId)
    .eq("release_invoice_id", invoiceId)

  if (retainageError) {
    throw new Error(`Failed to release retainage links: ${retainageError.message}`)
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

function mapInvoiceRow(row: InvoiceRow): Invoice {
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
    qbo_id: row.qbo_id ?? undefined,
    qbo_synced_at: row.qbo_synced_at ?? undefined,
    qbo_sync_status: (row.qbo_sync_status as Invoice["qbo_sync_status"]) ?? null,
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
    customer_name: (metadata as any)?.customer_name ?? (row as any).customer_name,
    lines,
    totals,
    created_at: row.created_at,
    updated_at: row.updated_at,
    viewed_at: row.viewed_at ?? undefined,
    sent_at: row.sent_at ?? (metadata as any)?.sent_at ?? undefined,
    sent_to_emails: row.sent_to_emails ?? undefined,
  }
}

function mapInvoiceWithLines(row: any) {
  const mapped = mapInvoiceRow(row as InvoiceRow)
  const rawLines = (row as any).invoice_lines || []
  const mappedLines = rawLines.map((l: any) => ({
    ...l,
    cost_code_id: l.cost_code_id ?? null,
    unit_cost_cents: l.unit_price_cents,
    taxable: (l.metadata as any)?.taxable ?? l.taxable ?? undefined,
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
}: {
  orgId?: string
  projectId?: string
} = {}): Promise<Invoice[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, qbo_id, qbo_synced_at, qbo_sync_status, created_at, updated_at, viewed_at, sent_at, sent_to_emails",
    )
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to list invoices: ${error.message}`)

  const filtered = projectId ? (data ?? []).filter((row: any) => row.project_id === projectId) : data ?? []
  return filtered.map((row: any) => mapInvoiceRow(row as InvoiceRow))
}

export async function createInvoice({ input, orgId }: { input: InvoiceInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const reservationId = input.reservation_id ?? undefined

  // Fetch org info for "From" section on invoice
  const { data: orgData } = await supabase
    .from("orgs")
    .select("name, email, phone, address")
    .eq("id", resolvedOrgId)
    .maybeSingle()

  const sourceType = input.source_type ?? "manual"
  const sourceDrawId = input.source_draw_id ?? null
  const sourceChangeOrderId = input.source_change_order_id ?? null
  const sourceContext = await resolveInvoiceSourceBillingContext({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.project_id ?? null,
    sourceType,
    sourceDrawId,
    sourceChangeOrderId,
    baseLines: normalizeLines(input.lines),
  })
  const lines = applySourceDerivedBillingLines(normalizeLines(input.lines), sourceContext)
  const fromCostIds =
    sourceType === "from_costs"
      ? Array.from(new Set(lines.flatMap((line) => line.billable_cost_ids ?? [])))
      : []
  if (sourceType === "from_costs" && !input.project_id) {
    throw new Error("Project is required to invoice approved costs")
  }
  const totals = calculateNormalizedTotals(lines, input.tax_rate)
  const shouldGenerateToken = input.client_visible === true || input.status === "sent"
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
        lines,
        totals,
        tax_rate: input.tax_rate,
        created_by: userId,
        payment_terms_days: input.payment_terms_days,
        source_type: sourceType,
        ...parsedCustomerDetails,
        qbo_customer_id: input.qbo_customer_id ?? null,
        qbo_customer_name: input.qbo_customer_name ?? null,
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
    total_cents: totals.total_cents,
    balance_due_cents: totals.total_cents,
    metadata: {
      lines,
      totals,
      tax_rate: input.tax_rate,
      created_by: userId,
      payment_terms_days: input.payment_terms_days,
      customer_id: input.customer_id,
      customer_name: input.customer_name,
      customer_address: input.customer_address,
      customer_email: input.sent_to_emails?.[0],
      qbo_customer_id: input.qbo_customer_id ?? null,
      qbo_customer_name: input.qbo_customer_name ?? null,
      from_name: input.from_name ?? orgData?.name ?? null,
      from_email: input.from_email ?? orgData?.email ?? null,
      from_address: input.from_address ?? orgData?.address ?? null,
      source_type: sourceType,
      source_draw_id: sourceDrawId,
      source_change_order_id: sourceChangeOrderId,
      source_contract_id: sourceContext?.contractId ?? null,
      billing_context: sourceContext?.metadata ?? null,
      retainage_percent: sourceContext?.retainagePercent ?? null,
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

  const { data, error } = await supabase
    .from("invoices")
    .insert(payload)
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, sent_to_emails, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, qbo_id, qbo_synced_at, qbo_sync_status, created_at, updated_at, viewed_at",
    )
    .single()

  if (error || !data) {
    if (fromCostIds.length > 0) {
      await supabase.from("billable_costs").update({ status: "open" }).eq("org_id", resolvedOrgId).in("id", fromCostIds)
    }
    throw new Error(`Failed to create invoice: ${error?.message}`)
  }

  // Insert lines
  const { data: insertedLines, error: linesError } = await supabase.from("invoice_lines").insert(
    lines.map((line) => ({
      org_id: resolvedOrgId,
      invoice_id: data.id,
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unit_price_cents: line.unit_cost_cents,
      metadata: {
        taxable: line.taxable ?? true,
        qbo_income_account_id: line.qbo_income_account_id ?? null,
        qbo_income_account_name: line.qbo_income_account_name ?? null,
        system_generated_kind: isSystemGeneratedRetainageLine(line) ? "retainage_hold" : null,
        source_type: sourceType === "fee" ? "fee" : null,
        billable_cost_ids: line.billable_cost_ids ?? null,
        cost_cents: line.cost_cents ?? null,
        markup_cents: line.markup_cents ?? null,
        markup_percent: line.markup_percent ?? null,
      },
    })),
  ).select("id, metadata")

  if (linesError) {
    if (fromCostIds.length > 0) {
      await supabase.from("billable_costs").update({ status: "open", invoice_id: null, invoice_line_id: null }).eq("org_id", resolvedOrgId).in("id", fromCostIds)
      await supabase.from("invoices").delete().eq("org_id", resolvedOrgId).eq("id", data.id)
    }
    throw new Error(`Failed to create invoice lines: ${linesError.message}`)
  }

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

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_created",
    entityType: "invoice",
    entityId: data.id,
    payload: { invoice_number: input.invoice_number, project_id: input.project_id, total_cents: totals.total_cents },
  })

  if (payload.client_visible || payload.status === "sent") {
    await recordEvent({
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
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "invoice",
    entityId: data.id,
    after: payload,
  })

  if (payload.client_visible || payload.status === "sent") {
    await sendInvoiceEmail({
      orgId: resolvedOrgId,
      invoiceId: data.id,
      totalCents: totals.total_cents,
      dueDate: input.due_date ?? undefined,
    })
  }

  if (shouldQueueQboSync(payload.status, payload.client_visible)) {
    await enqueueInvoiceSync(data.id, resolvedOrgId)
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: existing, error: existingError } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, token, client_visible, status, sent_at, sent_to_emails, balance_due_cents, metadata, qbo_id")
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error(existingError?.message ?? "Invoice not found")
  }

  const sourceType = input.source_type ?? (existing.metadata as any)?.source_type ?? "manual"
  const sourceDrawId = input.source_draw_id ?? (existing.metadata as any)?.source_draw_id ?? null
  const sourceChangeOrderId = input.source_change_order_id ?? (existing.metadata as any)?.source_change_order_id ?? null
  const sourceContext = await resolveInvoiceSourceBillingContext({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.project_id ?? existing.project_id ?? null,
    sourceType,
    sourceDrawId,
    sourceChangeOrderId,
    baseLines: normalizeLines(input.lines),
  })
  const lines = applySourceDerivedBillingLines(normalizeLines(input.lines), sourceContext)
  const totals = calculateNormalizedTotals(lines, input.tax_rate)
  const shouldGenerateToken =
    existing.token != null || existing.client_visible === true || input.client_visible === true || input.status === "sent"
  const token = shouldGenerateToken ? existing.token ?? randomUUID() : existing.token ?? null
  const sentAt = shouldGenerateToken ? existing.sent_at ?? new Date().toISOString() : existing.sent_at ?? null
  const isFirstSend = shouldGenerateToken && !existing.sent_at
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
    client_visible: shouldGenerateToken,
    subtotal_cents: totals.subtotal_cents,
    tax_cents: totals.tax_cents,
    total_cents: totals.total_cents,
    metadata: {
      ...(existing.metadata ?? {}),
      lines,
      totals,
      tax_rate: input.tax_rate,
      payment_terms_days: input.payment_terms_days,
      updated_by: userId,
      customer_id: input.customer_id ?? (existing.metadata as any)?.customer_id,
      customer_name: input.customer_name ?? (existing.metadata as any)?.customer_name,
      customer_address: input.customer_address ?? (existing.metadata as any)?.customer_address,
      customer_email: (input.sent_to_emails ?? [])[0] ?? (existing.metadata as any)?.customer_email,
      qbo_customer_id: input.qbo_customer_id ?? null,
      qbo_customer_name: input.qbo_customer_name ?? null,
      from_name: input.from_name ?? (existing.metadata as any)?.from_name ?? null,
      from_email: input.from_email ?? (existing.metadata as any)?.from_email ?? null,
      from_address: input.from_address ?? (existing.metadata as any)?.from_address ?? null,
      source_type: sourceType,
      source_draw_id: sourceDrawId,
      source_change_order_id: sourceChangeOrderId,
      source_contract_id: sourceContext?.contractId ?? (existing.metadata as any)?.source_contract_id ?? null,
      billing_context: sourceContext?.metadata ?? (existing.metadata as any)?.billing_context ?? null,
      retainage_percent: sourceContext?.retainagePercent ?? (existing.metadata as any)?.retainage_percent ?? null,
      retainage_amount_cents: sourceContext?.retainageAmountCents ?? (existing.metadata as any)?.retainage_amount_cents ?? null,
      qbo_income_account_id: input.qbo_income_account_id ?? null,
      qbo_income_account_name: input.qbo_income_account_name ?? null,
    },
    sent_at: sentAt,
    sent_to_emails: sentTo,
  }

  const { data, error } = await supabase
    .from("invoices")
    .update(payload)
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, sent_to_emails, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, qbo_id, qbo_synced_at, qbo_sync_status, created_at, updated_at, viewed_at, sent_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to update invoice: ${error?.message}`)
  }

  await supabase.from("invoice_lines").delete().eq("invoice_id", invoiceId).eq("org_id", resolvedOrgId)

  const { error: linesError } = await supabase.from("invoice_lines").insert(
    lines.map((line) => ({
      org_id: resolvedOrgId,
      invoice_id: invoiceId,
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unit_price_cents: line.unit_cost_cents,
      metadata: {
        taxable: line.taxable ?? true,
        qbo_income_account_id: line.qbo_income_account_id ?? null,
        qbo_income_account_name: line.qbo_income_account_name ?? null,
        system_generated_kind: isSystemGeneratedRetainageLine(line) ? "retainage_hold" : null,
      },
    })),
  )

  if (linesError) {
    throw new Error(`Failed to update invoice lines: ${linesError.message}`)
  }

  if (sourceType === "draw" && sourceDrawId) {
    await syncDrawInvoiceLink({
      supabase,
      orgId: resolvedOrgId,
      drawId: sourceDrawId,
      invoiceId,
    })
  }

  await upsertRetainageForInvoice({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.project_id ?? existing.project_id ?? null,
    invoiceId,
    sourceContext,
  })

  await recalcInvoiceBalanceAndStatus({ supabase, orgId: resolvedOrgId, invoiceId })

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
    Boolean(existing.qbo_id)
  ) {
    await enqueueInvoiceSync(invoiceId, resolvedOrgId)
  }

  const fresh = await getInvoiceWithLines(invoiceId, resolvedOrgId)
  return fresh ?? mapInvoiceRow(data as InvoiceRow)
}

async function assertInvoiceHasNoPayments(params: { supabase: SupabaseClient; orgId: string; invoiceId: string }) {
  const { supabase, orgId, invoiceId } = params
  const { count, error } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)
    .neq("status", "failed")

  if (error) {
    throw new Error(`Failed to check invoice payments: ${error.message}`)
  }
  if ((count ?? 0) > 0) {
    throw new Error("Invoices with recorded payments cannot be deleted or voided.")
  }
}

export async function voidInvoice({ invoiceId, orgId }: { invoiceId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: existing, error } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, status, metadata, qbo_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .maybeSingle()

  if (error || !existing) {
    throw new Error(error?.message ?? "Invoice not found")
  }
  if (existing.status === "void") {
    return mapInvoiceRow(existing as InvoiceRow)
  }
  if (existing.status === "paid" || existing.status === "partial") {
    throw new Error("Paid or partially paid invoices cannot be voided.")
  }

  await assertInvoiceHasNoPayments({ supabase, orgId: resolvedOrgId, invoiceId })
  await releaseInvoiceSourceLinks({
    supabase,
    orgId: resolvedOrgId,
    invoiceId,
    metadata: (existing.metadata as Record<string, any> | null) ?? null,
  })

  const nextMetadata = {
    ...((existing.metadata as Record<string, any> | null) ?? {}),
    voided_at: new Date().toISOString(),
    voided_by: userId,
  }
  const { data, error: updateError } = await supabase
    .from("invoices")
    .update({
      status: "void",
      client_visible: false,
      balance_due_cents: 0,
      metadata: nextMetadata,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, sent_to_emails, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, qbo_id, qbo_synced_at, qbo_sync_status, created_at, updated_at, viewed_at, sent_at",
    )
    .single()

  if (updateError || !data) {
    throw new Error(`Failed to void invoice: ${updateError?.message}`)
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

  return mapInvoiceRow(data as InvoiceRow)
}

export async function deleteInvoice({ invoiceId, orgId }: { invoiceId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: existing, error } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, status, client_visible, sent_at, metadata, qbo_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .maybeSingle()

  if (error || !existing) {
    throw new Error(error?.message ?? "Invoice not found")
  }
  if (!["draft", "saved"].includes(existing.status) || existing.client_visible || existing.sent_at || existing.qbo_id) {
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
  await supabase.from("qbo_sync_records").delete().eq("org_id", resolvedOrgId).eq("entity_type", "invoice").eq("entity_id", invoiceId)
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

export async function getInvoiceForPortal(invoiceId: string, orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, sent_at, sent_to_emails, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
    )
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load invoice: ${error.message}`)
  if (!data) return null
  return mapInvoiceWithLines(data)
}

export async function getInvoiceByToken(token: string) {
  if (!token) return null
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, sent_at, sent_to_emails, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
    )
    .eq("token", token)
    .maybeSingle()

  if (error) {
    console.error("Failed to load invoice by token", error)
    return null
  }

  if (!data) return null
  return mapInvoiceWithLines(data)
}

export async function getInvoiceWithLines(invoiceId: string, orgId?: string): Promise<Invoice | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, sent_to_emails, sent_at, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, qbo_id, qbo_synced_at, qbo_sync_status, created_at, updated_at, viewed_at, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
    )
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (error) {
    console.error("Failed to load invoice with lines", error)
    return null
  }

  if (!data) return null
  return mapInvoiceWithLines(data)
}

export async function ensureInvoiceToken(invoiceId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("invoices")
    .select("id, org_id, token, client_visible")
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (error || !data) {
    throw new Error(error?.message ?? "Invoice not found")
  }

  if (data.token) return data.token

  const newToken = randomUUID()
  const { data: updated, error: updateError } = await supabase
    .from("invoices")
    .update({ token: newToken, client_visible: data.client_visible ?? true })
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .select("token")
    .single()

  if (updateError || !updated) {
    throw new Error(updateError?.message ?? "Failed to generate invoice link")
  }

  return updated.token
}

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
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
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
      .select("invoice_number, title, token, sent_to_emails, project:projects(name)")
      .eq("id", invoiceId)
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase.from("orgs").select("name, logo_url, slug").eq("id", orgId).maybeSingle(),
  ])

  if (error || !invoice) {
    console.warn("Unable to load invoice for email notification", error)
    return
  }

  const recipients = new Set<string>()

  for (const email of invoice.sent_to_emails ?? []) {
    if (email) recipients.add(email)
  }

  const uniqueRecipients = Array.from(recipients)

  if (uniqueRecipients.length === 0) {
    console.warn("No recipients for invoice email; skipping", { invoiceId })
    return
  }

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

  await sendEmail({
    to: uniqueRecipients,
    subject,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
  })

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
