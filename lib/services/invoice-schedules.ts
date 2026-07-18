import { addDays, addMonths, format } from "date-fns"

import type { Invoice } from "@/lib/types"
import { invoiceInputSchema } from "@/lib/validation/invoices"
import { requireOrgContext } from "@/lib/services/context"
import { calculateInvoiceTotals } from "@/lib/financials/invoice-totals"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { createInvoice, getInvoiceWithLines } from "@/lib/services/invoices"
import { compareInvoiceNumbers, incrementInvoiceNumber } from "@/lib/services/invoice-numbers"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { normalizeProductTier } from "@/lib/product-tier"

export type InvoiceScheduleFrequency = "weekly" | "monthly" | "quarterly"

export interface InvoiceSchedule {
  id: string
  org_id: string
  project_id: string | null
  source_invoice_id: string | null
  frequency: InvoiceScheduleFrequency
  next_run_on: string
  day_of_month: number | null
  auto_send: boolean
  recipient_email: string | null
  active: boolean
  last_run_at: string | null
  last_invoice_id: string | null
  created_at: string
  /** Display fields lifted out of the template for the manager UI. */
  title: string
  customer_name: string | null
  total_preview_cents: number
}

const SCHEDULE_COLUMNS =
  "id, org_id, project_id, source_invoice_id, template, frequency, next_run_on, day_of_month, auto_send, recipient_email, active, last_run_at, last_invoice_id, created_by, created_at, org:orgs(product_tier)"

function templateTotalCents(template: Record<string, any>): number {
  const rawLines = Array.isArray(template.lines) ? template.lines : []
  const lines = rawLines.map((line: any) => ({
    quantity: Number(line.quantity ?? 0),
    unit_cost_cents: Math.round(Number(line.unit_cost ?? 0) * 100),
    taxable: line.taxable !== false,
    tax_rate_percent: line.tax_rate_percent != null ? Number(line.tax_rate_percent) : null,
  }))
  const discountValue = Number(template.discount_value ?? 0)
  const discount =
    (template.discount_type === "percent" || template.discount_type === "fixed") && discountValue > 0
      ? { type: template.discount_type as "percent" | "fixed", value: discountValue }
      : null
  return calculateInvoiceTotals(lines, Number(template.tax_rate ?? 0), discount).total_cents
}

function mapScheduleRow(row: any): InvoiceSchedule {
  const template = (row.template ?? {}) as Record<string, any>
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? null,
    source_invoice_id: row.source_invoice_id ?? null,
    frequency: row.frequency,
    next_run_on: row.next_run_on,
    day_of_month: row.day_of_month ?? null,
    auto_send: Boolean(row.auto_send),
    recipient_email: row.recipient_email ?? null,
    active: Boolean(row.active),
    last_run_at: row.last_run_at ?? null,
    last_invoice_id: row.last_invoice_id ?? null,
    created_at: row.created_at,
    title: String(template.title ?? "Recurring invoice"),
    customer_name: template.customer_name ? String(template.customer_name) : null,
    total_preview_cents: templateTotalCents(template),
  }
}

/**
 * Freeze an invoice into a schedule template: keep the billing content (lines, customer,
 * tax/discount, notes, terms) and drop everything run-specific. Retainage holds are stripped
 * (they're re-derived per invoice) and billable-cost links are dropped so a recurring run
 * can never re-mark project costs as billed.
 */
function buildTemplateFromInvoice(invoice: Invoice): Record<string, any> {
  const metadata = (invoice.metadata ?? {}) as Record<string, any>
  const lines = (invoice.lines ?? [])
    .filter((line) => {
      const kind = (line as Record<string, any>).metadata?.system_generated_kind
      return String(line.unit ?? "").toLowerCase() !== "retainage" && kind !== "retainage_hold"
    })
    .map((line) => ({
      cost_code_id: line.cost_code_id ?? undefined,
      description: line.description,
      quantity: Number(line.quantity ?? 1),
      unit: line.unit ?? "ea",
      unit_cost: (line.unit_cost_cents ?? 0) / 100,
      taxable: line.taxable !== false,
      tax_rate_percent: line.tax_rate_percent ?? undefined,
      qbo_income_account_id: line.qbo_income_account_id ?? undefined,
      qbo_income_account_name: line.qbo_income_account_name ?? undefined,
    }))

  return {
    project_id: invoice.project_id ?? null,
    title: invoice.title ?? "Recurring invoice",
    customer_id: metadata.customer_id ?? undefined,
    customer_name: invoice.customer_name ?? metadata.customer_name ?? undefined,
    customer_address: metadata.customer_address ?? undefined,
    qbo_customer_id: metadata.qbo_customer_id ?? null,
    qbo_customer_name: metadata.qbo_customer_name ?? null,
    from_name: metadata.from_name ?? undefined,
    from_email: metadata.from_email ?? undefined,
    from_address: metadata.from_address ?? undefined,
    notes: typeof invoice.notes === "string" ? invoice.notes : undefined,
    tax_rate: invoice.totals?.tax_rate ?? Number(metadata.tax_rate ?? 0),
    discount_type: invoice.totals?.discount_type ?? undefined,
    discount_value: invoice.totals?.discount_value ?? undefined,
    payment_terms_days: Number(metadata.payment_terms_days ?? 15),
    lines,
  }
}

export async function createInvoiceScheduleFromInvoice(input: {
  invoiceId: string
  frequency: InvoiceScheduleFrequency
  startOn: string
  autoSend: boolean
  recipientEmail?: string | null
}): Promise<InvoiceSchedule> {
  const { supabase, orgId, userId } = await requireOrgContext()
  const invoice = await getInvoiceWithLines(input.invoiceId, orgId)
  if (!invoice) throw new Error("Invoice not found")
  if ((invoice.lines ?? []).length === 0) throw new Error("Invoice has no line items to recur")

  await requireAuthorization({
    permission: "invoice.write",
    userId,
    orgId,
    projectId: invoice.project_id ?? undefined,
    supabase,
    logDecision: true,
    resourceType: "invoice_schedule",
  })
  if (input.autoSend) {
    await requireAuthorization({
      permission: "invoice.send",
      userId,
      orgId,
      projectId: invoice.project_id ?? undefined,
      supabase,
      logDecision: true,
      resourceType: "invoice_schedule",
    })
  }

  const template = buildTemplateFromInvoice(invoice)
  const startDate = new Date(`${input.startOn}T00:00:00`)
  if (Number.isNaN(startDate.getTime())) throw new Error("Pick a valid start date")

  const recipient = input.recipientEmail?.trim() || null
  if (input.autoSend && !recipient) {
    throw new Error("Auto-send needs a recipient email")
  }

  const { data, error } = await supabase
    .from("invoice_schedules")
    .insert({
      org_id: orgId,
      project_id: invoice.project_id ?? null,
      source_invoice_id: invoice.id,
      template,
      frequency: input.frequency,
      next_run_on: input.startOn,
      day_of_month: input.frequency === "weekly" ? null : startDate.getDate(),
      auto_send: input.autoSend,
      recipient_email: recipient,
      created_by: userId,
    })
    .select(SCHEDULE_COLUMNS)
    .single()

  if (error || !data) throw new Error(`Failed to create schedule: ${error?.message}`)

  await recordEvent({
    orgId,
    eventType: "invoice_schedule_created",
    entityType: "invoice_schedule",
    entityId: data.id,
    channel: "activity",
    payload: { frequency: input.frequency, auto_send: input.autoSend, source_invoice_id: invoice.id },
  })
  await recordAudit({
    orgId,
    action: "insert",
    entityType: "invoice_schedule",
    entityId: data.id,
    after: { frequency: input.frequency, next_run_on: input.startOn, auto_send: input.autoSend },
  })

  return mapScheduleRow(data)
}

export async function listInvoiceSchedules(projectId?: string): Promise<InvoiceSchedule[]> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "invoice.read",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "invoice_schedule",
  })
  let query = supabase
    .from("invoice_schedules")
    .select(SCHEDULE_COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
  if (projectId) query = query.eq("project_id", projectId)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list schedules: ${error.message}`)
  return (data ?? []).map(mapScheduleRow)
}

export async function setInvoiceScheduleActive(scheduleId: string, active: boolean): Promise<InvoiceSchedule> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireScheduleWriteAccess({ supabase, orgId, userId, scheduleId })
  const { data, error } = await supabase
    .from("invoice_schedules")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", scheduleId)
    .select(SCHEDULE_COLUMNS)
    .single()
  if (error || !data) throw new Error(`Failed to update schedule: ${error?.message}`)
  await recordAudit({
    orgId,
    action: "update",
    entityType: "invoice_schedule",
    entityId: scheduleId,
    after: { active },
  })
  return mapScheduleRow(data)
}

export async function deleteInvoiceSchedule(scheduleId: string): Promise<void> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireScheduleWriteAccess({ supabase, orgId, userId, scheduleId })
  const { error } = await supabase.from("invoice_schedules").delete().eq("org_id", orgId).eq("id", scheduleId)
  if (error) throw new Error(`Failed to delete schedule: ${error.message}`)
  await recordAudit({
    orgId,
    action: "delete",
    entityType: "invoice_schedule",
    entityId: scheduleId,
  })
}

async function requireScheduleWriteAccess(params: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  userId: string
  scheduleId: string
}) {
  const { data: schedule } = await params.supabase
    .from("invoice_schedules")
    .select("id, project_id")
    .eq("org_id", params.orgId)
    .eq("id", params.scheduleId)
    .maybeSingle()
  if (!schedule) throw new Error("Schedule not found")
  await requireAuthorization({
    permission: "invoice.write",
    userId: params.userId,
    orgId: params.orgId,
    projectId: schedule.project_id ?? undefined,
    supabase: params.supabase,
    logDecision: true,
    resourceType: "invoice_schedule",
    resourceId: params.scheduleId,
  })
}

function advanceRunDate(schedule: { frequency: InvoiceScheduleFrequency; day_of_month: number | null }, from: Date): Date {
  if (schedule.frequency === "weekly") return addDays(from, 7)
  const monthsToAdd = schedule.frequency === "monthly" ? 1 : 3
  const base = addMonths(from, monthsToAdd)
  if (!schedule.day_of_month) return base
  const clampedDay = Math.min(schedule.day_of_month, new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate())
  return new Date(base.getFullYear(), base.getMonth(), clampedDay)
}

async function nextLocalInvoiceNumber(serviceClient: ReturnType<typeof createServiceSupabaseClient>, orgId: string) {
  const [{ data: connection }, { data: recent }] = await Promise.all([
    serviceClient.from("qbo_connections").select("settings").eq("org_id", orgId).eq("status", "active").maybeSingle(),
    serviceClient
      .from("invoices")
      .select("invoice_number")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(25),
  ])
  const settings = (connection?.settings ?? null) as { invoice_number_pattern?: any; invoice_number_prefix?: string | null } | null
  const latest = (recent ?? [])
    .map((row) => String(row.invoice_number ?? ""))
    .filter(Boolean)
    .reduce<string | null>(
      (best, candidate) => (best === null || compareInvoiceNumbers(candidate, best, settings) > 0 ? candidate : best),
      null,
    )
  return incrementInvoiceNumber(latest ?? "1000", settings)
}

export interface ScheduleRunResult {
  scheduleId: string
  status: "created" | "failed"
  invoiceId?: string
  invoiceNumber?: string
  error?: string
}

/** Cron entry point: generate an invoice for every schedule that has come due. */
export async function runDueInvoiceSchedules(today = new Date()): Promise<ScheduleRunResult[]> {
  const serviceClient = createServiceSupabaseClient()
  const todayStr = format(today, "yyyy-MM-dd")

  const { data: due, error } = await serviceClient
    .from("invoice_schedules")
    .select(SCHEDULE_COLUMNS)
    .eq("active", true)
    .lte("next_run_on", todayStr)
    .order("org_id", { ascending: true })

  if (error) throw new Error(`Failed to load due schedules: ${error.message}`)

  const results: ScheduleRunResult[] = []
  // Sequential on purpose: per-org invoice numbers derive from the latest inserted row.
  for (const row of due ?? []) {
    try {
      const template = (row.template ?? {}) as Record<string, any>
      const invoiceNumber = await nextLocalInvoiceNumber(serviceClient, row.org_id)
      const termsDays = Number(template.payment_terms_days ?? 15)
      const recipient = row.auto_send && row.recipient_email ? [String(row.recipient_email)] : undefined

      // Templates are stored JSONB — validate through the same schema as user-submitted invoices.
      const input = invoiceInputSchema.parse({
        ...template,
        invoice_number: invoiceNumber,
        issue_date: todayStr,
        due_date: format(addDays(today, Number.isFinite(termsDays) ? termsDays : 15), "yyyy-MM-dd"),
        status: row.auto_send ? "sent" : "saved",
        client_visible: Boolean(row.auto_send),
        sent_to_emails: recipient,
        source_type: "manual",
        reservation_id: undefined,
      })

      const scheduleOrg = Array.isArray(row.org) ? row.org[0] : row.org
      const invoice = await createInvoice({
        input,
        context: {
          supabase: serviceClient,
          orgId: row.org_id,
          userId: row.created_by,
          productTier: normalizeProductTier(scheduleOrg?.product_tier),
        },
      })

      await serviceClient
        .from("invoice_schedules")
        .update({
          last_run_at: new Date().toISOString(),
          last_invoice_id: invoice.id,
          next_run_on: format(advanceRunDate(row, new Date(`${row.next_run_on}T00:00:00`)), "yyyy-MM-dd"),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)

      await recordEvent({
        orgId: row.org_id,
        actorId: row.created_by,
        eventType: "invoice_schedule_run",
        entityType: "invoice_schedule",
        entityId: row.id,
        channel: "activity",
        payload: { invoice_id: invoice.id, invoice_number: invoiceNumber, auto_send: row.auto_send },
      })

      results.push({ scheduleId: row.id, status: "created", invoiceId: invoice.id, invoiceNumber })
    } catch (runError) {
      console.error("[invoice-schedules] Failed to run schedule", row.id, runError)
      results.push({
        scheduleId: row.id,
        status: "failed",
        error: runError instanceof Error ? runError.message : "Unknown error",
      })
    }
  }

  return results
}
