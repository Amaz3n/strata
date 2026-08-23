import { createHash } from "crypto"

import { accountingReference } from "@/lib/services/accounting-coding"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * "Did a person change the Arc record after we last synced it?"
 *
 * The previous answer was `entity.updated_at > entity.qbo_synced_at`, and it was
 * always yes. `qbo_synced_at` is a JS wall-clock string captured in the app
 * *before* the write; `updated_at` is stamped by the `tg_set_updated_at` trigger
 * (and by `replace_invoice_lines_atomic`) on the database clock *during* it. The
 * two are never the same clock and the DB one is always later by at least the
 * request latency, so the comparison read "Arc changed it" immediately after
 * every sync — which routed every genuine QuickBooks-side edit to `needs_review`
 * instead of reconciling it.
 *
 * The replacement compares content, not clocks: at each successful sync we hash
 * the Arc-side fields that the conflict check actually compares and store the
 * hash on the sync record. A later reconcile re-hashes the same fields; a
 * difference means a human moved one of them, and nothing else does. The
 * predicate is false immediately after a sync write by construction, because the
 * sync write does not touch any hashed field.
 *
 * When no hash has been recorded yet (every row predating this change, and any
 * entity type without a fingerprint definition) the answer is **no**. Absence of
 * evidence may not be manufactured into a conflict: the old predicate's constant
 * `true` carried no information at all, and the material-amount guards that
 * follow the both-sides check still stop QuickBooks from silently repricing an
 * approved expense or bill.
 */

type ServiceClient = ReturnType<typeof createServiceSupabaseClient>

/** Where the fingerprint lives inside `accounting_sync_records.metadata`. */
export const LOCAL_FINGERPRINT_KEY = "local_fingerprint"

/**
 * The Arc-side columns each entity's conflict check compares, and therefore the
 * exact surface the fingerprint has to cover. Keep this in step with the
 * `materiallyDiffers` / `amountsDiffer` expressions in
 * `lib/integrations/accounting/qbo/reconcile.ts`: a field compared but not
 * hashed makes the predicate miss a real edit, and a field hashed but not
 * compared makes it report an edit that could never conflict.
 */
type FingerprintConfig = {
  table: string
  /** Columns fetched to build the fingerprint (superset of what's hashed). */
  columns: readonly string[]
  /**
   * Canonical labeled values that get hashed, in order. The labels are part of
   * the hash input and must NEVER change: the counterparty/account identities
   * are resolved from `accounting_coding` FIRST and fall back to the legacy
   * `qbo_*` columns, which the dual-write keeps equal — so the hash stays
   * byte-identical today, and stays byte-identical the day the legacy columns
   * drop. (Hashing the legacy columns directly was the D2 landmine: the drop
   * would have flipped every fingerprint at once and routed the entire QBO
   * change feed to needs_review.)
   */
  material: (row: Record<string, unknown>) => Array<[string, unknown]>
}

const externalRefId = (row: Record<string, unknown>, codingKey: "counterparty" | "expense_account", legacyColumn: string) =>
  accountingReference(row.accounting_coding, codingKey)?.id ?? row[legacyColumn] ?? null

const FINGERPRINT_FIELDS: Record<string, FingerprintConfig> = {
  invoice: {
    table: "invoices",
    columns: ["subtotal_cents", "tax_cents", "total_cents", "balance_due_cents"],
    material: (row) => [
      ["subtotal_cents", row.subtotal_cents],
      ["tax_cents", row.tax_cents],
      ["total_cents", row.total_cents],
      ["balance_due_cents", row.balance_due_cents],
    ],
  },
  project_expense: {
    table: "project_expenses",
    columns: ["amount_cents", "tax_cents", "expense_date", "accounting_coding", "qbo_vendor_id", "qbo_expense_account_id"],
    material: (row) => [
      ["amount_cents", row.amount_cents],
      ["tax_cents", row.tax_cents],
      ["expense_date", row.expense_date],
      ["qbo_vendor_id", externalRefId(row, "counterparty", "qbo_vendor_id")],
      ["qbo_expense_account_id", externalRefId(row, "expense_account", "qbo_expense_account_id")],
    ],
  },
  bill: {
    table: "vendor_bills",
    columns: ["total_cents", "bill_date", "due_date", "accounting_coding", "qbo_vendor_id", "qbo_expense_account_id"],
    material: (row) => [
      ["total_cents", row.total_cents],
      ["bill_date", row.bill_date],
      ["due_date", row.due_date],
      ["qbo_vendor_id", externalRefId(row, "counterparty", "qbo_vendor_id")],
      ["qbo_expense_account_id", externalRefId(row, "expense_account", "qbo_expense_account_id")],
    ],
  },
  // Vendor credits live in vendor_bills; the push path writes this ledger type
  // (accounting-sync.ts resolveVendorBillLedgerContext), so without a definition
  // here the both-sides protection was silently off for credits.
  vendor_credit: {
    table: "vendor_bills",
    columns: ["total_cents", "bill_date", "due_date", "accounting_coding", "qbo_vendor_id", "qbo_expense_account_id"],
    material: (row) => [
      ["total_cents", row.total_cents],
      ["bill_date", row.bill_date],
      ["due_date", row.due_date],
      ["qbo_vendor_id", externalRefId(row, "counterparty", "qbo_vendor_id")],
      ["qbo_expense_account_id", externalRefId(row, "expense_account", "qbo_expense_account_id")],
    ],
  },
}

export function fingerprintedEntityTypes(): string[] {
  return Object.keys(FINGERPRINT_FIELDS)
}

function normalizeValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean") return value ? 1 : 0
  const text = String(value)
  return text.length > 0 ? text : null
}

/**
 * Hash of the conflict-relevant Arc values on one record. Pure: the same row
 * always produces the same string, and a row missing a configured column hashes
 * as if that column were null so a narrowed `select` cannot silently change the
 * answer for everyone.
 */
export function computeLocalFingerprint(entityType: string, row: Record<string, unknown> | null | undefined): string | null {
  const config = FINGERPRINT_FIELDS[entityType]
  if (!config || !row) return null
  const material = config.material(row).map(([label, value]) => [label, normalizeValue(value)])
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32)
}

/** The fingerprint recorded on a sync record, if one has ever been stamped. */
export function storedLocalFingerprint(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null
  const value = (metadata as Record<string, unknown>)[LOCAL_FINGERPRINT_KEY]
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * The predicate itself. False unless a recorded fingerprint proves the Arc row
 * moved — see the module comment for why "unknown" resolves to false.
 */
export function arcChangedSinceSync(input: { storedFingerprint: string | null; currentFingerprint: string | null }): boolean {
  if (!input.storedFingerprint || !input.currentFingerprint) return false
  return input.storedFingerprint !== input.currentFingerprint
}

/**
 * Record the Arc row's current fingerprint against its sync record.
 *
 * Called after every successful sync in either direction. Merges rather than
 * replaces `metadata`, because the create-claim RPC keeps its lease marker
 * there. Silent when there is no sync record or no fingerprint definition —
 * a missing fingerprint degrades to "no proven Arc change", never to a
 * fabricated conflict.
 */
export async function stampLocalFingerprint(params: {
  supabase: ServiceClient
  orgId: string
  connectionId: string
  entityType: string
  entityId: string
}): Promise<void> {
  const config = FINGERPRINT_FIELDS[params.entityType]
  if (!config) return

  const [entityResult, recordResult] = await Promise.all([
    params.supabase
      .from(config.table)
      .select(config.columns.join(","))
      .eq("org_id", params.orgId)
      .eq("id", params.entityId)
      .maybeSingle(),
    params.supabase
      .from("accounting_sync_records")
      .select("id, metadata")
      .eq("org_id", params.orgId)
      .eq("connection_id", params.connectionId)
      .eq("entity_type", params.entityType)
      .eq("entity_id", params.entityId)
      .maybeSingle(),
  ])

  const recordId = recordResult.data?.id
  if (!recordId) return
  const fingerprint = computeLocalFingerprint(params.entityType, entityResult.data as Record<string, unknown> | null)
  if (!fingerprint) return

  const existingMetadata = recordResult.data?.metadata
  const metadata = existingMetadata && typeof existingMetadata === "object" ? { ...(existingMetadata as Record<string, unknown>) } : {}
  metadata[LOCAL_FINGERPRINT_KEY] = fingerprint

  await params.supabase.from("accounting_sync_records").update({ metadata }).eq("id", recordId)
}
