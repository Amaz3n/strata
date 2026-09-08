import { withAccountingDeliveryGroup } from "@/lib/services/accounting-delivery"
import { createHash } from "crypto"

import type { QBOClient } from "@/lib/integrations/accounting/qbo/client"
import { QBOClient as QBOClientFactory } from "@/lib/integrations/accounting/qbo/client"
import { extractIntuitEntityEvents, normalizeEventTimestamp, verifyIntuitWebhookSignature } from "@/lib/integrations/accounting/qbo/webhook"
import { collectPaginatedRows, extractLinkedQboAmounts, qboPurchaseIsCredit } from "@/lib/integrations/accounting/qbo/import-rules"
import {
  arcChangedSinceSync,
  computeLocalFingerprint,
  stampLocalFingerprint,
  storedLocalFingerprint,
} from "@/lib/integrations/accounting/local-change"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isPayableVendorBillStatus } from "@/lib/financials/ledger-status"
import { logQBO } from "@/lib/services/accounting-logger"
import { resolveLedgerAuthority, type LedgerAuthority } from "@/lib/services/books/authority"
import { recordEvent } from "@/lib/services/events"
import { recalcInvoiceBalanceAndStatus } from "@/lib/services/invoice-balance"
import { recordAccountingSyncAttempt } from "@/lib/services/accounting-sync-attempts"
import { rememberAccountingInvoiceNumberCursor } from "@/lib/services/invoice-numbers"

const CDC_ENTITIES = ["Invoice", "Payment", "Purchase", "Bill", "BillPayment", "VendorCredit", "JournalEntry"]
const CDC_OVERLAP_MINUTES = 5
/** Intuit rejects `changedSince` older than 30 days; stay safely inside it. */
const CDC_MAX_LOOKBACK_DAYS = 29
const EVENT_CLAIM_LEASE_MINUTES = 30
const MAX_EVENT_ATTEMPTS = 5

type ServiceClient = ReturnType<typeof createServiceSupabaseClient>

type WebhookEventRow = {
  id: string
  event_id: string
  realm_id: string | null
  entity_name: string | null
  entity_qbo_id: string | null
  operation: string | null
  attempts: number | null
}

function toCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100)
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.round(parsed * 100)
  }
  return null
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().split("T")[0]
}

function deriveInvoiceLinesFromQbo(qboInvoice: Awaited<ReturnType<QBOClient["getInvoiceById"]>>) {
  const lines = (qboInvoice?.Line ?? [])
    .filter((line) => line && typeof line === "object" && line.DetailType === "SalesItemLineDetail")
    .map((line) => {
      const qty = Number(line.SalesItemLineDetail?.Qty ?? 1)
      const normalizedQty = Number.isFinite(qty) && qty !== 0 ? qty : 1
      const rawLineAmount = Number(line.Amount ?? 0)
      const rawUnitPrice =
        line.SalesItemLineDetail?.UnitPrice != null ? Number(line.SalesItemLineDetail.UnitPrice) : rawLineAmount / normalizedQty
      const unitPrice = Number.isFinite(rawUnitPrice) ? rawUnitPrice : 0
      const normalizedUnitPrice = Number.isFinite(unitPrice) ? unitPrice : 0
      const taxCode = String(line.SalesItemLineDetail?.TaxCodeRef?.value ?? "").toUpperCase()

      return {
        description: String(line.Description ?? ""),
        quantity: normalizedQty,
        unit: "ea",
        unit_price_cents: Math.round(normalizedUnitPrice * 100),
        metadata: {
          taxable: taxCode !== "NON",
          qbo_item_id: line.SalesItemLineDetail?.ItemRef?.value ?? null,
          qbo_item_name: line.SalesItemLineDetail?.ItemRef?.name ?? null,
        },
      }
    })

  return lines.filter((line) => line.description.length > 0 || line.unit_price_cents !== 0)
}

type LocalSyncMapping = {
  entityId: string
  externalVersion: string | null
  localFingerprint: string | null
  status: string
  metadata: Record<string, unknown>
}

async function resolveLocalSyncMappings(
  supabase: ServiceClient,
  orgId: string,
  connectionId: string,
  entityType: string,
  externalId: string,
  externalEntityType?: string,
): Promise<LocalSyncMapping[]> {
  const rows = await collectPaginatedRows(
    (from, to) =>
      supabase
        .from("accounting_sync_records")
        .select("entity_id, external_version, status, metadata")
        .eq("org_id", orgId)
        .eq("connection_id", connectionId)
        .eq("entity_type", entityType)
        .eq("external_id", externalId)
        .order("entity_id")
        .range(from, to),
    { label: "inbound mappings" },
  )
  const expectedTypes: Record<string, string> = {
    invoice: "Invoice",
    project_expense: "Purchase",
    bill: "Bill",
    payment: "Payment",
    bill_payment: "BillPayment",
  }
  const expected = externalEntityType ?? expectedTypes[entityType]
  return rows
    .filter((row) => {
      const sourceType =
        row.metadata?.external_entity_type ??
        (["journal_entry", "client_deposit"].includes(row.metadata?.source) ? "JournalEntry" : expected)
      return expected === "*" ? sourceType !== "JournalEntry" : !expected || sourceType === expected
    })
    .map((row) => ({
      entityId: String(row.entity_id),
      externalVersion: row.external_version ?? null,
      localFingerprint: storedLocalFingerprint(row.metadata),
      status: String(row.status),
      metadata: row.metadata ?? {},
    }))
}

async function resolveLocalSyncMapping(
  supabase: ServiceClient,
  orgId: string,
  connectionId: string,
  entityType: string,
  externalId: string,
) {
  const mappings = await resolveLocalSyncMappings(supabase, orgId, connectionId, entityType, externalId)
  if (mappings.length > 1) throw new Error(`Ambiguous ${entityType} mapping; grouped reconciliation is required`)
  return mappings[0] ?? null
}

async function withInboundMappingGroup<T>(
  params: { supabase: ServiceClient; orgId: string; connectionId: string; entityName?: "purchase" | "bill" },
  entityType: string,
  externalId: string,
  work: () => Promise<T>,
) {
  const sourceType = params.entityName === "bill" ? "Bill" : undefined
  const before = await resolveLocalSyncMappings(params.supabase, params.orgId, params.connectionId, entityType, externalId, sourceType)
  return withAccountingDeliveryGroup(
    before.map((mapping) => ({ orgId: params.orgId, connectionId: params.connectionId, entityType, entityId: mapping.entityId })),
    Date.now() + 85_000,
    async () => {
      const current = await resolveLocalSyncMappings(params.supabase, params.orgId, params.connectionId, entityType, externalId, sourceType)
      if (
        current
          .map((mapping) => mapping.entityId)
          .sort()
          .join() !==
        before
          .map((mapping) => mapping.entityId)
          .sort()
          .join()
      ) {
        throw new Error("Accounting allocation group changed while acquiring its lease; retry the event")
      }
      return work()
    },
  )
}

async function markInboundConflict(
  params: { supabase: ServiceClient; orgId: string; connectionId: string; entityName?: "purchase" | "bill" },
  entityType: string,
  externalId: string,
  message: string,
) {
  const mappings = await resolveLocalSyncMappings(
    params.supabase,
    params.orgId,
    params.connectionId,
    entityType,
    externalId,
    params.entityName === "bill" ? "Bill" : undefined,
  )
  const { error } = await checkedDatabase(
    params.supabase
      .from("accounting_sync_records")
      .update({ status: "needs_review", error_message: message })
      .eq("org_id", params.orgId)
      .eq("connection_id", params.connectionId)
      .eq("entity_type", entityType)
      .eq("external_id", externalId)
      .in(
        "entity_id",
        mappings.map((mapping) => mapping.entityId),
      ),
  )
  if (error) throw new Error(`Failed to persist accounting conflict: ${error.message}`)
  return { reconciled: false as const, reason: message }
}

/**
 * A needs_review outcome is work only a person can finish, so it must reach a
 * person: the sync row's status alone was invisible unless somebody happened to
 * open the sync sheet. Best-effort — a failed notification never fails the
 * reconcile that produced it.
 */
async function emitNeedsReviewEvent(orgId: string, entityType: string, entityId: string, reason: string) {
  await recordEvent({
    orgId,
    eventType: "accounting_sync_needs_review",
    entityType,
    entityId,
    payload: { provider: "qbo", message: reason },
    channel: "notification",
  }).catch((eventError) => {
    logQBO("warn", "needs_review_event_failed", { entityType, entityId, error: String(eventError) })
  })
}

/**
 * True when the remote entity has not changed since the version we last synced.
 * Reconciling anyway would overwrite newer local edits with a stale remote copy,
 * so callers skip the write entirely.
 */
function remoteUnchangedSinceLastSync(remoteSyncToken: unknown, storedVersion: string | null) {
  if (storedVersion == null || storedVersion === "") return false
  if (typeof remoteSyncToken !== "string" || remoteSyncToken.length === 0) return false
  return remoteSyncToken === storedVersion
}

async function upsertInvoiceSyncRecord(params: {
  supabase: ServiceClient
  orgId: string
  connectionId: string
  invoiceId: string
  qboInvoiceId: string
  qboSyncToken?: string | null
}) {
  const nowIso = new Date().toISOString()

  await checkedDatabase(
    params.supabase.from("accounting_sync_records").upsert(
      {
        org_id: params.orgId,
        connection_id: params.connectionId,
        entity_type: "invoice",
        entity_id: params.invoiceId,
        provider: "qbo",
        external_id: params.qboInvoiceId,
        external_version: params.qboSyncToken ?? null,
        last_synced_at: nowIso,
        status: "synced",
        error_message: null,
      },
      { onConflict: "org_id,connection_id,entity_type,entity_id" },
    ),
  )

  // Runs after the invoice row itself has been written, so the recorded
  // fingerprint describes the reconciled state. Anything that differs from it
  // later was moved by a person.
  await stampLocalFingerprint({
    supabase: params.supabase,
    orgId: params.orgId,
    connectionId: params.connectionId,
    entityType: "invoice",
    entityId: params.invoiceId,
  })
}

async function applyReconcileInvoiceFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboInvoiceId: string
  operation?: string | null
  /** "Take QuickBooks": apply the remote copy even though Arc also changed. */
  force?: boolean
}) {
  const nowIso = new Date().toISOString()
  const mapping = await resolveLocalSyncMapping(params.supabase, params.orgId, params.connectionId, "invoice", params.qboInvoiceId)
  if (!mapping) {
    return { reconciled: false as const, reason: "No local invoice mapping" }
  }
  if (params.force && !["needs_review", "conflict"].includes(mapping.status))
    return { reconciled: false as const, reason: "Conflict was already resolved" }
  const invoiceId = mapping.entityId

  const normalizedOp = String(params.operation ?? "").toLowerCase()
  if (normalizedOp === "delete") {
    // Void through the same atomic path the app uses so draws, fee billings,
    // billed costs, retainage, and billing periods release with the invoice —
    // a bare status UPDATE left them all stranded as "invoiced".
    const { error: voidError } = await params.supabase.rpc("void_invoice_atomic", {
      p_org_id: params.orgId,
      p_invoice_id: invoiceId,
      p_actor_id: null,
    })

    if (voidError) {
      // Payments recorded or a posted pay app — this cannot be voided cleanly,
      // so flag it for a human instead of silently mismarking it.
      const reason = `QuickBooks deleted this invoice but Arc could not void it: ${voidError.message}`
      await checkedDatabase(
        params.supabase.from("accounting_sync_records").upsert(
          {
            org_id: params.orgId,
            connection_id: params.connectionId,
            entity_type: "invoice",
            entity_id: invoiceId,
            provider: "qbo",
            external_id: params.qboInvoiceId,
            last_synced_at: nowIso,
            status: "needs_review",
            error_message: reason,
          },
          { onConflict: "org_id,connection_id,entity_type,entity_id" },
        ),
      )
      return { reconciled: false as const, reason }
    }

    await upsertInvoiceSyncRecord({
      supabase: params.supabase,
      orgId: params.orgId,
      connectionId: params.connectionId,
      invoiceId,
      qboInvoiceId: params.qboInvoiceId,
      // Preserve the last known version rather than nulling it: a null stored
      // version reads as "never compared", which re-ran the full reconcile on
      // every subsequent event for this invoice.
      qboSyncToken: mapping.externalVersion,
    })
    return { reconciled: true as const }
  }

  const qboInvoice = await params.client.getInvoiceById(params.qboInvoiceId)
  if (!qboInvoice) {
    return markInboundConflict(
      params,
      "invoice",
      params.qboInvoiceId,
      "The mapped QuickBooks invoice is missing; review its Arc document and payments.",
    )
  }

  if (!params.force && remoteUnchangedSinceLastSync(qboInvoice.SyncToken, mapping.externalVersion)) {
    return { reconciled: true as const, unchanged: true as const }
  }

  const totalCents = toCents(qboInvoice.TotalAmt)
  const balanceCents = toCents(qboInvoice.Balance)
  const taxCents = toCents(qboInvoice.TxnTaxDetail?.TotalTax ?? 0) ?? 0
  const dueDate = normalizeDate(qboInvoice.DueDate)
  const issueDate = normalizeDate(qboInvoice.TxnDate)
  const nextLines = deriveInvoiceLinesFromQbo(qboInvoice)
  const subtotalCents =
    totalCents !== null
      ? Math.max(totalCents - taxCents, 0)
      : nextLines.reduce((sum, line) => sum + Math.round(line.quantity * line.unit_price_cents), 0)

  const { data: localInvoice } = await checkedDatabase(
    params.supabase
      .from("invoices")
      .select("subtotal_cents, tax_cents, total_cents, balance_due_cents")
      .eq("org_id", params.orgId)
      .eq("id", invoiceId)
      .maybeSingle(),
  )
  // A QuickBooks VOID arrives as an Update with the amounts zeroed, not as a
  // Delete. Left on the normal path it became a live "$0 / sent" invoice that
  // AR aging kept counting; route it through the same atomic void as a delete.
  const looksVoided =
    totalCents === 0 &&
    balanceCents === 0 &&
    Number(localInvoice?.total_cents ?? 0) > 0 &&
    (typeof qboInvoice.PrivateNote !== "string" ||
      /void/i.test(qboInvoice.PrivateNote) ||
      nextLines.every((line) => line.unit_price_cents === 0))
  if (looksVoided) {
    const { error: voidError } = await params.supabase.rpc("void_invoice_atomic", {
      p_org_id: params.orgId,
      p_invoice_id: invoiceId,
      p_actor_id: null,
    })
    if (!voidError) {
      await upsertInvoiceSyncRecord({
        supabase: params.supabase,
        orgId: params.orgId,
        connectionId: params.connectionId,
        invoiceId,
        qboInvoiceId: params.qboInvoiceId,
        qboSyncToken: qboInvoice.SyncToken ?? null,
      })
      return { reconciled: true as const }
    }
    return markInboundConflict(
      params,
      "invoice",
      params.qboInvoiceId,
      `QuickBooks voided this invoice but Arc requires a reviewed correction: ${voidError.message}`,
    )
  }

  const arcChangedAfterSync = arcChangedSinceSync({
    storedFingerprint: mapping.localFingerprint,
    currentFingerprint: computeLocalFingerprint("invoice", localInvoice),
  })
  const amountsDiffer =
    (totalCents !== null && Number(localInvoice?.total_cents ?? 0) !== totalCents) ||
    (balanceCents !== null && Number(localInvoice?.balance_due_cents ?? 0) !== Math.max(balanceCents, 0)) ||
    Number(localInvoice?.subtotal_cents ?? 0) !== subtotalCents ||
    Number(localInvoice?.tax_cents ?? 0) !== taxCents

  if (!params.force && arcChangedAfterSync && amountsDiffer) {
    const reason = "Both Arc and QuickBooks changed this invoice since the last sync."
    await emitNeedsReviewEvent(params.orgId, "invoice", invoiceId, reason)
    await checkedDatabase(
      params.supabase.from("accounting_sync_records").upsert(
        {
          org_id: params.orgId,
          connection_id: params.connectionId,
          entity_type: "invoice",
          entity_id: invoiceId,
          provider: "qbo",
          external_id: params.qboInvoiceId,
          external_version: qboInvoice.SyncToken ?? null,
          last_synced_at: nowIso,
          status: "needs_review",
          error_message: reason,
        },
        { onConflict: "org_id,connection_id,entity_type,entity_id" },
      ),
    )
    return { reconciled: false as const, reason }
  }

  // Document fields only — status and balance belong to the unified status
  // engine (invoice_paid_cents/derive_invoice_status). Writing QBO's Balance
  // here just got silently reverted by the next recalc, so instead the QBO
  // payment import creates the payment rows and the recalc below converges.
  const invoiceUpdate: Record<string, unknown> = {
    subtotal_cents: subtotalCents,
    tax_cents: taxCents,
  }

  if (typeof qboInvoice.DocNumber === "string" && qboInvoice.DocNumber.trim().length > 0) {
    invoiceUpdate.invoice_number = qboInvoice.DocNumber.trim()
  }
  if (issueDate) invoiceUpdate.issue_date = issueDate
  if (dueDate) invoiceUpdate.due_date = dueDate
  if (typeof qboInvoice.PrivateNote === "string") invoiceUpdate.notes = qboInvoice.PrivateNote
  if (totalCents !== null) invoiceUpdate.total_cents = totalCents

  const { error: reconcileError } = await params.supabase.rpc("replace_invoice_lines_atomic", {
    p_org_id: params.orgId,
    p_invoice_id: invoiceId,
    p_invoice_update: invoiceUpdate,
    p_lines: nextLines,
  })

  if (reconcileError) {
    throw new Error(`Failed to apply inbound invoice: ${reconcileError.message}`)
  }

  await recalcInvoiceBalanceAndStatus({
    supabase: params.supabase,
    orgId: params.orgId,
    invoiceId,
  })

  if (typeof qboInvoice.DocNumber === "string" && qboInvoice.DocNumber.trim().length > 0) {
    await rememberAccountingInvoiceNumberCursor(params.connectionId, params.orgId, qboInvoice.DocNumber.trim())
  }

  await upsertInvoiceSyncRecord({
    supabase: params.supabase,
    orgId: params.orgId,
    connectionId: params.connectionId,
    invoiceId,
    qboInvoiceId: params.qboInvoiceId,
    qboSyncToken: qboInvoice.SyncToken ?? null,
  })

  return { reconciled: true as const }
}

async function applyReconcileProjectExpenseFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboId: string
  entityName: "purchase" | "bill"
  operation?: string | null
  force?: boolean
}) {
  const mappings = await resolveLocalSyncMappings(
    params.supabase,
    params.orgId,
    params.connectionId,
    "project_expense",
    params.qboId,
    params.entityName === "bill" ? "Bill" : "Purchase",
  )
  if (!mappings.length) return { reconciled: false as const, reason: "No local expense mapping" }
  if (params.force && mappings.some((mapping) => !["needs_review", "conflict"].includes(mapping.status)))
    return { reconciled: false as const, reason: "Conflict was already resolved" }
  if (String(params.operation).toLowerCase() === "delete")
    return markInboundConflict(
      params,
      "project_expense",
      params.qboId,
      "QuickBooks deleted this transaction. Arc cost facts require an authorized correction or reversal.",
    )
  const remote =
    params.entityName === "bill" ? await params.client.getBillById(params.qboId) : await params.client.getPurchaseById(params.qboId)
  if (!remote) throw new Error("Mapped QuickBooks expense is unavailable")
  if (
    !params.force &&
    mappings.every(
      (mapping) =>
        remoteUnchangedSinceLastSync(remote.SyncToken, mapping.externalVersion) && !["needs_review", "conflict"].includes(mapping.status),
    )
  ) {
    return { reconciled: true as const, unchanged: true as const }
  }
  // A split is one remote document with many local allocations. Never compare or
  // overwrite an individual allocation with the whole Purchase total.
  if (mappings.length > 1 || mappings.some((mapping) => mapping.metadata.source === "purchase_split")) {
    const { data: allocations } = await checkedDatabase(
      params.supabase
        .from("project_expenses")
        .select("id, amount_cents, tax_cents, expense_date, accounting_coding, metadata")
        .eq("org_id", params.orgId)
        .in(
          "id",
          mappings.map((mapping) => mapping.entityId),
        ),
    )
    const sourceLines = (remote.Line ?? []).filter((line: any) => line.AccountBasedExpenseLineDetail || line.ItemBasedExpenseLineDetail)
    const byLine = new Map((allocations ?? []).map((allocation) => [String(allocation.metadata?.qbo_purchase_line_id ?? ""), allocation]))
    const vendor = remote.EntityRef ?? remote.VendorRef
    const matches =
      sourceLines.length === mappings.length &&
      (allocations ?? []).length === mappings.length &&
      sourceLines.every((line: any) => {
        const allocation = byLine.get(String(line.Id))
        const detail = line.AccountBasedExpenseLineDetail ?? line.ItemBasedExpenseLineDetail
        const account = detail?.AccountRef ?? detail?.ItemRef
        const coding = allocation?.accounting_coding
        return (
          allocation &&
          Math.abs(toCents(line.Amount) ?? 0) === Number(allocation.amount_cents) + Number(allocation.tax_cents ?? 0) &&
          normalizeDate(remote.TxnDate) === allocation.expense_date &&
          String(account?.value ?? "") === String(coding?.expense_account?.id ?? "") &&
          String(vendor?.value ?? "") === String(coding?.counterparty?.id ?? coding?.vendor?.id ?? "") &&
          String(detail?.ClassRef?.value ?? "") === String(coding?.dimensions?.class?.id ?? coding?.class?.id ?? "")
        )
      })
    if (matches && (params.force || mappings.every((mapping) => !["needs_review", "conflict"].includes(mapping.status)))) {
      for (const mapping of mappings)
        await completeInboundMapping(params, "project_expense", mapping.entityId, params.qboId, remote.SyncToken ?? null)
      return { reconciled: true as const, unchanged: true as const }
    }
    return markInboundConflict(
      params,
      "project_expense",
      params.qboId,
      "QuickBooks changed a split purchase. Review all mapped allocations together before changing posted costs.",
    )
  }
  const mapping = mappings[0]
  const { data: local, error: loadError } = await checkedDatabase(
    params.supabase
      .from("project_expenses")
      .select("amount_cents, tax_cents, status, metadata, expense_date, accounting_coding")
      .eq("org_id", params.orgId)
      .eq("id", mapping.entityId)
      .single(),
  )
  if (loadError || !local) throw new Error(loadError?.message ?? "Mapped expense is missing")
  const detail = (remote.Line ?? []).find((line: any) => line.AccountBasedExpenseLineDetail)?.AccountBasedExpenseLineDetail
  const vendor = remote.VendorRef ?? remote.EntityRef
  const total = toCents(remote.TotalAmt)
  const amount = total === null ? null : Math.abs(total)
  const coding = {
    ...(local.accounting_coding ?? {}),
    ...(vendor?.value ? { counterparty: { id: String(vendor.value), name: vendor.name ?? null } } : {}),
    ...(detail?.AccountRef?.value
      ? { expense_account: { id: String(detail.AccountRef.value), name: detail.AccountRef.name ?? null } }
      : {}),
  }
  const currentAmount = Number(local.amount_cents ?? 0) + Number(local.tax_cents ?? 0)
  const differs =
    (amount !== null && amount !== currentAmount) ||
    normalizeDate(remote.TxnDate) !== local.expense_date ||
    JSON.stringify(coding) !== JSON.stringify(local.accounting_coding ?? {})
  if (
    (!params.force &&
      arcChangedSinceSync({
        storedFingerprint: mapping.localFingerprint,
        currentFingerprint: computeLocalFingerprint("project_expense", local),
      }) &&
      differs) ||
    (amount !== null && amount !== currentAmount && ["approved", "invoiced", "locked"].includes(String(local.status)))
  ) {
    return markInboundConflict(
      params,
      "project_expense",
      params.qboId,
      "QuickBooks changed this expense. Posted cost corrections require review.",
    )
  }
  const { error } = await checkedDatabase(
    params.supabase
      .from("project_expenses")
      .update({
        accounting_coding: coding,
        ...(amount !== null ? { amount_cents: amount, tax_cents: 0 } : {}),
        ...(normalizeDate(remote.TxnDate) ? { expense_date: normalizeDate(remote.TxnDate) } : {}),
        ...(qboPurchaseIsCredit(remote)
          ? { metadata: { ...(local.metadata ?? {}), source: "expense_credit", qbo_purchase_credit: true } }
          : {}),
      })
      .eq("org_id", params.orgId)
      .eq("id", mapping.entityId),
  )
  if (error) throw new Error(error.message)
  await completeInboundMapping(params, "project_expense", mapping.entityId, params.qboId, remote.SyncToken ?? null)
  return { reconciled: true as const }
}

async function completeInboundMapping(
  params: { supabase: ServiceClient; orgId: string; connectionId: string },
  entityType: "project_expense" | "bill",
  entityId: string,
  externalId: string,
  version: string | null,
) {
  const { error } = await checkedDatabase(
    params.supabase
      .from("accounting_sync_records")
      .update({ external_version: version, status: "synced", error_message: null, last_synced_at: new Date().toISOString() })
      .eq("org_id", params.orgId)
      .eq("connection_id", params.connectionId)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .eq("external_id", externalId),
  )
  if (error) throw new Error(error.message)
  await stampLocalFingerprint({ ...params, entityType, entityId })
}

async function applyReconcileVendorBillFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboId: string
  operation?: string | null
  force?: boolean
}) {
  const mapping = await resolveLocalSyncMapping(params.supabase, params.orgId, params.connectionId, "bill", params.qboId)
  if (!mapping) return { reconciled: false as const, reason: "No local vendor bill mapping" }
  if (params.force && !["needs_review", "conflict"].includes(mapping.status))
    return { reconciled: false as const, reason: "Conflict was already resolved" }
  if (String(params.operation).toLowerCase() === "delete")
    return markInboundConflict(
      params,
      "bill",
      params.qboId,
      "QuickBooks deleted this bill. Review its existing Arc payable before an authorized correction.",
    )
  const remote = await params.client.getBillById(params.qboId)
  if (!remote) throw new Error("Mapped QuickBooks bill is unavailable")
  if (!params.force && remoteUnchangedSinceLastSync(remote.SyncToken, mapping.externalVersion))
    return { reconciled: true as const, unchanged: true as const }
  const { data: local, error: loadError } = await checkedDatabase(
    params.supabase
      .from("vendor_bills")
      .select("total_cents, status, bill_date, due_date, accounting_coding")
      .eq("org_id", params.orgId)
      .eq("id", mapping.entityId)
      .single(),
  )
  if (loadError || !local) throw new Error(loadError?.message ?? "Mapped bill is missing")
  const amount = toCents(remote.TotalAmt)
  const amountDiffers = amount !== null && amount !== Number(local.total_cents)
  if (
    (amountDiffers && isPayableVendorBillStatus(local.status)) ||
    (!params.force &&
      arcChangedSinceSync({ storedFingerprint: mapping.localFingerprint, currentFingerprint: computeLocalFingerprint("bill", local) }))
  ) {
    return markInboundConflict(
      params,
      "bill",
      params.qboId,
      "QuickBooks changed this bill. Review local changes and posted payable facts before applying the remote document.",
    )
  }
  const detail = (remote.Line ?? []).find((line: any) => line.AccountBasedExpenseLineDetail)?.AccountBasedExpenseLineDetail
  const coding = {
    ...(local.accounting_coding ?? {}),
    ...(remote.VendorRef?.value ? { counterparty: { id: String(remote.VendorRef.value), name: remote.VendorRef.name ?? null } } : {}),
    ...(detail?.AccountRef?.value
      ? { expense_account: { id: String(detail.AccountRef.value), name: detail.AccountRef.name ?? null } }
      : {}),
    ...(remote.APAccountRef?.value
      ? { ap_account: { id: String(remote.APAccountRef.value), name: remote.APAccountRef.name ?? null } }
      : {}),
  }
  const { error } = await checkedDatabase(
    params.supabase
      .from("vendor_bills")
      .update({
        accounting_coding: coding,
        ...(amount !== null ? { total_cents: amount } : {}),
        ...(normalizeDate(remote.TxnDate) ? { bill_date: normalizeDate(remote.TxnDate) } : {}),
        ...(normalizeDate(remote.DueDate) ? { due_date: normalizeDate(remote.DueDate) } : {}),
        ...(remote.DocNumber ? { bill_number: remote.DocNumber } : {}),
      })
      .eq("org_id", params.orgId)
      .eq("id", mapping.entityId),
  )
  if (error) throw new Error(error.message)
  await completeInboundMapping(params, "bill", mapping.entityId, params.qboId, remote.SyncToken ?? null)
  return { reconciled: true as const }
}

async function reconcileBillPaymentFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  qboBillPaymentId: string
  operation?: string | null
}) {
  return reconcilePaymentFacts({
    ...params,
    externalId: params.qboBillPaymentId,
    entityType: "bill_payment",
    remote: String(params.operation).toLowerCase() === "delete" ? null : await params.client.getBillPaymentById(params.qboBillPaymentId),
  })
}

/** Financial corrections are deliberate domain operations. Remote changes may
 * identify a conflict, but cannot silently rewrite or reverse settled cash. */
async function applyReconcilePaymentFacts(params: {
  supabase: ServiceClient
  orgId: string
  connectionId: string
  externalId: string
  entityType: "payment" | "bill_payment"
  remote: any
  operation?: string | null
}) {
  const mappings = await resolveLocalSyncMappings(params.supabase, params.orgId, params.connectionId, params.entityType, params.externalId)
  if (!mappings.length) return { reconciled: false as const, reason: "Payment is available for manual import" }
  if (String(params.operation).toLowerCase() === "delete")
    return markInboundConflict(
      params,
      params.entityType,
      params.externalId,
      "QuickBooks deleted this payment. Verify whether money moved and authorize a correction or restoration; Arc cash facts were preserved.",
    )
  if (!params.remote) throw new Error("Mapped QuickBooks payment is unavailable")
  const { data: payments, error: paymentError } = await checkedDatabase(
    params.supabase
      .from("payments")
      .select("id, invoice_id, bill_id, amount_cents, status, metadata")
      .eq("org_id", params.orgId)
      .in(
        "id",
        mappings.map((mapping) => mapping.entityId),
      ),
  )
  if (paymentError) throw new Error(paymentError.message)
  const documentType = params.entityType === "payment" ? "invoice" : "bill"
  const applications = extractLinkedQboAmounts(params.remote, documentType)
  const documents = await collectPaginatedRows(
    (from, to) =>
      params.supabase
        .from("accounting_sync_records")
        .select("entity_id, external_id")
        .eq("org_id", params.orgId)
        .eq("connection_id", params.connectionId)
        .eq("entity_type", documentType)
        .order("entity_id")
        .range(from, to),
    { label: "payment application mappings" },
  )
  const byDocument = new Map(documents.map((document) => [String(document.entity_id), String(document.external_id)]))
  const localApplications = new Map<string, number>()
  let localCash = 0
  let incomplete = (payments ?? []).length !== mappings.length
  for (const payment of payments ?? []) {
    const externalDocument = byDocument.get(String(documentType === "invoice" ? payment.invoice_id : payment.bill_id))
    if (!externalDocument || !["succeeded", "completed", "paid"].includes(String(payment.status))) {
      incomplete = true
      continue
    }
    const amount = Number(payment.amount_cents ?? 0)
    localApplications.set(externalDocument, (localApplications.get(externalDocument) ?? 0) + amount)
    if (!(payment.metadata as Record<string, unknown> | null)?.vendor_credit_applied) localCash += amount
  }
  const remoteCash = toCents(params.remote.TotalAmt)
  const changed =
    incomplete ||
    remoteCash === null ||
    remoteCash !== localCash ||
    applications.length !== localApplications.size ||
    applications.some((application) => localApplications.get(application.qboId) !== application.amountCents)
  if (changed)
    return markInboundConflict(
      params,
      params.entityType,
      params.externalId,
      "QuickBooks payment amount or applications differ from Arc. Review every mapped allocation and use an authorized payment correction; cash facts were preserved.",
    )
  const { error } = await checkedDatabase(
    params.supabase
      .from("accounting_sync_records")
      .update({
        status: "synced",
        error_message: null,
        external_version: params.remote.SyncToken ?? null,
        last_synced_at: new Date().toISOString(),
      })
      .eq("org_id", params.orgId)
      .eq("connection_id", params.connectionId)
      .eq("entity_type", params.entityType)
      .eq("external_id", params.externalId),
  )
  if (error) throw new Error(error.message)
  return { reconciled: true as const }
}

async function markEventProcessed(
  supabase: ServiceClient,
  eventId: string,
  status: "reconciled" | "ignored" | "error",
  error?: string,
  previousAttempts = 0,
) {
  const attempts = status === "error" ? previousAttempts + 1 : previousAttempts
  const retryDelaySeconds = Math.min(60 * 60, 2 ** Math.max(attempts - 1, 0) * 60)
  const nextAttemptAt =
    status === "error" && attempts < MAX_EVENT_ATTEMPTS ? new Date(Date.now() + retryDelaySeconds * 1000).toISOString() : null
  await checkedDatabase(
    supabase
      .from("qbo_webhook_events")
      .update({
        process_status: status,
        process_error: error ?? null,
        processed_at: status === "error" && attempts < MAX_EVENT_ATTEMPTS ? null : new Date().toISOString(),
        attempts,
        next_attempt_at: nextAttemptAt,
      })
      .eq("id", eventId),
  )
}

/**
 * Accept, verify, and persist an Intuit webhook delivery into the inbound event queue.
 * Returns null when the signature is invalid (caller responds 401).
 */
export async function receiveQboWebhook(input: {
  rawBody: string
  headers: Record<string, string | null>
}): Promise<{ received: number; inserted: number } | null> {
  const signature = input.headers["intuit-signature"] ?? null
  const isValid = verifyIntuitWebhookSignature({
    payload: input.rawBody,
    signatureHeader: signature,
    verifierToken: process.env.QBO_WEBHOOK_VERIFIER_TOKEN,
  })
  if (!isValid) {
    logQBO("warn", "webhook_invalid_signature", { hasSignature: Boolean(signature) })
    return null
  }

  const supabase = createServiceSupabaseClient()
  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex")
  const events = extractIntuitEntityEvents(JSON.parse(input.rawBody || "{}"))
  let inserted = 0
  for (const event of events) {
    // ignoreDuplicates: a redelivered event must not reset an already-processed row to pending.
    const { error } = await checkedDatabase(
      supabase.from("qbo_webhook_events").upsert(
        {
          event_id: event.eventId,
          payload_hash: payloadHash,
          realm_id: event.realmId,
          entity_name: event.entityName,
          entity_qbo_id: event.entityId,
          operation: event.operation,
          last_updated: Number.isFinite(Date.parse(event.lastUpdated)) ? new Date(event.lastUpdated).toISOString() : null,
          received_at: new Date().toISOString(),
          process_status: "pending",
          process_error: null,
          processed_at: null,
        },
        {
          onConflict: "event_id",
          ignoreDuplicates: true,
        },
      ),
    )
    if (!error) {
      inserted += 1
    } else {
      // A duplicate is silently ignored by the upsert; reaching here is a real
      // insert failure and must not be indistinguishable from one.
      throw new Error(`Webhook event was not durably stored: ${error.message}`)
    }
  }
  return { received: events.length, inserted }
}

/**
 * Poll QBO change-data-capture for one connection and enqueue changes into the
 * inbound event queue. Advances the per-connection cursor on success.
 */
export async function ingestQboCdcChanges(input: {
  connectionId: string
  lookbackMinutes?: number | null
}): Promise<{ scanned: number; inserted: number }> {
  const supabase = createServiceSupabaseClient()
  const { data: connection } = await checkedDatabase(
    supabase
      .from("accounting_connections")
      .select("id, org_id, external_account_id, settings")
      .eq("id", input.connectionId)
      .eq("status", "active")
      .maybeSingle(),
  )
  if (!connection?.org_id) return { scanned: 0, inserted: 0 }

  // Fails closed: an unreadable authority row throws rather than letting an
  // Arc-authoritative org's ledger be overwritten from outside. CDC ingestion is
  // cron-driven, so the throw surfaces on the job run and the next pass retries.
  if ((await resolveLedgerAuthority(connection.org_id, supabase)) === "arc") {
    return { scanned: 0, inserted: 0 }
  }

  const settings = (connection.settings as Record<string, unknown> | null) ?? {}
  const storedCursor = typeof settings.qbo_cdc_last_synced_at === "string" ? settings.qbo_cdc_last_synced_at : null
  const rawCursorMs =
    input.lookbackMinutes != null
      ? Date.now() - input.lookbackMinutes * 60 * 1000
      : storedCursor
        ? new Date(storedCursor).getTime()
        : Date.now() - 24 * 60 * 60 * 1000
  // Intuit rejects changedSince older than 30 days, so an idle month (paused
  // org, cron outage, a reconnect carrying the old cursor forward) used to
  // fail EVERY poll forever — the cursor could never advance to heal itself.
  // Clamping forfeits changes older than the window, which the reconciliation
  // digest reports as drift; an unfixable poll loop reported nothing.
  const cdcFloorMs = Date.now() - CDC_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  const cursorMs = Math.max(Number.isFinite(rawCursorMs) ? rawCursorMs : cdcFloorMs, cdcFloorMs)
  if (rawCursorMs < cdcFloorMs) {
    logQBO("warn", "qbo_cdc_cursor_clamped", {
      connectionId: connection.id,
      storedCursor,
      clampedTo: new Date(cdcFloorMs).toISOString(),
    })
  }
  const changedSince = new Date(Math.max(cursorMs - CDC_OVERLAP_MINUTES * 60 * 1000, cdcFloorMs)).toISOString()

  const client = await QBOClientFactory.forConnection(connection.id)
  if (!client) return { scanned: 0, inserted: 0 }

  const payload = await client.changeDataCapture(CDC_ENTITIES, changedSince)
  const response = (payload as any)?.CDCResponse?.[0]?.QueryResponse ?? []
  const rows: Array<{ entityName: string; id: string; lastUpdated: string; deleted: boolean }> = []
  for (const queryResponse of response) {
    for (const entityName of CDC_ENTITIES) {
      const entities = queryResponse?.[entityName]
      if (!Array.isArray(entities)) continue
      for (const entity of entities) {
        if (!entity?.Id) continue
        rows.push({
          entityName,
          id: String(entity.Id),
          // No wall-clock fallback: stamping now() minted a brand-new event id
          // for the same unchanged entity on every poll — unbounded queue rows
          // plus repeated reconciliation. The sentinel keeps the id stable.
          lastUpdated: entity.MetaData?.LastUpdatedTime ? String(entity.MetaData.LastUpdatedTime) : "unknown-time",
          deleted: String(entity.status ?? "") === "Deleted",
        })
      }
    }
  }

  let inserted = 0
  let insertFailed = false
  const nowIso = new Date().toISOString()
  for (const row of rows) {
    const operation = row.deleted ? "Delete" : "Update"
    // Same event-id shape as webhook deliveries — with the timestamp ISO-
    // normalized on BOTH paths (see normalizeEventTimestamp) — so a change that
    // arrives via webhook and CDC collapses into one queue row instead of being
    // reconciled twice.
    const idTimestamp = row.lastUpdated === "unknown-time" ? row.lastUpdated : normalizeEventTimestamp(row.lastUpdated)
    const eventId = `${connection.external_account_id}:${row.entityName}:${row.id}:${operation}:${idTimestamp}`
    const { error: insertError } = await checkedDatabase(
      supabase.from("qbo_webhook_events").upsert(
        {
          event_id: eventId,
          payload_hash: createHash("sha256").update(eventId).digest("hex"),
          realm_id: connection.external_account_id,
          entity_name: row.entityName,
          entity_qbo_id: row.id,
          operation,
          last_updated: Number.isFinite(Date.parse(row.lastUpdated)) ? new Date(row.lastUpdated).toISOString() : null,
          received_at: nowIso,
          process_status: "pending",
          process_error: null,
          processed_at: null,
        },
        {
          onConflict: "event_id",
          ignoreDuplicates: true,
        },
      ),
    )
    if (insertError) insertFailed = true
    else inserted += 1
  }

  // Advance the cursor whenever the fetch and all inserts succeeded — duplicates are
  // ignored (not errors), so an all-duplicate overlap window can no longer stall it.
  if (!insertFailed) {
    const maxUpdatedAt = rows.reduce<string | null>((max, row) => {
      const timestamp = Date.parse(row.lastUpdated)
      if (!Number.isFinite(timestamp)) return max
      const iso = new Date(timestamp).toISOString()
      return !max || iso > max ? iso : max
    }, null)
    const { error: cursorError } = await supabase.rpc("update_qbo_cdc_cursor", {
      p_connection_id: connection.id,
      p_cursor: maxUpdatedAt && maxUpdatedAt > nowIso ? maxUpdatedAt : nowIso,
    })
    if (cursorError) throw new Error(`Failed to persist CDC cursor: ${cursorError.message}`)
  } else {
    throw new Error("CDC events were not all durably stored; cursor was retained")
  }

  return { scanned: rows.length, inserted }
}

/**
 * Conservative reconcile for entity types Arc imports but has no field-level
 * merge for (vendor credits, journal entries). Before this they were
 * import-once-and-diverge: a QBO-side edit or deletion after import was never
 * picked up by anything. The goal here is honesty rather than auto-merge — a
 * remote change flips the imported record's sync row to needs_review so a
 * person sees the divergence, and an echo of Arc's own push is suppressed by
 * the SyncToken comparison exactly like the invoice path.
 */
async function reconcileImportedRecordFromQbo(params: {
  supabase: ServiceClient
  client: QBOClient
  orgId: string
  connectionId: string
  entityName: "vendorcredit" | "journalentry"
  qboId: string
  operation: string | null
}): Promise<{ reconciled: boolean; reason?: string }> {
  const types = params.entityName === "vendorcredit" ? ["vendor_credit"] : ["project_expense", "invoice", "payment", "journal_entry"]
  const rows = await collectPaginatedRows(
    (from, to) =>
      params.supabase
        .from("accounting_sync_records")
        .select("entity_type, entity_id, metadata, external_version")
        .eq("org_id", params.orgId)
        .eq("connection_id", params.connectionId)
        .in("entity_type", types)
        .eq("external_id", params.qboId)
        .order("entity_id")
        .range(from, to),
    { label: "imported group mappings" },
  )
  const mapped = rows.filter(
    (row) =>
      params.entityName === "vendorcredit" ||
      ["journal_entry", "client_deposit"].includes(row.metadata?.source) ||
      row.entity_type === "journal_entry",
  )
  if (!mapped.length) return { reconciled: false, reason: "No local mapping; available for manual import" }
  return withAccountingDeliveryGroup(
    mapped.map((row) => ({ orgId: params.orgId, connectionId: params.connectionId, entityType: row.entity_type, entityId: row.entity_id })),
    Date.now() + 85_000,
    async () => {
      const remote =
        String(params.operation).toLowerCase() === "delete"
          ? null
          : params.entityName === "vendorcredit"
            ? await params.client.getVendorCreditById(params.qboId)
            : await params.client.getJournalEntryById(params.qboId)
      if (remote && mapped.every((row) => remoteUnchangedSinceLastSync(remote.SyncToken, row.external_version))) return { reconciled: true }
      for (const type of new Set(mapped.map((row) => row.entity_type))) {
        await checkedDatabase(
          params.supabase
            .from("accounting_sync_records")
            .update({
              status: "needs_review",
              error_message: remote
                ? "QuickBooks changed this imported document. Review all mapped allocations and use authorized financial corrections."
                : "QuickBooks deleted this imported document. Review every mapped allocation before correcting its existing Arc facts.",
            })
            .eq("org_id", params.orgId)
            .eq("connection_id", params.connectionId)
            .eq("entity_type", type)
            .eq("external_id", params.qboId)
            .in(
              "entity_id",
              mapped.filter((row) => row.entity_type === type).map((row) => row.entity_id),
            ),
        )
      }
      return { reconciled: true }
    },
  )
}

/**
 * "Take QuickBooks" for a conflicted record: re-run the reconcile with the
 * both-sides guard released, so the remote copy is applied and the sync row
 * returns to synced. The stored SyncToken makes this safe — the caller only
 * offers it on rows already flagged needs_review/conflict.
 */
export async function forceReconcileFromQbo(input: {
  orgId: string
  connectionId: string
  entityType: "invoice" | "project_expense" | "bill"
  externalId: string
}): Promise<{ reconciled: boolean; reason?: string }> {
  const supabase = createServiceSupabaseClient()
  const mappings = await resolveLocalSyncMappings(
    supabase,
    input.orgId,
    input.connectionId,
    input.entityType,
    input.externalId,
    input.entityType === "project_expense" ? "*" : undefined,
  )
  if (!mappings.length || mappings.some((mapping) => !["needs_review", "conflict"].includes(mapping.status))) {
    return { reconciled: false, reason: "This record is no longer in a resolvable conflict state" }
  }
  const client = await QBOClientFactory.forConnection(input.connectionId)
  if (!client) return { reconciled: false, reason: "QuickBooks connection is unavailable" }
  if (input.entityType === "invoice") {
    return reconcileInvoiceFromQbo({
      supabase,
      client,
      orgId: input.orgId,
      connectionId: input.connectionId,
      qboInvoiceId: input.externalId,
      force: true,
    })
  }
  if (input.entityType === "bill") {
    return reconcileVendorBillFromQbo({
      supabase,
      client,
      orgId: input.orgId,
      connectionId: input.connectionId,
      qboId: input.externalId,
      force: true,
    })
  }
  const entityName = mappings[0].metadata.external_entity_type === "Bill" ? "bill" : "purchase"
  return reconcileProjectExpenseFromQbo({
    supabase,
    client,
    orgId: input.orgId,
    connectionId: input.connectionId,
    qboId: input.externalId,
    entityName,
    force: true,
  })
}

/**
 * Drain the inbound event queue: claim events with a lease, re-fetch each entity from
 * QBO, and reconcile it into Arc. Events stranded in `processing` past their lease are
 * recovered to `retry` first.
 */
export async function drainQboInboundEvents(input: {
  limit: number
  deadline?: number
}): Promise<{ processed: number; reconciled: number; ignored: number; errored: number }> {
  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  // Local counters ride along with every terminal outcome — "processed" alone
  // counted dropped work as done, hiding how much inbound was being ignored.
  let ignored = 0
  let errored = 0
  // Per-row trace context, set once the event's connection resolves; null for
  // events that never matched a connection (nothing to attribute them to).
  let currentTrace: { orgId: string; connectionId: string; entityName: string | null; externalId: string | null } | null = null
  const finishEvent = async (eventId: string, status: "reconciled" | "ignored" | "error", processError?: string, attempts?: number) => {
    if (status === "ignored") ignored += 1
    if (status === "error") errored += 1
    await markEventProcessed(supabase, eventId, status, processError, attempts)
    if (currentTrace) {
      await recordAccountingSyncAttempt({
        orgId: currentTrace.orgId,
        connectionId: currentTrace.connectionId,
        provider: "qbo",
        entityType: currentTrace.entityName?.toLowerCase() ?? "unknown",
        entityId: null,
        externalId: currentTrace.externalId,
        direction: "inbound",
        outcome: status === "reconciled" ? "synced" : status === "ignored" ? "skipped" : "error",
        message: processError ?? null,
      })
    }
  }

  // Retention: the queue table had none, so it grew by one row per change per
  // connection forever. Terminal rows older than 60 days carry no operational
  // value (the sync ledger keeps the durable state); deleting a bounded batch
  // per drain keeps each pass cheap while draining the backlog over time.
  const retentionCutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const { data: expiredRows } = await checkedDatabase(
    supabase
      .from("qbo_webhook_events")
      .select("id")
      .in("process_status", ["reconciled", "ignored"])
      .lt("received_at", retentionCutoff)
      .limit(500),
  )
  if (expiredRows && expiredRows.length > 0) {
    await checkedDatabase(
      supabase
        .from("qbo_webhook_events")
        .delete()
        .in(
          "id",
          expiredRows.map((expired) => expired.id),
        ),
    )
  }

  // Reclaim leases abandoned by a crashed worker — and CHARGE the attempt.
  // A hard crash (timeout, OOM) bypasses markEventProcessed, so without the
  // increment a poison event cycled processing→retry forever at the head of
  // the oldest-first drain, occupying batch slots on every run.
  const { data: stranded } = await checkedDatabase(
    supabase.from("qbo_webhook_events").select("id, attempts").eq("process_status", "processing").lt("next_attempt_at", nowIso),
  )
  for (const strandedRow of stranded ?? []) {
    const attempts = (strandedRow.attempts ?? 0) + 1
    const exhausted = attempts >= MAX_EVENT_ATTEMPTS
    await checkedDatabase(
      supabase
        .from("qbo_webhook_events")
        .update({
          process_status: exhausted ? "error" : "retry",
          attempts,
          ...(exhausted
            ? { process_error: "Processing crashed repeatedly (lease expired without a result)", processed_at: new Date().toISOString() }
            : {}),
        })
        .eq("id", strandedRow.id)
        .eq("process_status", "processing"),
    )
  }

  const { data: events, error } = await checkedDatabase(
    supabase
      .from("qbo_webhook_events")
      .select("id, event_id, realm_id, entity_name, entity_qbo_id, operation, attempts")
      .or(`process_status.eq.pending,and(process_status.in.(error,retry),attempts.lt.${MAX_EVENT_ATTEMPTS},next_attempt_at.lte.${nowIso})`)
      .order("received_at", { ascending: true })
      .limit(input.limit),
  )

  if (error) throw new Error(`Unable to load inbound accounting events: ${error.message}`)

  const rows = (events ?? []) as WebhookEventRow[]
  if (rows.length === 0) return { processed: 0, reconciled: 0, ignored: 0, errored: 0 }

  let reconciled = 0
  let processed = 0
  const clientsByConnectionId = new Map<string, QBOClient | null>()

  for (const row of rows) {
    if (input.deadline && Date.now() >= input.deadline - 1_000) break
    currentTrace = null
    try {
      // The claim writes a lease into next_attempt_at so a crashed worker's events
      // are recovered by the sweep above instead of stranding in `processing`.
      const { data: claimed } = await checkedDatabase(
        supabase
          .from("qbo_webhook_events")
          .update({
            process_status: "processing",
            process_error: null,
            next_attempt_at: new Date(Date.now() + EVENT_CLAIM_LEASE_MINUTES * 60 * 1000).toISOString(),
          })
          .eq("id", row.id)
          .in("process_status", ["pending", "error", "retry"])
          .select("id")
          .maybeSingle(),
      )

      if (!claimed?.id) {
        continue
      }

      if (!row.realm_id || !row.entity_name || !row.entity_qbo_id) {
        await finishEvent(row.id, "ignored", "Missing webhook context")
        processed += 1
        continue
      }

      const { data: connection } = await checkedDatabase(
        supabase
          .from("accounting_connections")
          .select("id, org_id")
          .eq("provider", "qbo")
          .eq("external_account_id", row.realm_id)
          .eq("status", "active")
          .maybeSingle(),
      )

      if (!connection?.org_id || !connection?.id) {
        await finishEvent(row.id, "ignored", "No active org connection for realm")
        processed += 1
        continue
      }
      currentTrace = {
        orgId: connection.org_id,
        connectionId: connection.id,
        entityName: row.entity_name,
        externalId: row.entity_qbo_id,
      }

      // Fails closed: without knowing who owns the ledger this event must not be
      // applied. Erroring the single event reschedules it on the backoff rather
      // than aborting the rest of the drain.
      let ledgerAuthority: LedgerAuthority
      try {
        ledgerAuthority = await resolveLedgerAuthority(connection.org_id, supabase)
      } catch (authorityError) {
        const message = authorityError instanceof Error ? authorityError.message : "Unable to resolve ledger authority"
        await finishEvent(row.id, "error", message, row.attempts ?? 0)
        processed += 1
        continue
      }

      if (ledgerAuthority === "arc") {
        await finishEvent(row.id, "ignored", "Arc is authoritative; external changes are drift-only")
        // Activity-only: "books.external_drift_detected" is not a NotificationType,
        // so a notification channel produced a raw-string-titled notification for
        // an empty audience. The real user-facing alert is the reconciliation
        // digest's accounting_reconciliation_drift.
        await recordEvent({
          orgId: connection.org_id,
          eventType: "books.external_drift_detected",
          entityType: "accounting_connection",
          entityId: connection.id,
          payload: { provider: "qbo", entity_name: row.entity_name, external_id: row.entity_qbo_id, operation: row.operation },
        })
        processed += 1
        continue
      }

      const entityName = row.entity_name.toLowerCase()
      const orgId = connection.org_id as string
      const connectionId = connection.id as string
      let client = clientsByConnectionId.get(connectionId)
      if (client === undefined) {
        client = await QBOClientFactory.forConnection(connectionId)
        clientsByConnectionId.set(connectionId, client)
      }

      if (!client) {
        await finishEvent(row.id, "error", "Unable to initialize QBO client", row.attempts ?? 0)
        processed += 1
        continue
      }

      if (entityName === "invoice") {
        const result = await reconcileInvoiceFromQbo({
          supabase,
          client,
          orgId,
          connectionId,
          qboInvoiceId: row.entity_qbo_id,
          operation: row.operation,
        })

        if (result.reconciled) {
          reconciled += 1
          await finishEvent(row.id, "reconciled")
        } else {
          await finishEvent(row.id, "ignored", result.reason)
        }
      } else if (entityName === "payment") {
        const result = await reconcilePaymentFacts({
          supabase,
          orgId,
          connectionId,
          externalId: row.entity_qbo_id,
          entityType: "payment",
          operation: row.operation,
          remote: String(row.operation).toLowerCase() === "delete" ? null : await client.getPaymentById(row.entity_qbo_id),
        })
        await finishEvent(row.id, result.reconciled ? "reconciled" : "ignored", "reason" in result ? result.reason : undefined)
        if (result.reconciled) reconciled += 1
      } else if (entityName === "purchase" || entityName === "bill") {
        const vendorBillResult =
          entityName === "bill"
            ? await reconcileVendorBillFromQbo({
                supabase,
                client,
                orgId,
                connectionId,
                qboId: row.entity_qbo_id,
                operation: row.operation,
              })
            : { reconciled: false as const, reason: "Not a QBO bill" }

        const result = vendorBillResult.reconciled
          ? vendorBillResult
          : await reconcileProjectExpenseFromQbo({
              supabase,
              client,
              orgId,
              connectionId,
              qboId: row.entity_qbo_id,
              entityName: entityName as "purchase" | "bill",
              operation: row.operation,
            })

        if (result.reconciled) {
          reconciled += 1
          await finishEvent(row.id, "reconciled")
        } else {
          await finishEvent(row.id, "ignored", result.reason)
        }
      } else if (entityName === "billpayment") {
        const result = await reconcileBillPaymentFromQbo({
          supabase,
          client,
          orgId,
          connectionId,
          qboBillPaymentId: row.entity_qbo_id,
          operation: row.operation,
        })

        if (result.reconciled) {
          reconciled += 1
          await finishEvent(row.id, "reconciled")
        } else {
          await finishEvent(row.id, "ignored", result.reason)
        }
      } else if (entityName === "vendorcredit" || entityName === "journalentry") {
        const result = await reconcileImportedRecordFromQbo({
          supabase,
          client,
          orgId,
          connectionId,
          entityName,
          qboId: row.entity_qbo_id,
          operation: row.operation,
        })

        if (result.reconciled) {
          reconciled += 1
          await finishEvent(row.id, "reconciled")
        } else {
          await finishEvent(row.id, "ignored", result.reason)
        }
      } else {
        await finishEvent(row.id, "ignored", `Entity ${row.entity_name} not handled`)
      }

      processed += 1
    } catch (eventError) {
      await finishEvent(row.id, "error", eventError instanceof Error ? eventError.message : "Webhook processing failed", row.attempts ?? 0)
      processed += 1
    }
  }

  logQBO("info", "process_webhooks_complete", { processed, reconciled, ignored, errored })
  return { processed, reconciled, ignored, errored }
}

async function checkedDatabase<T extends { error: { message: string } | null }>(query: PromiseLike<T>): Promise<T> {
  const result = await query
  if (result.error) throw new Error(`Accounting persistence failed: ${result.error.message}`)
  return result
}

export async function listQboInboundEventsForOrg(orgId: string, limit: number) {
  const supabase = createServiceSupabaseClient()
  const { data: connections } = await checkedDatabase(
    supabase.from("accounting_connections").select("id, external_account_id, status").eq("org_id", orgId).eq("provider", "qbo"),
  )
  if (!connections?.length) return []
  const connectionByRealm = new Map(connections.map((connection) => [String(connection.external_account_id), connection]))
  const { data: events } = await checkedDatabase(
    supabase
      .from("qbo_webhook_events")
      .select("id, realm_id, entity_name, entity_qbo_id, operation, process_error, received_at, processed_at")
      .in("realm_id", [...connectionByRealm.keys()])
      .in("process_status", ["error", "retry"])
      .order("received_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 200))),
  )
  return (events ?? []).map((event) => ({
    id: String(event.id),
    connectionId: String(connectionByRealm.get(String(event.realm_id))?.id),
    provider: "qbo" as const,
    entityName: event.entity_name,
    externalId: event.entity_qbo_id,
    operation: event.operation,
    error: event.process_error,
    receivedAt: event.received_at,
    processedAt: event.processed_at,
  }))
}

export async function retryQboInboundEventForOrg(orgId: string, eventId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: connections } = await checkedDatabase(
    supabase.from("accounting_connections").select("external_account_id").eq("org_id", orgId).eq("provider", "qbo").eq("status", "active"),
  )
  if (!connections?.length) throw new Error("An active QuickBooks connection is required")
  const { data } = await checkedDatabase(
    supabase
      .from("qbo_webhook_events")
      .update({ process_status: "pending", process_error: null, processed_at: null, attempts: 0, next_attempt_at: null })
      .eq("id", eventId)
      .in(
        "realm_id",
        connections.map((connection) => connection.external_account_id),
      )
      .in("process_status", ["error", "retry"])
      .select("id")
      .maybeSingle(),
  )
  if (!data) throw new Error("Inbound event is unavailable or no longer retryable")
  return { success: true as const }
}

export async function reconcileInvoiceFromQbo(params: Parameters<typeof applyReconcileInvoiceFromQbo>[0]) {
  return withInboundMappingGroup(params, "invoice", params.qboInvoiceId, () => applyReconcileInvoiceFromQbo(params))
}

async function reconcileProjectExpenseFromQbo(params: Parameters<typeof applyReconcileProjectExpenseFromQbo>[0]) {
  return withInboundMappingGroup(params, "project_expense", params.qboId, () => applyReconcileProjectExpenseFromQbo(params))
}

async function reconcileVendorBillFromQbo(params: Parameters<typeof applyReconcileVendorBillFromQbo>[0]) {
  return withInboundMappingGroup(params, "bill", params.qboId, () => applyReconcileVendorBillFromQbo(params))
}

async function reconcilePaymentFacts(params: Parameters<typeof applyReconcilePaymentFacts>[0]) {
  return withInboundMappingGroup(params, params.entityType, params.externalId, () => applyReconcilePaymentFacts(params))
}
