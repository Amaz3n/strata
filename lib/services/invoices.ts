import type { SupabaseClient } from "@supabase/supabase-js"

import type { Invoice, InvoiceLine, InvoiceTotals } from "@/lib/types"
import type { InvoiceInput, InvoiceLineInput } from "@/lib/validation/invoices"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { sendEmail } from "@/lib/services/mailer"

type InvoiceRow = {
  id: string
  org_id: string
  project_id: string
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
  metadata?: Record<string, any> | null
  created_at?: string
  updated_at?: string
}

function normalizeLines(lines: InvoiceLineInput[]): InvoiceLine[] {
  return lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: Math.round(line.unit_cost * 100),
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
    project_id: row.project_id,
    invoice_number: row.invoice_number,
    title: row.title ?? `Invoice ${row.invoice_number}`,
    status: (row.status as Invoice["status"]) ?? "draft",
    issue_date: row.issue_date ?? undefined,
    due_date: row.due_date ?? undefined,
    notes: row.notes ?? undefined,
    client_visible: row.client_visible ?? undefined,
    subtotal_cents: row.subtotal_cents ?? totals?.subtotal_cents,
    tax_cents: row.tax_cents ?? totals?.tax_cents,
    total_cents: row.total_cents ?? totals?.total_cents,
    balance_due_cents: row.balance_due_cents ?? totals?.balance_due_cents,
    metadata: metadata ?? undefined,
    lines,
    totals,
    created_at: row.created_at,
    updated_at: row.updated_at,
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
      "id, org_id, project_id, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at",
    )
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to list invoices: ${error.message}`)

  const filtered = projectId ? (data ?? []).filter((row: any) => row.project_id === projectId) : data ?? []
  return filtered.map((row: any) => mapInvoiceRow(row as InvoiceRow))
}

export async function createInvoice({ input, orgId }: { input: InvoiceInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const lines = normalizeLines(input.lines)
  const totals = calculateTotals(input.lines, input.tax_rate)

  const payload = {
    org_id: resolvedOrgId,
    project_id: input.project_id,
    invoice_number: input.invoice_number,
    title: input.title,
    status: input.status ?? "draft",
    issue_date: input.issue_date ?? null,
    due_date: input.due_date ?? null,
    notes: input.notes ?? null,
    client_visible: input.client_visible ?? false,
    subtotal_cents: totals.subtotal_cents,
    tax_cents: totals.tax_cents,
    total_cents: totals.total_cents,
    balance_due_cents: totals.total_cents,
    metadata: {
      lines,
      totals,
      tax_rate: input.tax_rate,
      created_by: userId,
    },
  }

  const { data, error } = await supabase
    .from("invoices")
    .insert(payload)
    .select(
      "id, org_id, project_id, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at",
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
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unit_cost_cents: line.unit_cost_cents,
      taxable: line.taxable ?? true,
    })),
  )

  if (linesError) {
    throw new Error(`Failed to create invoice lines: ${linesError.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_created",
    entityType: "invoice",
    entityId: data.id,
    payload: { invoice_number: input.invoice_number, project_id: input.project_id, total_cents: totals.total_cents },
  })

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
      projectId: input.project_id,
      totalCents: totals.total_cents,
      dueDate: input.due_date ?? undefined,
    })
  }

  return mapInvoiceRow(data as InvoiceRow)
}

export async function getInvoiceForPortal(invoiceId: string, orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, invoice_lines (id, description, quantity, unit, unit_cost_cents, taxable)",
    )
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load invoice: ${error.message}`)
  if (!data) return null
  const mapped = mapInvoiceRow(data as InvoiceRow)
  return {
    ...mapped,
    lines: (data as any).invoice_lines ?? mapped.lines ?? [],
  }
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://app.strata.build"

async function sendInvoiceEmail({
  orgId,
  invoiceId,
  projectId,
  totalCents,
  dueDate,
}: {
  orgId: string
  invoiceId: string
  projectId: string
  totalCents?: number
  dueDate?: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select("invoice_number, title, project:projects(name, client_id)")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (error || !invoice) {
    console.warn("Unable to load invoice for email notification", error)
    return
  }

  const recipients: (string | null)[] = []
  if (invoice.project?.client_id) {
    const contact = await fetchContactEmail(supabase, invoice.project.client_id)
    if (contact) recipients.push(contact.email)
  }

  if (recipients.length === 0) {
    console.warn("No recipients for invoice email; skipping", { invoiceId })
    return
  }

  const subject = `Invoice ${invoice.invoice_number}: ${invoice.title ?? "New invoice"}`
  const amount = totalCents != null ? `$${(totalCents / 100).toLocaleString()}` : undefined
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
      <h2 style="margin-bottom: 4px;">${invoice.project?.name ?? "Project"}</h2>
      <p style="margin: 0 0 12px 0; color: #555;">Invoice ${invoice.invoice_number}</p>
      <p style="margin: 0 0 8px 0;"><strong>${invoice.title ?? "New invoice"}</strong></p>
      ${amount ? `<p style="margin: 0 0 8px 0;">Amount: <strong>${amount}</strong></p>` : ""}
      ${dueDate ? `<p style="margin: 0 0 8px 0;">Due: ${dueDate}</p>` : ""}
      <div style="margin-top: 16px;">
        <a href="${APP_URL}/invoices" style="background: #111827; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none;">View invoice</a>
      </div>
    </div>
  `

  await sendEmail({
    to: recipients,
    subject,
    html,
  })
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
