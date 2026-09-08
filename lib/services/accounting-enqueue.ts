import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type AccountingPushEntityType = "invoice" | "payment" | "project_expense" | "vendor_bill" | "bill_payment"
export type AccountingSyncLedgerEntityType = AccountingPushEntityType | "bill" | "vendor_credit"

export type AccountingEnqueueBlockReason =
  | "connection_unhealthy"
  | "disabled"
  | "inbound_only"
  | "no_target"
  | "connection_mismatch"
  | "cutover_freeze"

export type AccountingEnqueueResult =
  | { queued: true; reason: "enqueued" | "duplicate"; recordId: string }
  | { queued: false; reason: AccountingEnqueueBlockReason | "books_authoritative" | "error"; recordId?: string }

export const ACCOUNTING_PUSH_CONFIG: Record<
  AccountingPushEntityType,
  { payloadKey: "invoice_id" | "payment_id" | "expense_id" | "bill_id"; jobType: string; paymentSetting: boolean }
> = {
  invoice: { payloadKey: "invoice_id", jobType: "accounting_push_invoice", paymentSetting: false },
  payment: { payloadKey: "payment_id", jobType: "accounting_push_payment", paymentSetting: true },
  project_expense: { payloadKey: "expense_id", jobType: "accounting_push_project_expense", paymentSetting: false },
  vendor_bill: { payloadKey: "bill_id", jobType: "accounting_push_vendor_bill", paymentSetting: false },
  bill_payment: { payloadKey: "payment_id", jobType: "accounting_push_bill_payment", paymentSetting: true },
}

export function accountingPushTypeForLedgerType(entityType: string): AccountingPushEntityType | null {
  if (entityType === "bill" || entityType === "vendor_credit") return "vendor_bill"
  switch (entityType) {
    case "invoice":
    case "payment":
    case "project_expense":
    case "vendor_bill":
    case "bill_payment":
      return entityType
    default:
      return null
  }
}

export const ACCOUNTING_ENQUEUE_REASON_MESSAGES: Record<AccountingEnqueueBlockReason, string> = {
  connection_unhealthy: "The accounting connection needs to be reconnected before this transaction can sync.",
  disabled: "Automatic sync is disabled for this accounting connection.",
  inbound_only: "This record came from the accounting system and cannot be pushed back automatically.",
  no_target: "No accounting connection is mapped to this transaction.",
  connection_mismatch: "The transaction belongs to a different accounting connection than the one now mapped.",
  cutover_freeze: "Held by an accounting cutover freeze. It will not post until the freeze is lifted.",
}

type AtomicEnqueueRow = {
  record_id: string
  outbox_id: number | null
  enqueued: boolean
  duplicate: boolean
}

/**
 * Persist one enqueue decision. The RPC owns the transaction boundary between
 * current sync state and the outbox job, so neither row can exist without the
 * other after a successful queued decision.
 */
export async function persistAccountingEnqueueDecision(input: {
  orgId: string
  connectionId: string | null
  provider: string | null
  pushType: AccountingPushEntityType
  ledgerType: string
  entityId: string
  blockedReason?: AccountingEnqueueBlockReason | null
}): Promise<AccountingEnqueueResult> {
  const config = ACCOUNTING_PUSH_CONFIG[input.pushType]
  const blockedReason = input.blockedReason ?? null
  const payload = { [config.payloadKey]: input.entityId, connection_id: input.connectionId, provider: input.provider }
  const dedupeKey = `${config.jobType}:${config.payloadKey}:${input.entityId}`
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("enqueue_accounting_sync_atomic", {
    p_org_id: input.orgId,
    p_connection_id: input.connectionId,
    p_provider: input.provider,
    p_entity_type: input.ledgerType,
    p_entity_id: input.entityId,
    p_status: blockedReason ? "needs_review" : "pending",
    p_status_reason: blockedReason,
    p_error_message: blockedReason ? ACCOUNTING_ENQUEUE_REASON_MESSAGES[blockedReason] : null,
    p_job_type: blockedReason ? null : config.jobType,
    p_payload: blockedReason ? null : payload,
    p_dedupe_key: blockedReason ? null : dedupeKey,
  })
  if (error) throw new Error(`Unable to persist accounting sync intent: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as AtomicEnqueueRow | null
  if (!row?.record_id) throw new Error("Accounting enqueue did not return a sync record")
  if (blockedReason) return { queued: false, reason: blockedReason, recordId: row.record_id }
  return {
    queued: true,
    reason: row.duplicate ? "duplicate" : "enqueued",
    recordId: row.record_id,
  }
}

/**
 * Revive only work stranded by connection health. Other needs-review reasons
 * require a person and must not silently start moving after reconnect.
 */
export async function requeueAccountingSyncAfterReconnect(input: {
  orgId: string
  connectionId: string
}): Promise<{ found: number; queued: number; failed: number }> {
  const supabase = createServiceSupabaseClient()
  const { data: connection, error: connectionError } = await supabase
    .from("accounting_connections")
    .select("provider,status")
    .eq("org_id", input.orgId)
    .eq("id", input.connectionId)
    .maybeSingle()
  if (connectionError) throw new Error(`Unable to inspect reconnected accounting target: ${connectionError.message}`)
  if (!connection || connection.status !== "active") return { found: 0, queued: 0, failed: 0 }

  const records: Array<{ entity_type: string; entity_id: string }> = []
  const pageSize = 200
  for (let from = 0; ; from += pageSize) {
    const { data: page, error: recordsError } = await supabase
      .from("accounting_sync_records")
      .select("entity_type,entity_id")
      .eq("org_id", input.orgId)
      .eq("connection_id", input.connectionId)
      .eq("status", "needs_review")
      .eq("status_reason", "connection_unhealthy")
      .order("entity_id", { ascending: true })
      .range(from, from + pageSize - 1)
    if (recordsError) throw new Error(`Unable to load accounting reconnect backlog: ${recordsError.message}`)
    records.push(...(page ?? []))
    if ((page ?? []).length < pageSize) break
  }

  let queued = 0
  let failed = 0
  for (const record of records) {
    const pushType = accountingPushTypeForLedgerType(record.entity_type)
    if (!pushType) {
      failed += 1
      continue
    }
    try {
      await persistAccountingEnqueueDecision({
        orgId: input.orgId,
        connectionId: input.connectionId,
        provider: connection.provider,
        pushType,
        ledgerType: record.entity_type,
        entityId: record.entity_id,
      })
      queued += 1
    } catch {
      failed += 1
    }
  }
  return { found: records.length, queued, failed }
}
