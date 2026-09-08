"use server"

import { requireAuthorization, getDivisionScopedProjectIds } from "@/lib/services/authorization"
import { z } from "zod"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { ACCOUNTING_JOB_TYPES, enqueueAccountingPush, type AccountingPushEntityType } from "@/lib/services/accounting-sync"
import { ACCOUNTING_PROVIDERS } from "@/lib/integrations/accounting/catalog"
import { getProvider, isAccountingProviderKey, listProviders } from "@/lib/integrations/accounting/registry"

async function requireAccountingEntityScope(context: Awaited<ReturnType<typeof requireOrgContext>>, entityType: string, entityId: string) {
  const table = entityType === "invoice" ? "invoices" : entityType === "expense" ? "project_expenses" : entityType === "bill" ? "vendor_bills" : "payments"
  const { data, error } = await context.supabase.from(table).select("project_id").eq("org_id", context.orgId).eq("id", entityId).maybeSingle()
  if (error || !data) throw new Error("Accounting transaction not found within your authorized scope")
  if (data.project_id) await requireAuthorization({ permission: "accounting.entity_map.manage", orgId: context.orgId, userId: context.userId, projectId: data.project_id, supabase: context.supabase, logDecision: true })
  else if (await getDivisionScopedProjectIds(context) !== null) throw new Error("Organization-wide accounting transaction requires access to all divisions")
}

/**
 * Row cap across the ledger queue. A 200-active-project org's backlog must not load
 * the entire invoices table into one server action — the caller is told when
 * the cap truncated (`truncated` on the queue payload).
 */
const QUEUE_ROW_CAP = 500

export type AccountingSyncEntityType = "invoice" | "expense" | "bill" | "payment" | "bill_payment" | "webhook_event"

export type AccountingSyncQueueItem = {
  id: string
  connectionId: string | null
  provider: string | null
  entityType: AccountingSyncEntityType
  projectId: string | null
  label: string
  sublabel: string | null
  amountCents: number
  status: "pending" | "error" | "needs_review" | "conflict"
  error: string | null
  externalId: string | null
  lastAttemptAt: string | null
  date: string | null
}

export type AccountingSyncQueue = {
  connected: boolean
  /**
   * Which accounting system this org actually posts to. The queue names it
   * rather than assuming QuickBooks — the push layer has been provider-neutral
   * since the accounting abstraction landed, and only the labels were pinned.
   * Null when the org has no connection at all.
   */
  provider: { key: string; name: string; supportsImport: boolean } | null
  items: AccountingSyncQueueItem[]
  /** True when the ledger row cap trimmed the queue — the counts understate. */
  truncated: boolean
  /**
   * Inbound changes that were dropped on the floor with a terminal reason
   * ("no local mapping", "entity not handled", …). These were previously
   * invisible anywhere — which made "why didn't this sync?" unanswerable
   * without database access.
   */
  ignoredEvents: { count: number; reasons: Array<{ reason: string; count: number }> }
}

export type AccountingSyncHistoryItem = {
  id: string
  entityType: string
  entityId: string
  projectId: string | null
  label: string
  status: string
  direction: string
  externalId: string | null
  error: string | null
  syncedAt: string | null
}

function mapStatus(value?: string | null): "pending" | "error" | "needs_review" | "conflict" {
  if (value === "error") return "error"
  if (value === "needs_review") return "needs_review"
  if (value === "conflict") return "conflict"
  return "pending"
}

/**
 * Everything waiting to reach the org's accounting system (pending) or that
 * failed (error), across every entity type. The shared
 * `accounting_sync_records` ledger is the only queue truth. Every query remains
 * org-scoped because the service client bypasses RLS.
 */
export async function listAccountingSyncQueueAction(params?: { projectId?: string | null }): Promise<AccountingSyncQueue> {
  const context = await requireOrgContext()
  await requirePermission("invoice.read", context)
  await requirePermission("bill.read", context)
  const { orgId } = context
  const supabase = createServiceSupabaseClient()
  const projectId = params?.projectId ?? null

  const [{ data: connections }, { data: anyConnections }, { data: projectRows }] = await Promise.all([
    supabase.from("accounting_connections").select("id, provider, external_account_id").eq("org_id", orgId).eq("status", "active").order("connected_at", { ascending: true }),
    // Any connection, healthy or not: an expired one still tells us which
    // system this org's backlog is waiting on, and that is exactly the state
    // where naming it matters most.
    supabase.from("accounting_connections").select("provider").eq("org_id", orgId).order("connected_at", { ascending: false }).limit(1),
    context.supabase.from("projects").select("id, name").eq("org_id", orgId),
  ])
  const realmIds = (connections ?? [])
    .map((row) => row.external_account_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  const connected = (connections ?? []).length > 0
  // With multiple active connections (e.g. a batch file export plus a live
  // two-way one), the header names one of them. Prefer whichever can also
  // import, so the Import tab is not hidden by an incidental ordering on
  // connected_at. Asked as a capability, not as a provider name: the next
  // adapter with a read API has to win this the moment it is registered, and a
  // hardcoded `provider === "qbo"` would keep pinning the header to QuickBooks.
  const primaryConnection =
    (connections ?? []).find(
      (row) => isAccountingProviderKey(row.provider) && getProvider(row.provider).capabilities.supportsImport,
    ) ?? connections?.[0] ?? null
  const providerKey = primaryConnection?.provider ?? anyConnections?.[0]?.provider ?? null
  const provider = providerKey && isAccountingProviderKey(providerKey)
    ? {
        key: providerKey,
        name: ACCOUNTING_PROVIDERS[providerKey].name,
        supportsImport: getProvider(providerKey).capabilities.supportsImport,
      }
    : null
  const projectName = new Map<string, string>(
    ((projectRows ?? []) as any[]).map((row) => [row.id as string, row.name as string]),
  )

  // The neutral sync ledger is the queue. Reading a legacy entity column here
  // could report a bill as synced even when no enqueue row or job ever existed.
  const [recordsRes, webhookEventsRes, ignoredEventsRes] = await Promise.all([
    supabase
      .from("accounting_sync_records")
      .select("connection_id, provider, entity_id, entity_type, status, error_message, external_id, last_synced_at, created_at, updated_at")
      .eq("org_id", orgId)
      .in("entity_type", ["invoice", "project_expense", "bill", "vendor_credit", "payment", "bill_payment"])
      .in("status", ["pending", "error", "needs_review", "conflict"])
      .order("updated_at", { ascending: false })
      .limit(QUEUE_ROW_CAP + 1),
    Promise.all(listProviders().filter(provider => provider.listInboundEvents).map(provider => provider.listInboundEvents!({ orgId, limit: 25 }))).then(pages => ({ data: pages.flat().map(event => ({ ...event, entity_name: event.entityName, entity_qbo_id: event.externalId, process_error: event.error, received_at: event.receivedAt, processed_at: event.processedAt })) })),
    Promise.resolve({ data: [] }),
  ])

  if (recordsRes.error) throw new Error(`Unable to load accounting queue: ${recordsRes.error.message}`)
  const loadedRecords = (recordsRes.data ?? []) as any[]
  const truncated = loadedRecords.length > QUEUE_ROW_CAP
  const latestRecordsByEntity = new Map<string, any>()
  for (const record of loadedRecords.slice(0, QUEUE_ROW_CAP)) {
    const key = `${record.connection_id}:${record.entity_type}:${record.entity_id}`
    if (!latestRecordsByEntity.has(key)) latestRecordsByEntity.set(key, record)
  }
  const syncRecords = [...latestRecordsByEntity.values()]
  const recordsByType = new Map<string, any[]>()
  for (const record of syncRecords) {
    recordsByType.set(record.entity_type, [...(recordsByType.get(record.entity_type) ?? []), record])
  }
  const invoiceRecords = recordsByType.get("invoice") ?? []
  const expenseRecords = recordsByType.get("project_expense") ?? []
  const billRecords = [...(recordsByType.get("bill") ?? []), ...(recordsByType.get("vendor_credit") ?? [])]
  const paymentRecords = [...(recordsByType.get("payment") ?? []), ...(recordsByType.get("bill_payment") ?? [])]
  const [invoicesRes, expensesRes, billsRes, paymentsRes] = await Promise.all([
    invoiceRecords.length > 0
      ? supabase.from("invoices").select("id, project_id, invoice_number, title, issue_date, total_cents").eq("org_id", orgId).in("id", invoiceRecords.map((record) => record.entity_id))
      : Promise.resolve({ data: [] }),
    expenseRecords.length > 0
      ? supabase.from("project_expenses").select("id, project_id, description, vendor_name_text, expense_date, amount_cents, tax_cents, vendor_company:companies(name)").eq("org_id", orgId).in("id", expenseRecords.map((record) => record.entity_id))
      : Promise.resolve({ data: [] }),
    billRecords.length > 0
      ? supabase.from("vendor_bills").select("id, project_id, bill_number, bill_date, total_cents, commitment:commitments(title, company:companies(name))").eq("org_id", orgId).in("id", billRecords.map((record) => record.entity_id))
      : Promise.resolve({ data: [] }),
    paymentRecords.length > 0
      ? supabase.from("payments").select("id, amount_cents, received_at, created_at, invoice:invoices(invoice_number, title, project_id), bill:vendor_bills(bill_number, project_id)").eq("org_id", orgId).in("id", paymentRecords.map((record) => record.entity_id))
      : Promise.resolve({ data: [] }),
  ])
  const invoices = (invoicesRes.data ?? []) as any[]
  const expenses = (expensesRes.data ?? []) as any[]
  const bills = (billsRes.data ?? []) as any[]
  const deadLetterEvents = projectId ? [] : ((webhookEventsRes.data ?? []) as any[])

  const ignoredReasonCounts = new Map<string, number>()
  for (const row of (ignoredEventsRes.data ?? []) as Array<{ process_error: string | null }>) {
    const reason = (row.process_error ?? "").trim()
    if (!reason) continue
    ignoredReasonCounts.set(reason, (ignoredReasonCounts.get(reason) ?? 0) + 1)
  }
  const ignoredEvents = {
    count: [...ignoredReasonCounts.values()].reduce((sum, value) => sum + value, 0),
    reasons: [...ignoredReasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  }

  const items: AccountingSyncQueueItem[] = []

  for (const record of invoiceRecords) {
    const invoice = invoices.find(row => row.id === record.entity_id)
    if (!invoice) continue
    if (projectId && invoice.project_id !== projectId) continue
    items.push({
      connectionId: record.connection_id,
      provider: record.provider,
      id: invoice.id,
      entityType: "invoice",
      projectId: invoice.project_id ?? null,
      label: invoice.invoice_number || invoice.title || "Invoice",
      sublabel: invoice.project_id ? projectName.get(invoice.project_id) ?? null : null,
      amountCents: Number(invoice.total_cents ?? 0),
      status: mapStatus(record?.status),
      error: record?.error_message ?? null,
      externalId: record?.external_id ?? null,
      lastAttemptAt: record?.updated_at ?? record?.created_at ?? null,
      date: invoice.issue_date ?? null,
    })
  }

  for (const record of expenseRecords) {
    const expense = expenses.find(row => row.id === record.entity_id)
    if (!expense) continue
    if (projectId && expense.project_id !== projectId) continue
    const vendor = (expense.vendor_company as { name?: string } | null)?.name ?? expense.vendor_name_text ?? null
    items.push({
      connectionId: record.connection_id,
      provider: record.provider,
      id: expense.id as string,
      entityType: "expense",
      projectId: (expense.project_id as string | null) ?? null,
      label: (expense.description as string)?.trim() || vendor || "Expense",
      sublabel: vendor ?? (expense.project_id ? projectName.get(expense.project_id as string) ?? null : null),
      amountCents: Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0),
      status: mapStatus(record?.status),
      error: record?.error_message ?? null,
      externalId: record?.external_id ?? null,
      lastAttemptAt: record?.updated_at ?? record?.created_at ?? null,
      date: (expense.expense_date as string) ?? null,
    })
  }

  for (const record of billRecords) {
    const bill = bills.find(row => row.id === record.entity_id)
    if (!bill) continue
    if (projectId && bill.project_id !== projectId) continue
    const commitment = bill.commitment as { title?: string; company?: { name?: string } } | null
    items.push({
      connectionId: record.connection_id,
      provider: record.provider,
      id: bill.id as string,
      entityType: "bill",
      projectId: (bill.project_id as string | null) ?? null,
      label: bill.bill_number ? `Bill ${bill.bill_number}` : commitment?.title || "Vendor bill",
      sublabel: commitment?.company?.name ?? (bill.project_id ? projectName.get(bill.project_id as string) ?? null : null),
      amountCents: Number(bill.total_cents ?? 0),
      status: mapStatus(record?.status),
      error: record?.error_message ?? null,
      externalId: record?.external_id ?? null,
      lastAttemptAt: record?.updated_at ?? record?.created_at ?? null,
      date: (bill.bill_date as string) ?? null,
    })
  }

  // Payments and bill payments — sourced from the sync ledger, enriched from the payments table.
  if (paymentRecords.length > 0) {
    const paymentById = new Map<string, any>(((paymentsRes.data ?? []) as any[]).map((row) => [row.id as string, row]))

    for (const record of paymentRecords) {
      const payment = paymentById.get(record.entity_id as string)
      const isBillPayment = record.entity_type === "bill_payment"
      const paymentProjectId = (isBillPayment ? payment?.bill?.project_id : payment?.invoice?.project_id) ?? null
      if (projectId && paymentProjectId !== projectId) continue
      const reference = isBillPayment
        ? payment?.bill?.bill_number
          ? `Bill ${payment.bill.bill_number}`
          : "vendor bill"
        : payment?.invoice?.invoice_number || payment?.invoice?.title || "invoice"
      items.push({
        connectionId: record.connection_id,
      provider: record.provider,
      id: record.entity_id as string,
        entityType: isBillPayment ? "bill_payment" : "payment",
        projectId: paymentProjectId,
        label: `Payment · ${reference}`,
        sublabel: null,
        amountCents: Number(payment?.amount_cents ?? 0),
        status: mapStatus(record.status as string),
        error: record.error_message ?? null,
        externalId: record.external_id ?? null,
        lastAttemptAt: (record.updated_at ?? record.created_at) as string | null,
        date: (payment?.received_at ?? payment?.created_at) as string | null,
      })
    }
  }

  for (const event of deadLetterEvents) {
    items.push({
      connectionId: event.connectionId ?? null,
      provider: event.provider ?? null,
      id: event.id as string,
      entityType: "webhook_event",
      projectId: null,
      label: `${String(event.entity_name ?? "Webhook")} ${String(event.entity_qbo_id ?? "")}`.trim(),
      sublabel: String(event.operation ?? "inbound"),
      amountCents: 0,
      status: "error",
      error: (event.process_error as string | null) ?? "Webhook processing failed",
      externalId: (event.entity_qbo_id as string | null) ?? null,
      lastAttemptAt: ((event.processed_at ?? event.received_at) as string | null) ?? null,
      date: (event.received_at as string | null) ?? null,
    })
  }

  const divisionScope = await getDivisionScopedProjectIds(context)
  const visibleItems = items.filter(item => item.projectId ? projectName.has(item.projectId) : divisionScope === null)
  return { connected, provider, items: visibleItems, truncated, ignoredEvents }
}

/**
 * Push a single item to the accounting system now. Throws on failure so the UI
 * can surface it; returns whether anything was actually pushed, because "Arc is
 * the ledger of record" skips are a success that must not read as "Synced".
 */
export async function syncAccountingItemAction(
  entityType: AccountingSyncEntityType,
  id: string,
): Promise<{ skipped: boolean; reason: "books_authoritative" | null }> {
  const context = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", context)
  const { orgId } = context
  if (entityType === "webhook_event") {
    const result = await retryQboWebhookEventAction(id)
    if (!result.success) throw new Error(result.error ?? "Unable to retry webhook event")
    return { skipped: false, reason: null }
  }
  const mapped: AccountingPushEntityType = entityType === "expense" ? "project_expense" : entityType === "bill" ? "vendor_bill" : entityType
  z.object({ id: z.string().uuid(), entityType: z.enum(["invoice", "expense", "bill", "payment", "bill_payment"]) }).parse({ id, entityType })
  await requireAccountingEntityScope(context, entityType, id)
  const result = await enqueueAccountingPush({ orgId, entityType: mapped, entityId: id })
  if (!result.queued && result.reason === "books_authoritative") return { skipped: true, reason: "books_authoritative" }
  if (!result.queued) throw new Error(describeEnqueueBlock(result.reason))
  await recordAudit({ orgId, actorId: context.userId, action: "update", entityType: mapped, entityId: id, source: "accounting_manual_sync", after: { queued: true } })
  return { skipped: false, reason: null }
}

/**
 * Requeue every pending/failed item.
 *
 * These go back through the outbox rather than being pushed inline. Pushing a
 * backlog serially inside one server action meant a large queue ran past the
 * request budget and died partway, with no record of where it stopped and no
 * retry for the half that never ran. The outbox already has the retry, the
 * backoff and the deduplication.
 *
 * Webhook replays stay inline: they only reset a row so the inbound drain picks
 * them up, and there is nothing to enqueue.
 */
export async function syncAllAccountingPendingAction(params?: { projectId?: string | null }): Promise<{ queued: number; failed: number; errors: string[] }> {
  const context = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", context)
  const { orgId } = context
  const { items } = await listAccountingSyncQueueAction({ projectId: params?.projectId })

  // Org-wide "sync everything" also revives dead-lettered outbox jobs — the
  // one state this surface previously had no exit from.
  if (!params?.projectId) {
    await retryFailedAccountingOutboxAction().catch(() => {})
  }

  let queued = 0
  let failed = 0
  const errors: string[] = []
  for (const item of items) {
    try {
      if (item.entityType === "webhook_event") {
        const result = await retryQboWebhookEventAction(item.id)
        if (!result.success) throw new Error(result.error ?? "Unable to retry webhook event")
        queued += 1
        continue
      }
      const mapped: AccountingPushEntityType = item.entityType === "expense" ? "project_expense" : item.entityType === "bill" ? "vendor_bill" : item.entityType
      await requireAccountingEntityScope(context, item.entityType, item.id)
      const result = await enqueueAccountingPush({ orgId, entityType: mapped, entityId: item.id })
      if (result.queued) {
        queued += 1
      } else {
        failed += 1
        errors.push(`${item.label}: ${describeEnqueueBlock(result.reason)}`)
      }
    } catch (error) {
      failed += 1
      errors.push(`${item.label}: ${error instanceof Error ? error.message : "Sync failed"}`)
    }
  }
  return { queued, failed, errors }
}

/** Why a transaction could not even be queued, in words a bookkeeper can act on. */
function describeEnqueueBlock(reason: string): string {
  switch (reason) {
    case "no_target":
      return "No accounting connection is mapped to this transaction."
    case "cutover_freeze":
      return "Held by an accounting cutover freeze."
    case "books_authoritative":
      return "Arc Books owns this ledger, so nothing is pushed out."
    case "inbound_only":
      return "This record came from the accounting system and is not pushed back."
    case "connection_mismatch":
      return "It belongs to a different accounting connection than the one now mapped."
    case "disabled":
      return "Automatic sync is turned off for this connection."
    case "connection_unhealthy":
      return "The accounting connection needs to be reconnected."
    default:
      return "Could not be queued."
  }
}

/**
 * Replay a dead-lettered inbound webhook. Deliberately still QBO-named: it resets a
 * row in `qbo_webhook_events`, which is a QuickBooks-only table. No other adapter
 * has an inbound webhook stream to replay.
 */
export async function retryQboWebhookEventAction(id: string): Promise<{ success: boolean; error: string | null }> {
  const context = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", context)
  const { orgId } = context
  z.string().uuid().parse(id)
  for (const provider of listProviders()) {
    if (!provider.retryInboundEvent) continue
    const result = await provider.retryInboundEvent({ orgId, eventId: id })
    if (result.success) {
      await recordAudit({ orgId, actorId: context.userId, action: "update", entityType: "accounting_inbound_event", entityId: id, source: "accounting_inbound_retry", after: { provider: provider.key, queued: true } })
      return result
    }
  }
  return { success: false, error: "No retryable inbound event belongs to this organization" }
}

/**
 * Resolve a both-sides conflict. `keep_arc` re-queues Arc's copy through the
 * outbox so Arc wins in the accounting system; `take_remote` re-applies the
 * provider's copy over Arc with the conflict guard released. Until this
 * existed, a needs_review row's only exit was a human editing one side until
 * the amounts happened to agree.
 */
export async function resolveAccountingConflictAction(input: {
  entityType: "invoice" | "expense" | "bill"
  id: string
  resolution: "keep_arc" | "take_remote"
}): Promise<{ resolved: boolean; error: string | null }> {
  const context = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", context)
  const { orgId } = context
  z.object({ id: z.string().uuid(), entityType: z.enum(["invoice", "expense", "bill"]), resolution: z.enum(["keep_arc", "take_remote"]) }).parse(input)
  await requireAccountingEntityScope(context, input.entityType, input.id)
  const supabase = createServiceSupabaseClient()
  const mapped: "invoice" | "project_expense" | "bill" = input.entityType === "expense" ? "project_expense" : input.entityType === "bill" ? "bill" : "invoice"

  const { data: record, error: recordError } = await supabase
    .from("accounting_sync_records")
    .select("connection_id, external_id, provider, status")
    .eq("org_id", orgId)
    .eq("entity_type", mapped)
    .eq("entity_id", input.id)
    .maybeSingle()
  if (recordError) return { resolved: false, error: recordError.message }
  if (!record?.connection_id) return { resolved: false, error: "No sync record found for this transaction" }

  if (!["conflict", "needs_review"].includes(record.status)) return { resolved: false, error: "This transaction no longer has a resolvable conflict" }
  const auditResolution = () => recordAudit({ orgId, actorId: context.userId, action: "update", entityType: mapped, entityId: input.id, source: "accounting_conflict_resolution", after: { resolution: input.resolution, connectionId: record.connection_id } })
  if (input.resolution === "keep_arc") {
    const pushType: AccountingPushEntityType = mapped === "bill" ? "vendor_bill" : mapped
    const result = await enqueueAccountingPush({ orgId, entityType: pushType, entityId: input.id })
    if (result.queued) await auditResolution()
    return result.queued ? { resolved: true, error: null } : { resolved: false, error: describeEnqueueBlock(result.reason) }
  }

  if (!record.external_id) return { resolved: false, error: "This transaction has no linked record in the accounting system" }
  if (!isAccountingProviderKey(record.provider)) return { resolved: false, error: "Unknown accounting provider" }
  const provider = getProvider(record.provider)
  if (!provider.resolveConflictTakeRemote) return { resolved: false, error: `${record.provider} cannot re-apply its copy` }
  const result = await provider.resolveConflictTakeRemote({
    orgId,
    connectionId: record.connection_id,
    entityType: mapped,
    externalId: record.external_id,
  })
  if (result.reconciled) await auditResolution()
  return result.reconciled ? { resolved: true, error: null } : { resolved: false, error: result.reason ?? "Unable to apply the accounting system's copy" }
}

/**
 * Revive this org's dead-lettered accounting outbox jobs.
 *
 * "Failed" was a lifetime counter with no exit: "Sync now" enqueued a NEW row
 * (the dedupe index only covers pending), the admin retry tool explicitly
 * excludes accounting job types, and nothing anywhere reset a failed row. This
 * is that affordance — the retry budget starts over and the normal backoff
 * applies from the first re-attempt.
 */
export async function retryFailedAccountingOutboxAction(): Promise<{ revived: number }> {
  const context = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", context)
  const { orgId } = context
  const supabase = createServiceSupabaseClient()
  const scopedProjects = await getDivisionScopedProjectIds(context)
  if (scopedProjects !== null) throw new Error("Organization-wide retry requires access to all divisions; retry individual project items instead")
  const { data, error } = await supabase.rpc("retry_failed_accounting_jobs", { p_org_id: orgId, p_job_types: [...ACCOUNTING_JOB_TYPES] })
  if (error) throw new Error(`Unable to retry failed accounting jobs: ${error.message}`)
  await recordAudit({ orgId, actorId: context.userId, action: "update", entityType: "accounting_sync", source: "accounting_bulk_retry", after: { revived: Number(data ?? 0) } })
  return { revived: Number(data ?? 0) }
}

export async function listAccountingSyncHistoryAction(params?: { projectId?: string | null; limit?: number }): Promise<AccountingSyncHistoryItem[]> {
  const context = await requireOrgContext()
  await requirePermission("audit.read", context)
  const { orgId } = context
  const supabase = createServiceSupabaseClient()
  const projectId = params?.projectId ?? null
  const limit = z.number().int().min(1).max(200).parse(params?.limit ?? 50)
  if (projectId) {
    z.string().uuid().parse(projectId)
    await requireAuthorization({ permission: "audit.read", orgId, userId: context.userId, projectId, supabase: context.supabase, logDecision: true })
  }
  const scopedProjectIds = projectId ? [projectId] : await getDivisionScopedProjectIds(context)

  // Project scope narrows the QUERY, not the org-wide top-N after the fact —
  // the old shape showed "No sync history yet" on any project whose rows fell
  // outside the org's 50 most recent.
  const recordsQuery = () => supabase.from("accounting_sync_attempts")
    .select("id, provider, connection_id, entity_type, entity_id, external_id, direction, outcome, message, created_at")
    .eq("org_id", orgId)
  let records: any[] = []
  if (scopedProjectIds !== null) {
    if (scopedProjectIds.length === 0) return []
    const entityIds = new Set<string>()
    for (const table of ["invoices", "project_expenses", "vendor_bills", "payments"] as const) {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await context.supabase.from(table).select("id").eq("org_id", orgId).in("project_id", scopedProjectIds).order("id").range(offset, offset + 999)
        if (error) throw new Error(`Unable to scope accounting history: ${error.message}`)
        for (const row of data ?? []) entityIds.add(row.id)
        if ((data?.length ?? 0) < 1000) break
      }
    }
    const ids = [...entityIds]
    for (let offset = 0; offset < ids.length; offset += 200) {
      const { data, error } = await recordsQuery().in("entity_id", ids.slice(offset, offset + 200)).order("created_at", { ascending: false }).limit(limit)
      if (error) throw new Error(`Unable to load accounting history: ${error.message}`)
      records.push(...(data ?? []))
    }
    records.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    records = records.slice(0, limit)
  } else {
    const { data, error } = await recordsQuery().order("created_at", { ascending: false }).limit(limit)
    if (error) throw new Error(`Unable to load accounting history: ${error.message}`)
    records = data ?? []
  }

  const rows = (records ?? []) as any[]
  if (rows.length === 0) return []

  const idsByType = rows.reduce<Record<string, string[]>>((acc, row) => {
    const key = String(row.entity_type ?? "")
    if (!acc[key]) acc[key] = []
    acc[key].push(String(row.entity_id))
    return acc
  }, {})

  const [invoiceRows, expenseRows, billRows, paymentRows] = await Promise.all([
    idsByType.invoice?.length
      ? supabase.from("invoices").select("id, project_id, invoice_number, title").eq("org_id", orgId).in("id", idsByType.invoice)
      : Promise.resolve({ data: [] as any[] }),
    idsByType.project_expense?.length
      ? supabase.from("project_expenses").select("id, project_id, description, vendor_name_text").eq("org_id", orgId).in("id", idsByType.project_expense)
      : Promise.resolve({ data: [] as any[] }),
    idsByType.bill?.length
      ? supabase.from("vendor_bills").select("id, project_id, bill_number").eq("org_id", orgId).in("id", idsByType.bill)
      : Promise.resolve({ data: [] as any[] }),
    idsByType.payment?.length || idsByType.bill_payment?.length
      ? supabase
          .from("payments")
          .select("id, project_id, amount_cents")
          .eq("org_id", orgId)
          .in("id", [...(idsByType.payment ?? []), ...(idsByType.bill_payment ?? [])])
      : Promise.resolve({ data: [] as any[] }),
  ])

  const invoiceById = new Map((invoiceRows.data ?? []).map((row: any) => [row.id, row]))
  const expenseById = new Map((expenseRows.data ?? []).map((row: any) => [row.id, row]))
  const billById = new Map((billRows.data ?? []).map((row: any) => [row.id, row]))
  const paymentById = new Map((paymentRows.data ?? []).map((row: any) => [row.id, row]))

  return rows
    .map((row): AccountingSyncHistoryItem => {
      const entityType = String(row.entity_type ?? "")
      const entityId = String(row.entity_id)
      const invoice = invoiceById.get(entityId)
      const expense = expenseById.get(entityId)
      const bill = billById.get(entityId)
      const payment = paymentById.get(entityId)
      const projectIdForRow = invoice?.project_id ?? expense?.project_id ?? bill?.project_id ?? payment?.project_id ?? null
      const label =
        invoice?.invoice_number ??
        invoice?.title ??
        expense?.description ??
        expense?.vendor_name_text ??
        (bill?.bill_number ? `Bill ${bill.bill_number}` : null) ??
        (payment ? "Payment" : null) ??
        entityType.replaceAll("_", " ")

      return {
        id: row.id,
        entityType,
        entityId,
        projectId: projectIdForRow,
        label,
        status: row.outcome ?? "synced",
        direction: row.direction ?? "outbound",
        externalId: row.external_id ?? null,
        error: row.message ?? null,
        syncedAt: row.created_at ?? null,
      }
    })
    .filter((item) => !projectId || item.projectId === projectId)
}
