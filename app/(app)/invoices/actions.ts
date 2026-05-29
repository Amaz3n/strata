"use server"

import { revalidatePath } from "next/cache"

import {
  createInvoice,
  deleteInvoice,
  ensureInvoiceToken,
  getInvoiceWithLines,
  listInvoiceViews,
  listInvoices,
  updateInvoice,
  voidInvoice,
} from "@/lib/services/invoices"
import { forceSyncInvoiceToQBO, retryFailedQBOSyncJobs, syncInvoiceToQBO } from "@/lib/services/qbo-sync"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
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
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import { recordEvent } from "@/lib/services/events"

const INVOICE_PDF_TEMPLATE_VERSION = 2

export async function listInvoicesAction(projectId?: string) {
  return listInvoices({ projectId })
}

export async function listInvoiceSyncQueueAction(projectId?: string) {
  const { orgId } = await requireOrgContext()
  const invoices = (await listInvoices({ orgId, projectId })).filter((invoice) => invoice.qbo_sync_status === "pending" || invoice.qbo_sync_status === "error")
  const invoiceIds = invoices.map((invoice) => invoice.id)

  if (invoiceIds.length === 0) {
    return []
  }

  const supabase = createServiceSupabaseClient()
  const { data: syncRecords, error } = await supabase
    .from("qbo_sync_records")
    .select("id, entity_id, status, last_synced_at, error_message, qbo_id, created_at")
    .eq("org_id", orgId)
    .eq("entity_type", "invoice")
    .in("entity_id", invoiceIds)
    .order("last_synced_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load QBO sync queue: ${error.message}`)
  }

  const latestByInvoiceId = new Map<string, (typeof syncRecords)[number]>()
  for (const record of syncRecords ?? []) {
    if (!record.entity_id || latestByInvoiceId.has(record.entity_id)) continue
    latestByInvoiceId.set(record.entity_id, record)
  }

  return invoices.map((invoice) => ({
    invoice,
    latestSync: latestByInvoiceId.get(invoice.id) ?? null,
  }))
}

export async function createInvoiceAction(input: unknown) {
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
}

export async function createQBOIncomeAccountAction(name: string) {
  const normalized = String(name ?? "").trim()
  if (normalized.length < 2) {
    throw new Error("Account name must be at least 2 characters")
  }
  if (normalized.length > 100) {
    throw new Error("Account name must be 100 characters or fewer")
  }

  const { orgId } = await requireOrgContext()
  const client = await QBOClient.forOrg(orgId)
  if (!client) {
    throw new Error("No active QuickBooks connection")
  }

  return client.createIncomeAccount(normalized)
}

export async function updateInvoiceAction(invoiceId: string, input: unknown) {
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
}

export async function voidInvoiceAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")
  const invoice = await voidInvoice({ invoiceId })
  revalidatePath("/invoices")
  if (invoice.project_id) {
    revalidatePath(`/projects/${invoice.project_id}/financials/receivables`)
  }
  return invoice
}

export async function deleteInvoiceAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")
  const result = await deleteInvoice({ invoiceId })
  revalidatePath("/invoices")
  if (result.projectId) {
    revalidatePath(`/projects/${result.projectId}/financials/receivables`)
  }
  return { success: true }
}

export async function generateInvoiceLinkAction(invoiceId: string) {
  if (!invoiceId) {
    throw new Error("Invoice id is required")
  }

  const token = await ensureInvoiceToken(invoiceId)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"

  return {
    token,
    url: `${appUrl}/i/${token}`,
  }
}

export async function getInvoiceDetailAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")

  const invoice = await getInvoiceWithLines(invoiceId)
  if (!invoice) throw new Error("Invoice not found")

  const token = await ensureInvoiceToken(invoiceId, invoice.org_id)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"
  const views = await listInvoiceViews(invoiceId, invoice.org_id)
  const supabase = createServiceSupabaseClient()
  const { data: syncHistory } = await supabase
    .from("qbo_sync_records")
    .select("id, status, last_synced_at, error_message, qbo_id")
    .eq("org_id", invoice.org_id)
    .eq("entity_type", "invoice")
    .eq("entity_id", invoiceId)
    .order("last_synced_at", { ascending: false })

  return {
    invoice: { ...invoice, token },
    link: `${appUrl}/i/${token}`,
    views,
    syncHistory: syncHistory ?? [],
  }
}

export async function manualResyncInvoiceAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")
  const { orgId } = await requireOrgContext()
  const result = await forceSyncInvoiceToQBO(invoiceId, orgId)
  if (!result.success) {
    throw new Error(result.error ?? "Unable to sync invoice")
  }
  revalidatePath("/invoices")
  return { success: true }
}

export async function retryFailedInvoiceSyncsAction() {
  const { orgId } = await requireOrgContext()
  const result = await retryFailedQBOSyncJobs(orgId)
  revalidatePath("/invoices")
  return result
}

export async function syncPendingInvoicesNowAction(limit = 15) {
  const { orgId } = await requireOrgContext()
  const supabase = createServiceSupabaseClient()

  const { data: pending } = await supabase
    .from("invoices")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_sync_status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit)

  if (!pending?.length) {
    revalidatePath("/invoices")
    return { success: true, processed: 0 }
  }

  let processed = 0
  for (const row of pending) {
    const result = await syncInvoiceToQBO(row.id, orgId)
    if (result.success) processed++
  }

  revalidatePath("/invoices")
  return { success: true, processed }
}

export async function sendInvoiceReminderAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")

  const { orgId, supabase } = await requireOrgContext()
  const invoice = await getInvoiceWithLines(invoiceId, orgId)

  if (!invoice) throw new Error("Invoice not found")
  if (invoice.status === "paid" || invoice.status === "void") {
    throw new Error("Cannot send reminder for paid or void invoices")
  }

  // Get recipient email from sent_to_emails or metadata
  const recipientEmail = invoice.sent_to_emails?.[0] ?? (invoice.metadata as any)?.customer_email
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

  return { success: true }
}

export async function getInvoiceComposerContextAction(projectId?: string | null) {
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
            return (status === "approved" || status === "pending") && !billedChangeOrderIds.has(co.id)
          }),
        )
        .catch(() => [])
    : []

  const { data: orgSettingsRow } = await supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle()
  const settings = (orgSettingsRow?.settings as Record<string, any> | null) ?? {}

  const { data: qboConnection } = await supabase
    .from("qbo_connections")
    .select("status, settings, last_error, refresh_failure_count")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  let qboConnected = Boolean(qboConnection)
  const qboDefaultIncomeAccountId =
    typeof (qboConnection?.settings as any)?.default_income_account_id === "string" ? (qboConnection?.settings as any).default_income_account_id : null

  let qboIncomeAccounts: Array<{ id: string; name: string; fullyQualifiedName?: string }> = []
  let qboAccountLoadWarning: string | null = null
  if (qboConnected) {
    try {
      const qboClient = await QBOClient.forOrg(orgId)
      if (!qboClient) {
        qboConnected = false
      } else {
        qboIncomeAccounts = await qboClient.listIncomeAccounts()
        if (qboIncomeAccounts.length === 0 && qboDefaultIncomeAccountId) {
          const fallbackAccount = await qboClient.getIncomeAccountById(qboDefaultIncomeAccountId).catch(() => null)
          if (fallbackAccount) {
            qboIncomeAccounts = [fallbackAccount]
          }
        }
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
export async function searchQboCustomersAction(term: string) {
  const { orgId } = await requireOrgContext()
  const qboClient = await QBOClient.forOrg(orgId).catch(() => null)
  if (!qboClient) return { connected: false, customers: [] as Awaited<ReturnType<QBOClient["searchCustomers"]>> }
  try {
    const customers = await qboClient.searchCustomers(term)
    return { connected: true, customers }
  } catch (error) {
    console.warn("QBO customer search failed", error)
    return { connected: true, customers: [] as Awaited<ReturnType<QBOClient["searchCustomers"]>> }
  }
}

/**
 * Create a customer directly in QuickBooks from the composer, so new customers are born in the source
 * of truth instead of an Arc-only base that drifts. Returns the new QBO customer to bill against.
 */
export async function createQboCustomerAction(input: { name: string; email?: string | null; address?: string | null }) {
  const { orgId } = await requireOrgContext()
  const name = input.name?.trim()
  if (!name) throw new Error("Customer name is required")
  const qboClient = await QBOClient.forOrg(orgId)
  if (!qboClient) throw new Error("QuickBooks is not connected")
  return qboClient.createCustomerOption({ name, email: input.email ?? null, address: input.address ?? null })
}

/**
 * Unbilled, billable costs for a cost-plus / T&M project — feeds the invoice composer's
 * "Add from → Unbilled costs" picker. Only status "open", billable, and not yet on an invoice.
 */
export async function listUnbilledCostsAction(projectId: string) {
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
        costCodeId: cost.cost_code_id,
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
    ensureInvoiceToken(invoice.id, orgId),
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

  if (invoice.qbo_id) {
    try {
      const qboClient = await QBOClient.forOrg(orgId)
      if (qboClient) {
        const attachment = await qboClient.uploadAttachmentForInvoice({
          invoiceId: invoice.qbo_id,
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
              qbo_pdf_attachment_id: attachment.id,
              qbo_pdf_attached_at: new Date().toISOString(),
              qbo_pdf_synced_file_id: fileRecord.id,
              qbo_pdf_synced_invoice_id: invoice.qbo_id,
            },
          })
          .eq("org_id", orgId)
          .eq("id", invoice.id)
      }
    } catch (error) {
      console.warn("Failed to attach invoice PDF to QuickBooks", error)
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
