"use server"

import { revalidatePath } from "next/cache"

import {
  createInvoice,
  deleteInvoice,
  ensureInvoiceToken,
  getOrCreateInvoiceToken,
  getInvoiceWithLines,
  listInvoiceViews,
  listInvoices,
  moveInvoiceToProject,
  reviseInvoice,
  updateInvoice,
  voidInvoice,
} from "@/lib/services/invoices"
import { listProjects } from "@/lib/services/projects"
import { processAccountingPush } from "@/lib/services/accounting-sync"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { invoiceInputSchema } from "@/lib/validation/invoices"
import { sendReminderEmail } from "@/lib/services/mailer"
import { listChangeOrders } from "@/lib/services/change-orders"
import { listCostPlusTabData, getProjectCostContract, resolveMarkupPercent, calculateMarkupCents } from "@/lib/services/cost-plus"
import { renderInvoicePdf } from "@/lib/pdfs/invoice"
import { buildInvoicePdfData } from "@/lib/pdfs/invoice-data"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { createFileRecord } from "@/lib/services/files"
import { createInitialVersion } from "@/lib/services/file-versions"
import { attachFile } from "@/lib/services/file-links"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { getProvider } from "@/lib/integrations/accounting/registry"
import { recordEvent } from "@/lib/services/events"
import { getInvoicePaymentActivity } from "@/lib/services/payments"
import {
  createInvoiceLienWaiver,
  listInvoiceLienWaivers,
  voidInvoiceLienWaiver,
  type InvoiceLienWaiverType,
} from "@/lib/services/invoice-lien-waivers"
import {
  createInvoiceScheduleFromInvoice,
  deleteInvoiceSchedule,
  listInvoiceSchedules,
  setInvoiceScheduleActive,
  type InvoiceScheduleFrequency,
} from "@/lib/services/invoice-schedules"
import { unwrapAction, actionError, type ActionResult  } from "@/lib/action-result"

const INVOICE_PDF_TEMPLATE_VERSION = 2

// Thrown errors are redacted to a digest in prod, so every action returns an ActionResult
// (see lib/action-result.ts); clients unwrap with unwrapAction().
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    console.error("[invoices.action]", error)
    return actionError(error)
  }
}

export async function listInvoicesAction(
  projectId?: string,
  options?: { limit?: number; offset?: number; search?: string },
) {
  return run(() =>
    listInvoices({ projectId, limit: options?.limit, offset: options?.offset, search: options?.search }),
  )
}

export async function createInvoiceAction(input: unknown) {
  return run(async () => {
    const startedAt = Date.now()
    const parsed = invoiceInputSchema.parse(input)
    const invoice = await createInvoice({ input: parsed })
    const durationMs = Date.now() - startedAt
    if (durationMs >= 1500) {
      console.warn("[invoice.create] Slow create detected", { durationMs, invoiceId: invoice.id })
      try {
        await recordEvent({
          eventType: "invoice_create_slow",
          entityType: "invoice",
          entityId: invoice.id,
          channel: "integration",
          payload: { duration_ms: durationMs },
        })
      } catch {
        // Non-blocking telemetry.
      }
    }
    revalidatePath("/invoices")
    return invoice
  })
}

export async function createQBOIncomeAccountAction(name: string, projectId?: string | null) {
  return run(async () => {
    const normalized = String(name ?? "").trim()
    if (normalized.length < 2) {
      throw new Error("Account name must be at least 2 characters")
    }
    if (normalized.length > 100) {
      throw new Error("Account name must be 100 characters or fewer")
    }

    const { orgId } = await requireOrgContext()
    const target = await resolveAccountingTarget({ orgId, projectId })
    const provider = target ? getProvider(target.connection.provider) : null
    if (!target || !provider?.createAccount) throw new Error("The mapped accounting provider cannot create income accounts")
    return provider.createAccount({ connectionId: target.connection.id, kind: "income", name: normalized })
  })
}

export async function updateInvoiceAction(invoiceId: string, input: unknown) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const startedAt = Date.now()
    const parsed = invoiceInputSchema.parse(input)
    const invoice = await updateInvoice({ invoiceId, input: parsed })
    const durationMs = Date.now() - startedAt
    if (durationMs >= 1500) {
      console.warn("[invoice.update] Slow update detected", { durationMs, invoiceId })
      try {
        await recordEvent({
          eventType: "invoice_update_slow",
          entityType: "invoice",
          entityId: invoiceId,
          channel: "integration",
          payload: { duration_ms: durationMs },
        })
      } catch {
        // Non-blocking telemetry.
      }
    }
    revalidatePath("/invoices")
    return invoice
  })
}

export async function voidInvoiceAction(invoiceId: string) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const invoice = await voidInvoice({ invoiceId })
    revalidatePath("/invoices")
    if (invoice.project_id) {
      revalidatePath(`/projects/${invoice.project_id}/financials/receivables`)
    }
    return invoice
  })
}

export async function reviseInvoiceAction(invoiceId: string) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const invoice = await reviseInvoice({ invoiceId })
    revalidatePath("/invoices")
    if (invoice.project_id) {
      revalidatePath(`/projects/${invoice.project_id}/financials/receivables`)
    }
    return invoice
  })
}

export async function deleteInvoiceAction(invoiceId: string) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const result = await deleteInvoice({ invoiceId })
    revalidatePath("/invoices")
    if (result.projectId) {
      revalidatePath(`/projects/${result.projectId}/financials/receivables`)
    }
  })
}

export async function listMovableProjectsAction() {
  return run(async () => {
    const projects = await listProjects()
    return projects.map((project) => ({ id: project.id, name: project.name }))
  })
}

export async function moveInvoiceToProjectAction(invoiceId: string, targetProjectId: string) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    if (!targetProjectId) throw new Error("A destination project is required")
    const result = await moveInvoiceToProject({ invoiceId, targetProjectId })
    revalidatePath("/invoices")
    if (result.fromProjectId) {
      revalidatePath(`/projects/${result.fromProjectId}/financials/receivables`)
    }
    revalidatePath(`/projects/${result.toProjectId}/financials/receivables`)
    return result.invoice
  })
}

export async function generateInvoiceLinkAction(invoiceId: string) {
  return run(async () => {
    if (!invoiceId) {
      throw new Error("Invoice id is required")
    }

    const token = await ensureInvoiceToken(invoiceId)
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"

    return {
      token,
      url: `${appUrl}/i/${token}`,
    }
  })
}

export async function getInvoiceDetailAction(invoiceId: string) {
  return run(() => loadInvoiceDetail(invoiceId))
}

async function loadInvoiceDetail(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")

  const invoice = await getInvoiceWithLines(invoiceId)
  if (!invoice) throw new Error("Invoice not found")

  // Viewing detail must never mutate lifecycle — only guarantee a token exists
  // for invoices that were already shared.
  const token =
    invoice.client_visible || invoice.sent_at || invoice.status === "sent"
      ? await getOrCreateInvoiceToken(invoiceId, invoice.org_id)
      : invoice.token ?? null
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"
  const views = await listInvoiceViews(invoiceId, invoice.org_id)
  const supabase = createServiceSupabaseClient()
  const { data: syncHistory } = await supabase
    .from("accounting_sync_records")
    .select("id, status, last_synced_at, error_message, external_id")
    .eq("org_id", invoice.org_id)
    .eq("entity_type", "invoice")
    .eq("entity_id", invoiceId)
    .order("last_synced_at", { ascending: false })

  const paymentActivity = await getInvoicePaymentActivity(invoiceId, invoice.org_id).catch((error) => {
    console.error("Failed to load invoice payment activity", error)
    return { payments: [], reversals: [] }
  })

  const lienWaivers = await listInvoiceLienWaivers(invoiceId, invoice.org_id).catch((error) => {
    console.error("Failed to load invoice lien waivers", error)
    return []
  })

  return {
    invoice: { ...invoice, token },
    link: token ? `${appUrl}/i/${token}` : undefined,
    views,
    syncHistory: (syncHistory ?? []).map((record) => ({ ...record, qbo_id: record.external_id })),
    payments: paymentActivity.payments,
    reversals: paymentActivity.reversals,
    lienWaivers,
  }
}

export async function createInvoiceLienWaiverAction(input: {
  invoiceId: string
  waiverType: InvoiceLienWaiverType
  throughDate?: string
}) {
  return run(async () => {
    const waiver = await createInvoiceLienWaiver({
      invoice_id: input.invoiceId,
      waiver_type: input.waiverType,
      through_date: input.throughDate,
    })
    revalidatePath("/invoices")
    return waiver
  })
}

export async function voidInvoiceLienWaiverAction(waiverId: string) {
  return run(async () => {
    await voidInvoiceLienWaiver(waiverId)
    revalidatePath("/invoices")
  })
}

export async function updateInvoiceNotesAction(invoiceId: string, notes: string) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const { supabase, orgId, userId } = await requireOrgContext()
    const { data: invoice } = await supabase
      .from("invoices")
      .select("id, project_id")
      .eq("org_id", orgId)
      .eq("id", invoiceId)
      .maybeSingle()
    if (!invoice) throw new Error("Invoice not found")
    await requireAuthorization({
      permission: "invoice.write",
      userId,
      orgId,
      projectId: invoice.project_id ?? undefined,
      supabase,
      logDecision: true,
      resourceType: "invoice",
      resourceId: invoiceId,
    })
    const trimmed = notes.trim()
    const { error } = await supabase
      .from("invoices")
      .update({ notes: trimmed.length > 0 ? trimmed : null })
      .eq("org_id", orgId)
      .eq("id", invoiceId)
    if (error) {
      throw new Error(`Failed to save notes: ${error.message}`)
    }
    revalidatePath("/invoices")
  })
}

export async function manualResyncInvoiceAction(invoiceId: string) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const { orgId } = await requireOrgContext()
    await processAccountingPush({ orgId, entityType: "invoice", entityId: invoiceId })
    revalidatePath("/invoices")
  })
}

export async function sendInvoiceReminderAction(invoiceId: string) {
  return run(() => sendInvoiceReminder(invoiceId))
}

export async function createInvoiceScheduleAction(input: {
  invoiceId: string
  frequency: InvoiceScheduleFrequency
  startOn: string
  autoSend: boolean
  recipientEmail?: string | null
}) {
  return run(async () => {
    const schedule = await createInvoiceScheduleFromInvoice(input)
    revalidatePath("/invoices")
    return schedule
  })
}

export async function listInvoiceSchedulesAction(projectId?: string) {
  return run(() => listInvoiceSchedules(projectId))
}

export async function setInvoiceScheduleActiveAction(scheduleId: string, active: boolean) {
  return run(() => setInvoiceScheduleActive(scheduleId, active))
}

export async function deleteInvoiceScheduleAction(scheduleId: string) {
  return run(() => deleteInvoiceSchedule(scheduleId))
}

async function sendInvoiceReminder(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")

  const { orgId, supabase } = await requireOrgContext()
  const invoice = await getInvoiceWithLines(invoiceId, orgId)

  if (!invoice) throw new Error("Invoice not found")
  if (invoice.status === "paid" || invoice.status === "void") {
    throw new Error("Cannot send reminder for paid or void invoices")
  }
  const wasSent = Boolean(invoice.sent_at) || ["sent", "partial", "overdue"].includes(invoice.status ?? "")
  if (!wasSent) {
    throw new Error("This invoice hasn't been sent yet — send the invoice first")
  }

  // Get recipient email from sent_to_emails or metadata
  const recipientEmail = invoice.sent_to_emails?.[0] ?? (invoice.metadata as Record<string, any> | null)?.customer_email
  if (!recipientEmail) {
    throw new Error("No recipient email found for this invoice")
  }

  const token = await ensureInvoiceToken(invoiceId, orgId)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"
  const payLink = `${appUrl}/i/${token}`

  // Calculate days overdue if applicable
  const dueDate = invoice.due_date ? new Date(invoice.due_date) : null
  const now = new Date()
  let daysOverdue: number | undefined
  if (dueDate && now > dueDate) {
    daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
  }

  const { data: org } = await supabase.from("orgs").select("name, logo_url, slug").eq("id", orgId).maybeSingle()

  await sendReminderEmail({
    to: recipientEmail,
    recipientName: (invoice.metadata as any)?.customer_name ?? null,
    invoiceNumber: invoice.invoice_number,
    amountDue: invoice.balance_due_cents ?? invoice.total_cents ?? 0,
    dueDate: invoice.due_date ?? new Date().toISOString(),
    daysOverdue,
    payLink,
    orgName: org?.name ?? null,
    orgLogoUrl: org?.logo_url ?? null,
    orgSlug: org?.slug ?? null,
  })
}

export async function getInvoiceComposerContextAction(projectId?: string | null) {
  return run(() => loadInvoiceComposerContext(projectId))
}

async function loadInvoiceComposerContext(projectId?: string | null) {
  const { supabase, orgId } = await requireOrgContext()

  let drawRows: Array<{
    id: string
    project_id: string
    draw_number: number
    title: string
    description: string | null
    amount_cents: number
    due_date: string | null
    status: string
  }> = []

  if (projectId) {
    const { data, error: drawError } = await supabase
      .from("draw_schedules")
      .select("id, project_id, draw_number, title, description, amount_cents, due_date, status")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["pending", "partial"])
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("draw_number", { ascending: true })

    if (drawError) {
      console.warn("Failed to load draw schedule context", drawError)
    } else {
      drawRows = (data ?? []) as typeof drawRows
    }
  }

  let billedChangeOrderIds = new Set<string>()
  if (projectId) {
    const { data: invoiceRows } = await supabase
      .from("invoices")
      .select("status, metadata")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .neq("status", "void")

    billedChangeOrderIds = new Set(
      (invoiceRows ?? [])
        .map((row: any) => (row.metadata as Record<string, any> | null)?.source_change_order_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    )
  }

  const changeOrders = projectId
    ? await listChangeOrders({ orgId, projectId })
        .then((rows) =>
          rows.filter((co) => {
            const status = String(co.status ?? "").toLowerCase()
            return status === "approved" && !billedChangeOrderIds.has(co.id)
          }),
        )
        .catch(() => [])
    : []

  // The project's default QBO customer (set in project settings) — used to pre-select the composer's
  // "bill to" picker so invoices and payables attribute to the same customer by default.
  const accountingTarget = await resolveAccountingTarget({ orgId, projectId })
  const defaultQboCustomer = accountingTarget?.dimensions.customer?.id
    ? { id: accountingTarget.dimensions.customer.id, name: accountingTarget.dimensions.customer.name ?? "" }
    : null

  const { data: orgSettingsRow } = await supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle()
  const settings = (orgSettingsRow?.settings as Record<string, any> | null) ?? {}

  const { data: qboConnection } = accountingTarget ? await supabase
    .from("accounting_connections")
    .select("status, settings, last_error, refresh_failure_count")
    .eq("org_id", orgId)
    .eq("id", accountingTarget.connection.id)
    .maybeSingle()
    : { data: null }

  let qboConnected = Boolean(qboConnection)
  const qboDefaultIncomeAccountId =
    typeof (qboConnection?.settings as any)?.default_income_account_id === "string" ? (qboConnection?.settings as any).default_income_account_id : null

  let qboIncomeAccounts: Array<{ id: string; name: string; fullyQualifiedName?: string }> = []
  let qboAccountLoadWarning: string | null = null
  if (qboConnected) {
    try {
      const provider = accountingTarget ? getProvider(accountingTarget.connection.provider) : null
      if (!provider || !accountingTarget) qboConnected = false
      else {
        qboIncomeAccounts = (await provider.listAccounts({ connectionId: accountingTarget.connection.id, kind: "income" }))
          .map((account) => ({ ...account, name: account.name ?? account.id, fullyQualifiedName: account.fullyQualifiedName ?? undefined }))
        if (qboIncomeAccounts.length === 0) {
          qboAccountLoadWarning = "QuickBooks returned no income accounts. Check your chart of accounts and default income account."
        }
      }
    } catch (error) {
      console.warn("Unable to load QBO income accounts for invoice composer", error)
      qboAccountLoadWarning = error instanceof Error ? error.message : "Unable to load QuickBooks income accounts."
    }
  }

  return {
    draws: drawRows.map((draw) => ({
      id: draw.id as string,
      project_id: draw.project_id as string,
      draw_number: Number(draw.draw_number ?? 0),
      title: String(draw.title ?? ""),
      description: draw.description ? String(draw.description) : null,
      amount_cents: Number(draw.amount_cents ?? 0),
      due_date: draw.due_date ? String(draw.due_date) : null,
      status: String(draw.status ?? "pending"),
    })),
    changeOrders,
    defaultQboCustomer,
    qboConnected,
    qboIncomeAccounts,
    qboDefaultIncomeAccountId,
    qboDiagnostics: {
      connectionLastError: (qboConnection as any)?.last_error ?? null,
      refreshFailureCount: Number((qboConnection as any)?.refresh_failure_count ?? 0),
      accountLoadWarning: qboAccountLoadWarning,
    },
    settings: {
      defaultPaymentTermsDays: Number(settings.invoice_default_payment_terms_days ?? 15),
      defaultInvoiceNote: String(settings.invoice_default_payment_details ?? settings.invoice_default_note ?? ""),
    },
  }
}

/**
 * Server-side typeahead for the invoice composer's "bill to" picker. When QBO is connected, QBO is
 * the source of truth — we query it live by DisplayName prefix so there's no second customer base to
 * keep in sync. Returns [] when QBO isn't connected (the composer falls back to Arc contacts / manual).
 */
export async function searchQboCustomersAction(term: string, projectId?: string | null) {
  return run(async () => {
    const { orgId } = await requireOrgContext()
    const target = await resolveAccountingTarget({ orgId, projectId }).catch(() => null)
    const provider = target ? getProvider(target.connection.provider) : null
    if (!target || !provider?.searchCounterparties) return { connected: false, customers: [] }
    try {
      const customers = await provider.searchCounterparties({ connectionId: target.connection.id, role: "customer", term })
      return { connected: true, customers }
    } catch (error) {
      console.warn("Accounting customer search failed", error)
      return { connected: true, customers: [] }
    }
  })
}

/**
 * Create a customer directly in QuickBooks from the composer, so new customers are born in the source
 * of truth instead of an Arc-only base that drifts. Returns the new QBO customer to bill against.
 */
export async function createQboCustomerAction(input: {
  name: string
  email?: string | null
  line1?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
  projectId?: string | null
}) {
  return run(async () => {
    const { orgId } = await requireOrgContext()
    const name = input.name?.trim()
    if (!name) throw new Error("Customer name is required")
    const target = await resolveAccountingTarget({ orgId, projectId: input.projectId })
    const provider = target ? getProvider(target.connection.provider) : null
    if (!target || !provider?.createCounterparty) throw new Error("The mapped accounting provider cannot create customers")
    return provider.createCounterparty({ connectionId: target.connection.id, role: "customer", counterparty: {
      displayName: name,
      email: input.email ?? null,
      line1: input.line1 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
    } })
  })
}

/**
 * Unbilled, billable costs for a cost-plus / T&M project — feeds the invoice composer's
 * "Add from → Unbilled costs" picker. Only status "open", billable, and not yet on an invoice.
 */
export async function listUnbilledCostsAction(projectId: string) {
  return run(() => loadUnbilledCosts(projectId))
}

async function loadUnbilledCosts(projectId: string) {
  if (!projectId) return { costs: [] }
  const { supabase, orgId } = await requireOrgContext()
  const contract = await getProjectCostContract(supabase, orgId, projectId)
  const data = await listCostPlusTabData(projectId, orgId)
  
  const costs = []
  for (const cost of data.billableCosts ?? []) {
    if (cost.status !== "open" || !cost.is_billable || cost.invoice_id) continue

    let resolvedMarkupPercent = cost.markup_percent_resolved
    let resolvedMarkupCents = cost.markup_cents
    let resolvedBillableCents = cost.billable_cents

    if (contract) {
      const markup = await resolveMarkupPercent({
        supabase,
        orgId,
        contractId: contract.id,
        costCodeId: cost.cost_code_id ?? null,
        occurredOn: new Date(cost.occurred_on),
      })
      resolvedMarkupPercent = markup.percent
      resolvedMarkupCents = calculateMarkupCents(cost.cost_cents, markup.percent)
      resolvedBillableCents = cost.cost_cents + resolvedMarkupCents
    }

    costs.push({
      id: cost.id,
      occurredOn: cost.occurred_on,
      description: cost.description ?? "",
      sourceType: cost.source_type,
      costCodeId: cost.cost_code_id,
      costCode: cost.cost_code_code,
      costCodeName: cost.cost_code_name,
      costCents: cost.cost_cents,
      markupCents: resolvedMarkupCents,
      markupPercent: resolvedMarkupPercent,
      billableCents: resolvedBillableCents,
    })
  }
  return { costs }
}

export async function generateInvoicePdfAction(
  invoiceId: string,
  options?: {
    persistToArc?: boolean
  },
) {
  return run(() => generateInvoicePdf(invoiceId, options))
}

async function generateInvoicePdf(
  invoiceId: string,
  options?: {
    persistToArc?: boolean
  },
) {
  if (!invoiceId) throw new Error("Invoice id is required")
  const startedAt = Date.now()

  const { supabase, orgId } = await requireOrgContext()
  const persistToArc = options?.persistToArc === true

  const invoice = await getInvoiceWithLines(invoiceId, orgId)
  if (!invoice) {
    throw new Error("Invoice not found")
  }

  const metadata = (invoice.metadata ?? {}) as Record<string, any>
  const cachedPdfFileId = typeof metadata.latest_pdf_file_id === "string" ? metadata.latest_pdf_file_id : null
  const cachedPdfForUpdatedAt = typeof metadata.latest_pdf_invoice_updated_at === "string" ? metadata.latest_pdf_invoice_updated_at : null
  const cachedPdfTemplateVersion =
    typeof metadata.latest_pdf_template_version === "number" ? metadata.latest_pdf_template_version : Number(metadata.latest_pdf_template_version ?? 0)
  const invoiceUpdatedAt = typeof invoice.updated_at === "string" ? invoice.updated_at : null

  if (
    persistToArc &&
    cachedPdfFileId &&
    cachedPdfForUpdatedAt &&
    invoiceUpdatedAt &&
    cachedPdfForUpdatedAt === invoiceUpdatedAt &&
    cachedPdfTemplateVersion === INVOICE_PDF_TEMPLATE_VERSION
  ) {
    return {
      fileId: cachedPdfFileId,
      fileName: `invoice-${String(invoice.invoice_number).replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`,
      downloadUrl: `/api/files/${cachedPdfFileId}/raw`,
      pdfBase64: null,
      durationMs: Date.now() - startedAt,
      persistedToArc: true,
      fromCache: true,
    }
  }

  const [projectResult, orgResult, orgSettingsResult, token] = await Promise.all([
    invoice.project_id
      ? supabase.from("projects").select("name").eq("org_id", orgId).eq("id", invoice.project_id).maybeSingle()
      : Promise.resolve({ data: null as any }),
    supabase.from("orgs").select("name, billing_email, address, logo_url").eq("id", orgId).maybeSingle(),
    supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle(),
    getOrCreateInvoiceToken(invoice.id, orgId),
  ])

  const project = projectResult.data
  const org = orgResult.data
  const orgSettings = (orgSettingsResult.data?.settings as Record<string, any> | null) ?? {}

  const pdfData = await buildInvoicePdfData({
    supabase,
    invoice,
    org,
    orgSettings,
    projectName: project?.name ?? null,
    token,
  })

  const pdfBuffer = await renderInvoicePdf(pdfData)
  const pdfBase64 = pdfBuffer.toString("base64")

  if (!persistToArc) {
    const durationMs = Date.now() - startedAt
    if (durationMs >= 5000) {
      console.warn("[invoice.pdf] Slow PDF render detected", { durationMs, invoiceId })
      try {
        await recordEvent({
          eventType: "invoice_pdf_render_slow",
          entityType: "invoice",
          entityId: invoice.id,
          channel: "integration",
          payload: {
            duration_ms: durationMs,
            persisted_to_arc: false,
          },
        })
      } catch {
        // Non-blocking telemetry.
      }
    }
    return {
      fileId: null,
      fileName: `invoice-${String(invoice.invoice_number).replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`,
      downloadUrl: null,
      pdfBase64,
      durationMs,
      persistedToArc: false,
      fromCache: false,
    }
  }

  const safeInvoiceNumber = String(invoice.invoice_number).replace(/[^a-zA-Z0-9._-]/g, "_")
  const fileName = `invoice-${safeInvoiceNumber}.pdf`
  const timestamp = Date.now()
  const storagePath = invoice.project_id
    ? `${orgId}/${invoice.project_id}/invoices/${timestamp}_${fileName}`
    : `${orgId}/general/invoices/${timestamp}_${fileName}`

  await uploadFilesObject({
    supabase,
    orgId,
    path: storagePath,
    bytes: pdfBuffer,
    contentType: "application/pdf",
    upsert: false,
  })

  const fileRecord = await createFileRecord({
    project_id: invoice.project_id ?? undefined,
    file_name: fileName,
    storage_path: storagePath,
    mime_type: "application/pdf",
    size_bytes: pdfBuffer.length,
    visibility: "private",
    category: "financials",
    folder_path: "Financials/Invoices",
    description: `Invoice PDF for ${invoice.invoice_number}`,
    source: "generated",
    share_with_clients: true,
    share_with_subs: false,
  })

  await createInitialVersion({
    fileId: fileRecord.id,
    storagePath,
    fileName,
    mimeType: "application/pdf",
    sizeBytes: pdfBuffer.length,
  })

  await attachFile({
    file_id: fileRecord.id,
    entity_type: "invoice",
    entity_id: invoice.id,
    project_id: invoice.project_id ?? undefined,
    link_role: "invoice_pdf",
  })

  await supabase
    .from("invoices")
    .update({
      metadata: {
        ...metadata,
        latest_pdf_file_id: fileRecord.id,
        latest_pdf_invoice_updated_at: invoice.updated_at ?? null,
        latest_pdf_generated_at: new Date().toISOString(),
        latest_pdf_template_version: INVOICE_PDF_TEMPLATE_VERSION,
      },
    })
    .eq("org_id", orgId)
    .eq("id", invoice.id)

  const accountingTarget = await resolveAccountingTarget({ orgId, projectId: invoice.project_id })
  const { data: syncRecord } = accountingTarget ? await supabase.from("accounting_sync_records")
    .select("external_id")
    .eq("org_id", orgId)
    .eq("connection_id", accountingTarget.connection.id)
    .eq("entity_type", "invoice")
    .eq("entity_id", invoice.id)
    .eq("status", "synced")
    .maybeSingle() : { data: null }
  if (accountingTarget && syncRecord?.external_id) {
    try {
      const provider = getProvider(accountingTarget.connection.provider)
      if (provider.capabilities.supportsAttachments && provider.uploadInvoiceAttachment) {
        const attachment = await provider.uploadInvoiceAttachment({
          connectionId: accountingTarget.connection.id,
          externalInvoiceId: syncRecord.external_id,
          fileName,
          contentType: "application/pdf",
          content: pdfBuffer,
          note: `Arc invoice PDF ${invoice.invoice_number}`,
        })

        await supabase
          .from("invoices")
          .update({
            metadata: {
              ...metadata,
              latest_pdf_file_id: fileRecord.id,
              latest_pdf_invoice_updated_at: invoice.updated_at ?? null,
              latest_pdf_generated_at: new Date().toISOString(),
              latest_pdf_template_version: INVOICE_PDF_TEMPLATE_VERSION,
              accounting_pdf_attachment_id: attachment.id,
              accounting_pdf_attached_at: new Date().toISOString(),
              accounting_pdf_synced_file_id: fileRecord.id,
              accounting_pdf_external_invoice_id: syncRecord.external_id,
            },
          })
          .eq("org_id", orgId)
          .eq("id", invoice.id)
      }
    } catch (error) {
      console.warn("Failed to attach invoice PDF to accounting provider", error)
    }
  }

  revalidatePath("/invoices")
  if (invoice.project_id) {
    revalidatePath(`/projects/${invoice.project_id}/financials`)
    revalidatePath(`/projects/${invoice.project_id}/financials/receivables`)
  }

  const durationMs = Date.now() - startedAt
  if (durationMs >= 5000) {
    console.warn("[invoice.pdf] Slow PDF generation + persist detected", { durationMs, invoiceId })
    try {
      await recordEvent({
        orgId,
        eventType: "invoice_pdf_slow",
        entityType: "invoice",
        entityId: invoice.id,
        channel: "integration",
        payload: {
          duration_ms: durationMs,
          persisted_to_arc: true,
        },
      })
    } catch {
      // Non-blocking telemetry.
    }
  }

  return {
    fileId: fileRecord.id,
    fileName,
    downloadUrl: `/api/files/${fileRecord.id}/raw`,
    pdfBase64: null,
    durationMs,
    persistedToArc: true,
    fromCache: false,
  }
}
