import { randomUUID } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { Invoice, InvoiceLine, InvoiceTotals, InvoiceView } from "@/lib/types"
import type { InvoiceInput, InvoiceLineInput } from "@/lib/validation/invoices"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { sendEmail, renderEmailTemplate } from "@/lib/services/mailer"
import { InvoiceEmail } from "@/lib/emails/invoice-email"
import { markReservationUsed } from "@/lib/services/invoice-numbers"
import { enqueueInvoiceSync } from "@/lib/services/qbo-sync"
import { recalcInvoiceBalanceAndStatus } from "@/lib/services/invoice-balance"

type InvoiceRow = {
  id: string
  org_id: string
  project_id?: string | null
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
  }))
}

function calculateTotals(lines: InvoiceLineInput[], taxRate = 0): InvoiceTotals {
  const normalized = normalizeLines(lines)

  const subtotal_cents = normalized.reduce((sum, line) => {
    return sum + Math.round(line.quantity * line.unit_cost_cents)
  }, 0)

  const taxableBase = normalized.reduce((sum, line) => {
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

function shouldQueueQboSync(status?: string | null, clientVisible?: boolean | null) {
  if (clientVisible) return true
  const normalized = String(status ?? "").toLowerCase()
  return normalized === "sent" || normalized === "partial" || normalized === "paid" || normalized === "overdue"
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
      "id, org_id, project_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, qbo_id, qbo_synced_at, qbo_sync_status, created_at, updated_at, viewed_at, sent_at, sent_to_emails",
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

  const lines = normalizeLines(input.lines)
  const totals = calculateTotals(input.lines, input.tax_rate)
  const shouldGenerateToken = input.client_visible === true || input.status === "sent"
  const token = shouldGenerateToken ? randomUUID() : null
  const sourceType = input.source_type ?? "manual"
  const sourceDrawId = input.source_draw_id ?? null
  const sourceChangeOrderId = input.source_change_order_id ?? null

  await assertSourceNotAlreadyBilled({
    supabase,
    orgId: resolvedOrgId,
    sourceType,
    sourceDrawId,
    sourceChangeOrderId,
  })

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
      source_type: sourceType,
      source_draw_id: sourceDrawId,
      source_change_order_id: sourceChangeOrderId,
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
      "id, org_id, project_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, sent_to_emails, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, qbo_id, qbo_synced_at, qbo_sync_status, created_at, updated_at, viewed_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create invoice: ${error?.message}`)
  }

  // Insert lines
  const { error: linesError } = await supabase.from("invoice_lines").insert(
    lines.map((line) => ({
      org_id: resolvedOrgId,
      invoice_id: data.id,
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unit_price_cents: line.unit_cost_cents,
      metadata: { taxable: line.taxable ?? true },
    })),
  )

  if (linesError) {
    throw new Error(`Failed to create invoice lines: ${linesError.message}`)
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

  return mapInvoiceRow(data as InvoiceRow)
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
    .select("id, org_id, token, client_visible, status, sent_at, sent_to_emails, balance_due_cents, metadata, qbo_id")
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error(existingError?.message ?? "Invoice not found")
  }

  const lines = normalizeLines(input.lines)
  const totals = calculateTotals(input.lines, input.tax_rate)
  const shouldGenerateToken =
    existing.token != null || existing.client_visible === true || input.client_visible === true || input.status === "sent"
  const token = shouldGenerateToken ? existing.token ?? randomUUID() : existing.token ?? null
  const sentAt = shouldGenerateToken ? existing.sent_at ?? new Date().toISOString() : existing.sent_at ?? null
  const isFirstSend = shouldGenerateToken && !existing.sent_at
  const sentTo =
    input.sent_to_emails && input.sent_to_emails.length > 0 ? input.sent_to_emails : existing.sent_to_emails ?? null
  const sourceType = input.source_type ?? (existing.metadata as any)?.source_type ?? "manual"
  const sourceDrawId = input.source_draw_id ?? (existing.metadata as any)?.source_draw_id ?? null
  const sourceChangeOrderId = input.source_change_order_id ?? (existing.metadata as any)?.source_change_order_id ?? null

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
      source_type: sourceType,
      source_draw_id: sourceDrawId,
      source_change_order_id: sourceChangeOrderId,
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
      "id, org_id, project_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, sent_to_emails, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, qbo_id, qbo_synced_at, qbo_sync_status, created_at, updated_at, viewed_at, sent_at",
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
      metadata: { taxable: line.taxable ?? true },
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

  return mapInvoiceRow(data as InvoiceRow)
}

export async function getInvoiceForPortal(invoiceId: string, orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, sent_at, sent_to_emails, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
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
      "id, org_id, project_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, sent_at, sent_to_emails, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
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
      "id, org_id, project_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, sent_to_emails, sent_at, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, qbo_id, qbo_synced_at, qbo_sync_status, created_at, updated_at, viewed_at, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
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
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select("invoice_number, title, token, sent_to_emails, project:projects(name)")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle()

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
    })
  )

  await sendEmail({
    to: uniqueRecipients,
    subject,
    html,
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
