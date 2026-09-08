"use server"

import { revalidatePath } from "next/cache"

import {
  createInvoice,
  deleteInvoice,
  ensureInvoiceToken,
  getInvoiceQueueCounts,
  getOrCreateInvoiceToken,
  getInvoiceWithLines,
  issueInvoice,
  scheduleInvoiceSend,
  cancelScheduledInvoiceSend,
  listInvoicePage,
  listInvoiceViews,
  listInvoices,
  moveInvoiceToProject,
  requestInvoiceApproval,
  decideInvoiceApproval,
  reviseInvoice,
  updateInvoice,
  voidInvoice,
  type ListInvoicesOptions,
} from "@/lib/services/invoices"
import { isIssuedInvoiceStatus } from "@/lib/financials/invoice-lifecycle"
import type { InvoiceDelivery } from "@/lib/types"
import { PROJECT_BILLING_SEGMENT } from "@/lib/financials/invoice-destinations"
import { listProjects } from "@/lib/services/projects"
import { listBillableContacts } from "@/lib/services/contacts"
import { listCostCodes } from "@/lib/services/cost-codes"
import { getNextInvoiceNumber } from "@/lib/services/invoice-numbers"
import { getOrgBilling } from "@/lib/services/orgs"
import { requestAccountingPush } from "@/lib/services/accounting-requests"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { receivablesWriter } from "@/lib/services/receivables-writer"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { invoiceInputSchema } from "@/lib/validation/invoices"
import { sendReminderEmail } from "@/lib/services/mailer"
import { listChangeOrders } from "@/lib/services/change-orders"
import { getProjectFinancialFeatureConfig, isCostDrivenBillingModel } from "@/lib/financials/billing-model"
import { listCostPlusTabData, getProjectCostContract, resolveMarkupPercent, calculateMarkupCents } from "@/lib/services/cost-plus"
import { renderInvoicePdf } from "@/lib/pdfs/invoice"
import { buildInvoicePdfData } from "@/lib/pdfs/invoice-data"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { createFileRecord } from "@/lib/services/files"
import { createInitialVersion } from "@/lib/services/file-versions"
import { attachFile, listAttachments } from "@/lib/services/file-links"
import { INVOICE_PDF_LINK_ROLE, isInvoiceAttachment } from "@/lib/invoices/attachment-roles"
import { accountingProviderLabel, DEFAULT_ACCOUNTING_PROVIDER_LABEL } from "@/components/accounting/provider-label"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { getProvider } from "@/lib/integrations/accounting/registry"
import { recordEvent } from "@/lib/services/events"
import { listEntityAuditTrail } from "@/lib/services/audit"
import { getInvoicePaymentActivity } from "@/lib/services/payments"
import {
  createReceivableAdjustment,
  listInvoiceReceivableAdjustments,
  voidReceivableAdjustment,
  type CreateReceivableAdjustmentInput,
} from "@/lib/services/receivable-adjustments"
import {
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
import { actionError, type ActionResult } from "@/lib/action-result"
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import { resolveLedgerAuthority } from "@/lib/services/books/authority"

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

export async function listInvoicesAction(projectId?: string, options?: Omit<ListInvoicesOptions, "projectId">) {
  return run(() => listInvoices({ ...options, projectId }))
}

/** One page of rows plus the true match count and every queue's count. */
export async function loadInvoiceQueueAction(projectId: string | undefined, options: Omit<ListInvoicesOptions, "projectId">) {
  return run(async () => {
    const [page, counts] = await Promise.all([
      listInvoicePage({ ...options, projectId }),
      getInvoiceQueueCounts({ projectId }),
    ])
    return { ...page, counts }
  })
}

/**
 * One band of the billing book: the active rows (drafts and open receivables)
 * or the history (paid and void), filtered and paged in the database.
 */
export async function loadBillingRowsAction(
  projectId: string | undefined,
  options: { queue: "active" | "history"; search?: string; offset?: number; limit?: number },
) {
  return run(() =>
    listInvoicePage({
      projectId,
      queue: options.queue,
      search: options.search,
      offset: options.offset,
      limit: options.limit ?? (options.queue === "active" ? 300 : 50),
      sort: "activity",
      sortDirection: "desc",
    }),
  )
}

export async function scheduleInvoiceSendAction(invoiceId: string, recipients: string[], sendAt: string) {
  return run(() => scheduleInvoiceSend({ invoiceId, recipients, sendAt }))
}

export async function cancelScheduledInvoiceSendAction(invoiceId: string) {
  return run(() => cancelScheduledInvoiceSend({ invoiceId }))
}

export async function issueInvoiceAction(invoiceId: string, recipients?: string[]) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const invoice = await issueInvoice({ invoiceId, recipients })
    revalidatePath("/invoices")
    if (invoice.project_id) revalidatePath(`/projects/${invoice.project_id}/${PROJECT_BILLING_SEGMENT}`)
    return invoice
  })
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

export async function requestInvoiceApprovalAction(invoiceId: string, note?: string) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const invoice = await requestInvoiceApproval({ invoiceId, note })
    revalidatePath("/invoices")
    return invoice
  })
}

export async function decideInvoiceApprovalAction(
  invoiceId: string,
  decision: "approved" | "rejected",
  note?: string,
) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const invoice = await decideInvoiceApproval({ invoiceId, decision, note })
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
      revalidatePath(`/projects/${invoice.project_id}/financials/billing`)
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
      revalidatePath(`/projects/${invoice.project_id}/financials/billing`)
    }
    return invoice
  })
}

export async function createReceivableAdjustmentAction(input: CreateReceivableAdjustmentInput) {
  return run(async () => {
    const adjustment = await createReceivableAdjustment(input)
    revalidatePath("/invoices")
    return adjustment
  })
}

export async function voidReceivableAdjustmentAction(adjustmentId: string) {
  return run(async () => {
    const adjustment = await voidReceivableAdjustment(adjustmentId)
    revalidatePath("/invoices")
    return adjustment
  })
}

export async function deleteInvoiceAction(invoiceId: string) {
  return run(async () => {
    if (!invoiceId) throw new Error("Invoice id is required")
    const result = await deleteInvoice({ invoiceId })
    revalidatePath("/invoices")
    if (result.projectId) {
      revalidatePath(`/projects/${result.projectId}/financials/billing`)
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
      revalidatePath(`/projects/${result.fromProjectId}/financials/billing`)
    }
    revalidatePath(`/projects/${result.toProjectId}/financials/billing`)
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

/**
 * Everything the invoice inspector shows, in as few round trips as the data
 * dependencies allow.
 *
 * Two things this deliberately does NOT do. It does not await eight independent
 * reads one after another — the only real dependency is that Books entries need
 * the adjustment ids, so that pair runs in sequence and the other six do not.
 * And it does not turn a failed read into an empty array: "this invoice has no
 * payments" and "we could not load its payments" are opposite facts about money,
 * and rendering them identically is how a person concludes an invoice was never
 * paid. Failures are named in `loadErrors` and the section says so.
 */
const DELIVERY_CHANNELS = ["email", "sms", "link", "download"] as const
const DELIVERY_STATUSES = ["queued", "sending", "sent", "delivered", "bounced", "failed"] as const

/** Narrow raw delivery rows onto the domain type the inspector renders. */
function mapDeliveryRows(rows: Array<Record<string, unknown>> | null): InvoiceDelivery[] {
  return (rows ?? []).map((row) => {
    const channel = String(row.channel ?? "email")
    const status = String(row.status ?? "queued")
    return {
      id: String(row.id),
      channel: (DELIVERY_CHANNELS as readonly string[]).includes(channel)
        ? (channel as InvoiceDelivery["channel"])
        : "email",
      recipient: (row.recipient as string | null) ?? null,
      status: (DELIVERY_STATUSES as readonly string[]).includes(status)
        ? (status as InvoiceDelivery["status"])
        : "queued",
      provider_message_id: (row.provider_message_id as string | null) ?? null,
      error_message: (row.error_message as string | null) ?? null,
      attempt_count: Number(row.attempt_count ?? 0),
      queued_at: String(row.queued_at ?? row.created_at ?? ""),
      sent_at: (row.sent_at as string | null) ?? null,
      delivered_at: (row.delivered_at as string | null) ?? null,
      opened_at: (row.opened_at as string | null) ?? null,
      clicked_at: (row.clicked_at as string | null) ?? null,
      failed_at: (row.failed_at as string | null) ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
      created_at: String(row.created_at ?? ""),
    }
  })
}

async function loadInvoiceDetail(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")

  // The org is known before the invoice is: every read below is scoped by it,
  // so none of them has to wait for the invoice row to come back first.
  const { orgId } = await requireOrgContext()
  const supabase = createServiceSupabaseClient()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"
  const loadErrors: string[] = []

  function note(label: string, error: unknown) {
    console.error(`Failed to load invoice ${label}`, error)
    loadErrors.push(label)
  }

  const [
    invoiceResult,
    viewsResult,
    syncResult,
    deliveriesResult,
    adjustmentsResult,
    paymentsResult,
    waiversResult,
    auditResult,
    attachmentsResult,
    invoiceEntriesResult,
  ] = await Promise.allSettled([
    getInvoiceWithLines(invoiceId, orgId),
    listInvoiceViews(invoiceId, orgId),
    supabase
      .from("accounting_sync_records")
      .select("id, status, last_synced_at, error_message, external_id")
      .eq("org_id", orgId)
      .eq("entity_type", "invoice")
      .eq("entity_id", invoiceId)
      .order("last_synced_at", { ascending: false })
      .throwOnError(),
    supabase
      .from("invoice_deliveries")
      .select("id, channel, recipient, status, provider_message_id, error_message, attempt_count, queued_at, sent_at, delivered_at, opened_at, clicked_at, failed_at, metadata, created_at")
      .eq("org_id", orgId)
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: false })
      .limit(50)
      .throwOnError(),
    listInvoiceReceivableAdjustments(invoiceId, orgId),
    getInvoicePaymentActivity(invoiceId, orgId),
    listInvoiceLienWaivers(invoiceId, orgId),
    listEntityAuditTrail({
      entityType: "invoice",
      entityId: invoiceId,
      permission: "invoice.read",
      orgId,
    }),
    listAttachments("invoice", invoiceId, orgId),
    supabase
      .from("journal_entries")
      .select("id, entry_date, status, posting_key, posted_at, reversal_of_entry_id, created_at")
      .eq("org_id", orgId)
      .eq("source_type", "invoice")
      .eq("source_id", invoiceId)
      .order("created_at", { ascending: false })
      .limit(10)
      .throwOnError(),
  ])

  if (invoiceResult.status === "rejected") throw invoiceResult.reason
  const invoice = invoiceResult.value
  if (!invoice) throw new Error("Invoice not found")

  if (viewsResult.status === "rejected") note("client views", viewsResult.reason)
  if (syncResult.status === "rejected") note("accounting sync history", syncResult.reason)
  if (deliveriesResult.status === "rejected") note("delivery history", deliveriesResult.reason)
  if (adjustmentsResult.status === "rejected") note("credits and write-offs", adjustmentsResult.reason)
  if (paymentsResult.status === "rejected") note("payments", paymentsResult.reason)
  if (waiversResult.status === "rejected") note("lien waivers", waiversResult.reason)
  if (auditResult.status === "rejected") note("change history", auditResult.reason)
  if (attachmentsResult.status === "rejected") note("attachments", attachmentsResult.reason)
  if (invoiceEntriesResult.status === "rejected") note("Books impact", invoiceEntriesResult.reason)

  const adjustments = adjustmentsResult.status === "fulfilled" ? adjustmentsResult.value : []
  const paymentActivity =
    paymentsResult.status === "fulfilled" ? paymentsResult.value : { payments: [], reversals: [] }

  // Viewing detail must never mutate lifecycle — only guarantee a token exists
  // for invoices that were already shared. It needs the invoice row, so it is
  // the one read that waits; it is also the one that is usually a no-op.
  const needsToken = Boolean(invoice.client_visible || invoice.sent_at || isIssuedInvoiceStatus(invoice.status))
  const [tokenResult, adjustmentEntriesResult] = await Promise.allSettled([
    needsToken ? getOrCreateInvoiceToken(invoiceId, orgId) : Promise.resolve(invoice.token ?? null),
    // A credit memo posts its own entry, so its ids have to exist first. Most
    // invoices have none, so this second phase is usually skipped entirely.
    adjustments.length > 0
      ? supabase
          .from("journal_entries")
          .select("id, entry_date, status, posting_key, posted_at, reversal_of_entry_id, created_at")
          .eq("org_id", orgId)
          .eq("source_type", "receivable_adjustment")
          .in("source_id", adjustments.map((adjustment) => adjustment.id))
          .order("created_at", { ascending: false })
          .limit(10)
          .throwOnError()
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ])
  if (tokenResult.status === "rejected") note("share link", tokenResult.reason)
  if (adjustmentEntriesResult.status === "rejected") note("Books impact", adjustmentEntriesResult.reason)

  const token = tokenResult.status === "fulfilled" ? tokenResult.value : invoice.token ?? null
  const entryRows = [
    ...(invoiceEntriesResult.status === "fulfilled" ? invoiceEntriesResult.value.data ?? [] : []),
    ...(adjustmentEntriesResult.status === "fulfilled" ? adjustmentEntriesResult.value.data ?? [] : []),
  ] as Array<Record<string, unknown>>
  const booksEntries = entryRows
    .map((row) => ({
      id: String(row.id),
      entry_date: String(row.entry_date ?? ""),
      status: String(row.status ?? ""),
      posting_key: String(row.posting_key ?? ""),
      posted_at: (row.posted_at as string | null) ?? null,
      reversal_of_entry_id: (row.reversal_of_entry_id as string | null) ?? null,
      created_at: String(row.created_at ?? ""),
    }))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, 10)
    .map(({ created_at: _createdAt, ...entry }) => entry)

  return {
    invoice: { ...invoice, token },
    link: token ? `${appUrl}/i/${token}` : undefined,
    views: viewsResult.status === "fulfilled" ? viewsResult.value : [],
    deliveries: deliveriesResult.status === "fulfilled" ? mapDeliveryRows(deliveriesResult.value.data) : [],
    booksEntries,
    syncHistory:
      syncResult.status === "fulfilled"
        ? (syncResult.value.data ?? []).map((record) => ({ ...record, qbo_id: record.external_id }))
        : [],
    payments: paymentActivity.payments,
    reversals: paymentActivity.reversals,
    adjustments,
    lienWaivers: waiversResult.status === "fulfilled" ? waiversResult.value : [],
    auditTrail: auditResult.status === "fulfilled" ? auditResult.value : [],
    attachments: attachmentsResult.status === "fulfilled" ? attachmentsResult.value.filter(isInvoiceAttachment) : [],
    loadErrors,
  }
}

export async function createInvoiceLienWaiverAction(input: {
  invoiceId: string
  waiverType: InvoiceLienWaiverType
  throughDate?: string
}) {
  return run(async () => {
    // Stale clients must not issue a waiver without the new review/signing step.
    void input
    throw new Error("Open Prepare waiver to review and sign this document.")
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
    const { error } = await receivablesWriter()
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
    await requestAccountingPush({ entityType: "invoice", entityId: invoiceId })
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

  const { orgId, supabase, userId } = await requireOrgContext()
  const invoice = await getInvoiceWithLines(invoiceId, orgId)

  if (!invoice) throw new Error("Invoice not found")
  await requireAuthorization({
    permission: "invoice.send",
    userId,
    orgId,
    projectId: invoice.project_id ?? undefined,
    supabase,
    logDecision: true,
    resourceType: "invoice",
    resourceId: invoiceId,
  })
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

  const service = createServiceSupabaseClient()
  const { data: delivery, error: deliveryError } = await service
    .from("invoice_deliveries")
    .insert({
      org_id: orgId,
      invoice_id: invoiceId,
      channel: "email",
      recipient: recipientEmail,
      status: "sending",
      attempt_count: 1,
      metadata: { kind: "payment_reminder", days_overdue: daysOverdue ?? 0 },
    })
    .select("id")
    .single()
  if (deliveryError) throw new Error(`Failed to track invoice reminder: ${deliveryError.message}`)

  try {
    const providerMessageId = await sendReminderEmail({
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
    const sentAt = new Date().toISOString()
    await service
      .from("invoice_deliveries")
      .update({ status: "sent", sent_at: sentAt, provider_message_id: providerMessageId ?? null })
      .eq("org_id", orgId)
      .eq("id", delivery.id)
    await recordEvent({
      orgId,
      eventType: "invoice_reminder_sent",
      entityType: "invoice",
      entityId: invoiceId,
      payload: { recipient: recipientEmail, days_overdue: daysOverdue ?? 0 },
    })
  } catch (error) {
    await service
      .from("invoice_deliveries")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : String(error),
      })
      .eq("org_id", orgId)
      .eq("id", delivery.id)
    throw error
  }
}

/**
 * Everything the composer needs that is not the invoice itself, in one round
 * trip. The billing page warms this on hover of "New invoice", so the takeover
 * opens with the customer list and the accounting context already in hand.
 * Number reservation is deliberately separate: warming must never consume a
 * number the person may not use.
 */
export async function loadInvoiceComposerBootstrapAction(input: {
  projectId: string
  draftId?: string | null
  duplicateId?: string | null
}) {
  return run(async () => {
    const context = await requireOrgContext()
    const [contacts, costCodes, composerContext, draft, duplicate, orgBilling] = await Promise.all([
      listBillableContacts(context.orgId).catch(() => []),
      listCostCodes(context.orgId).catch(() => []),
      loadInvoiceComposerContext(input.projectId),
      input.draftId ? getInvoiceWithLines(input.draftId, context.orgId) : Promise.resolve(null),
      input.duplicateId ? getInvoiceWithLines(input.duplicateId, context.orgId) : Promise.resolve(null),
      getOrgBilling().catch(() => null),
    ])
    if (input.draftId && !draft) throw new Error("That draft no longer exists")
    return {
      recoveryScope: `${context.orgId}:${context.userId}`,
      contacts,
      costCodes,
      context: composerContext,
      draft,
      duplicate,
      branding: {
        name: orgBilling?.org?.name ?? null,
        email: orgBilling?.org?.billing_email ?? null,
        address: formatOrgAddressLines(orgBilling?.org?.address),
        logoUrl: orgBilling?.org?.logo_url ?? null,
      },
    }
  })
}

/** A brand-new invoice reserves its number so two people composing at once never collide. */
export async function reserveInvoiceNumberAction(projectId?: string) {
  return run(async () => {
    const reservation = await getNextInvoiceNumber(undefined, projectId)
    return { number: String(reservation.number ?? ""), reservationId: reservation.reservation_id ?? null, warning: reservation.warning }
  })
}

/** The org's address is stored as a JSON block; the document wants lines of text. */
function formatOrgAddressLines(address: unknown): string | null {
  if (typeof address === "string") return address.trim() || null
  if (!address || typeof address !== "object") return null
  const record = address as Record<string, unknown>
  const parts = ["street1", "line1", "street2", "line2", "city", "state", "postal_code"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  return parts.length > 0 ? parts.join(", ") : null
}

export type InvoiceComposerContext = Awaited<ReturnType<typeof loadInvoiceComposerContext>>

export async function getInvoiceComposerContextAction(projectId?: string | null) {
  return run(() => loadInvoiceComposerContext(projectId))
}

async function loadInvoiceComposerContext(projectId?: string | null) {
  const { supabase, orgId } = await requireOrgContext()

  // Only offer billing sources the server will actually accept for this project:
  // draws when the billing model shows a draw schedule, and direct change-order
  // invoicing only on non-cost-driven models (cost-driven projects bill COs
  // through the cost ledger and createInvoice rejects them).
  let showDrawSources = Boolean(projectId)
  let showChangeOrderSources = Boolean(projectId)
  if (projectId) {
    const [{ data: projectRow }, { data: financialSettings }, { data: activeContract }] = await Promise.all([
      supabase.from("projects").select("id, status, property_type").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
      supabase
        .from("project_financial_settings")
        .select("billing_model, fixed_price_billing_basis")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .maybeSingle(),
      supabase
        .from("contracts")
        .select("contract_type, fixed_fee_cents, gmp_cents, snapshot, open_book, requires_client_cost_approval")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    if (projectRow) {
      const featureConfig = getProjectFinancialFeatureConfig({
        status: projectRow.status ?? undefined,
        property_type: projectRow.property_type ?? undefined,
        billing_contract: activeContract ?? null,
        financial_settings: financialSettings
          ? {
              billing_model: financialSettings.billing_model ?? undefined,
              fixed_price_billing_basis: financialSettings.fixed_price_billing_basis ?? null,
            }
          : null,
      })
      showDrawSources = featureConfig.showDraws
      showChangeOrderSources = !isCostDrivenBillingModel(featureConfig.billingModel)
    }
  }

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

  if (projectId && showDrawSources) {
    const { data, error: drawError } = await supabase
      .from("draw_schedules")
      .select("id, project_id, draw_number, title, description, amount_cents, due_date, status")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["pending", "partial"])
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("draw_number", { ascending: true })
      .limit(100)

    if (drawError) {
      console.warn("Failed to load draw schedule context", drawError)
    } else {
      drawRows = (data ?? []) as typeof drawRows
    }
  }

  let billedChangeOrderIds = new Set<string>()
  if (projectId && showChangeOrderSources) {
    // The source column is canonical since the invoicing overhaul; the server's
    // assertSourceNotAlreadyBilled still backstops any legacy metadata-only rows.
    const { data: invoiceRows } = await supabase
      .from("invoices")
      .select("source_change_order_id")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .neq("status", "void")
      .not("source_change_order_id", "is", null)

    billedChangeOrderIds = new Set(
      (invoiceRows ?? [])
        .map((row: any) => row.source_change_order_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    )
  }

  const changeOrders =
    projectId && showChangeOrderSources
      ? await listChangeOrders({ orgId, projectId })
          .then((rows) =>
            rows
              .filter((co) => {
                const status = String(co.status ?? "").toLowerCase()
                return status === "approved" && !billedChangeOrderIds.has(co.id)
              })
              .slice(0, 100),
          )
          .catch(() => [])
      : []

  // The project's default QBO customer (set in project settings) — used to pre-select the composer's
  // "bill to" picker so invoices and payables attribute to the same customer by default.
  const nativeBooks = (await resolveLedgerAuthority(orgId)) === "arc"
  const accountingTarget = nativeBooks ? null : await resolveAccountingTarget({ orgId, projectId })
  const accountingProviderName = nativeBooks
    ? "Arc Books"
    : accountingTarget
    ? accountingProviderLabel(accountingTarget.connection.provider, accountingTarget.connection.label)
    : DEFAULT_ACCOUNTING_PROVIDER_LABEL
  const defaultQboCustomer = accountingTarget?.dimensions.customer?.id
    ? { id: accountingTarget.dimensions.customer.id, name: accountingTarget.dimensions.customer.name ?? "" }
    : null

  const { data: orgSettingsRow } = await supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle()
  const settings = (orgSettingsRow?.settings as Record<string, any> | null) ?? {}
  const { data: taxJurisdictions } = await createServiceSupabaseClient()
    .from("books_tax_jurisdictions")
    .select("id,name,sales_tax_rate_micros,effective_from,effective_through")
    .eq("org_id", orgId)
    .eq("active", true)
    .order("name")

  const { data: qboConnection } = accountingTarget ? await supabase
    .from("accounting_connections")
    .select("status, settings, last_error, refresh_failure_count")
    .eq("org_id", orgId)
    .eq("id", accountingTarget.connection.id)
    .maybeSingle()
    : { data: null }

  let qboConnected = Boolean(qboConnection)
  let qboDefaultIncomeAccountId =
    typeof (qboConnection?.settings as any)?.default_income_account_id === "string" ? (qboConnection?.settings as any).default_income_account_id : null

  let qboIncomeAccounts: Array<{ id: string; name: string; fullyQualifiedName?: string }> = []
  let qboAccountLoadWarning: string | null = null
  if (nativeBooks) {
    const { data: accounts, error: accountsError } = await supabase
      .from("gl_accounts")
      .select("id,code,name")
      .eq("org_id", orgId)
      .eq("active", true)
      .eq("account_type", "income")
      .order("code")
      .limit(500)
    if (accountsError) {
      qboAccountLoadWarning = `Unable to load Arc Books income accounts: ${accountsError.message}`
    } else {
      qboDefaultIncomeAccountId = (accounts ?? []).find((account) => account.code === SYSTEM_ACCOUNT_CODES.constructionRevenue)?.id ?? null
      qboIncomeAccounts = (accounts ?? []).map((account) => ({
        id: account.id,
        name: `${account.code} · ${account.name}`,
      }))
      if (qboIncomeAccounts.length === 0) qboAccountLoadWarning = "Arc Books has no active income accounts."
    }
  } else if (qboConnected) {
    try {
      const provider = accountingTarget ? getProvider(accountingTarget.connection.provider) : null
      if (!provider || !accountingTarget) qboConnected = false
      else {
        qboIncomeAccounts = (await provider.listAccounts({ connectionId: accountingTarget.connection.id, kind: "income" }))
          .map((account) => ({ ...account, name: account.name ?? account.id, fullyQualifiedName: account.fullyQualifiedName ?? undefined }))
        if (qboIncomeAccounts.length === 0) {
          qboAccountLoadWarning = `${accountingProviderName} returned no income accounts. Check your chart of accounts and default income account.`
        }
      }
    } catch (error) {
      console.warn("Unable to load QBO income accounts for invoice composer", error)
      qboAccountLoadWarning = error instanceof Error ? error.message : `Unable to load ${accountingProviderName} income accounts.`
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
    canCreateIncomeAccount: Boolean(accountingTarget && getProvider(accountingTarget.connection.provider).createAccount),
    accountingProvider: nativeBooks ? "arc_books" : accountingTarget?.connection.provider ?? null,
    accountingProviderName,
    qboDiagnostics: {
      connectionLastError: (qboConnection as any)?.last_error ?? null,
      refreshFailureCount: Number((qboConnection as any)?.refresh_failure_count ?? 0),
      accountLoadWarning: qboAccountLoadWarning,
    },
    settings: {
      defaultPaymentTermsDays: Number(settings.invoice_default_payment_terms_days ?? 15),
      defaultInvoiceNote: String(settings.invoice_default_payment_details ?? ""),
    },
    taxJurisdictions: taxJurisdictions ?? [],
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
    link_role: INVOICE_PDF_LINK_ROLE,
  })

  await receivablesWriter()
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

        await receivablesWriter()
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
    revalidatePath(`/projects/${invoice.project_id}/financials/billing`)
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
