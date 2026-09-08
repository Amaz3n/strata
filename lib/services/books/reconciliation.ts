import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireBooksAuthorization as requireAuthorization } from "@/lib/services/books/access"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { runLedgerTieOuts } from "@/lib/services/books/verifier"
import {
  classifyProjectionFailure,
  planReconciliationItemSync,
  planRetainageControlFindings,
  reconciliationRunStatus,
  PROJECTION_ITEM_CATEGORIES,
  type PersistedReconciliationItem,
  type ReconciliationFinding,
  type ReconciliationItemStatus,
} from "@/lib/services/books/reconciliation-rules"
import { buildReconciliationDigest, type ReconciliationDigest } from "@/lib/services/books/reconciliation-digest"
import { runProjectReconciliationChecks } from "@/lib/services/reports/reconciliation"
import type { OrgServiceContext } from "@/lib/services/context"

/**
 * The reconciliation spine.
 *
 * One nightly pass per ORG produces every accounting discrepancy in the product and
 * writes it to `accounting_reconciliation_items`. Everything else — the close
 * checklist, drift notifications, the cutover comparison — reads that table rather
 * than running its own comparison.
 *
 * Two things about the shape are deliberate:
 *
 * 1. **Keyed on the org, not the connection.** The previous sweep iterated
 *    `accounting_connections`, so an org with no external accounting system was never
 *    reconciled at all. That is backwards: an Arc-authoritative org may have no
 *    connection *by design*, and it is precisely the posture where Arc owns the ledger
 *    and most needs verifying. Connection health is now one category among many,
 *    attached to a connection when one exists.
 * 2. **It compares amounts.** The old sweep only checked connection health, sync-queue
 *    depth, and draft journals — a queue-drain monitor. The ledger tie-outs are the
 *    part that actually proves the books, and until now they ran only inside a
 *    human-triggered period close despite being written to run nightly.
 */

const PAGE_SIZE = 1000

const connectionSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  provider: z.string(),
  last_sync_at: z.string().nullable(),
  last_inbound_poll_at: z.string().nullable(),
  status: z.string(),
})

async function collectPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE
    const { data, error } = await loadPage(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }
}

const CONNECTION_STALE_AFTER_MS = 48 * 60 * 60 * 1000

/**
 * Connection states worth reconciling.
 *
 * `disconnected` is excluded because it is the one status a person chose: they
 * turned the connection off, or — before the Jul 2026 change that made re-auth
 * reuse the existing row — a reconnect left the superseded row behind. Either way
 * nobody intends to sync it again. Sweeping them reported the same dead rows as
 * unhealthy AND stale every night, four findings deep, drowning the ones a
 * bookkeeper can act on.
 *
 * `expired` and `error` stay in: those are connections the org still means to use
 * that have stopped working, and only a person re-authorizing can cure them.
 */
const RECONCILABLE_CONNECTION_STATUSES = ["active", "expired", "error"] as const

/**
 * Connection health and sync-queue depth, for orgs that talk to an external system.
 *
 * On staleness: `last_sync_at` moves only when an entity-level operation succeeds,
 * while inbound change polling records itself on `last_inbound_poll_at`. Reading the
 * first alone reported a live connection — polling every fifteen minutes, token
 * refreshed that morning — as stale through any quiet fortnight. Last contact is the
 * later of the two, and both are kept on the finding so the reader can tell "nothing
 * changed upstream" from "we stopped talking to it".
 */
async function collectConnectionItems(orgId: string): Promise<ReconciliationFinding[]> {
  const service = createServiceSupabaseClient()
  const { data: connectionRows, error: connectionError } = await service
    .from("accounting_connections")
    .select("id, org_id, provider, last_sync_at, last_inbound_poll_at, status")
    .eq("org_id", orgId)
    .in("status", [...RECONCILABLE_CONNECTION_STATUSES])
  if (connectionError) throw new Error(`Failed to load accounting connections: ${connectionError.message}`)

  const connections = z.array(connectionSchema).parse(connectionRows ?? [])
  if (connections.length === 0) return []

  const items: ReconciliationFinding[] = []
  for (const connection of connections) {
    if (connection.status !== "active") {
      items.push({
        category: "connection_unhealthy",
        entityType: "accounting_connection",
        entityId: connection.id,
        details: { status: connection.status, provider: connection.provider },
      })
      // A connection that cannot authenticate is trivially not syncing. Reporting
      // that second is a restatement of the first, not a second thing to fix.
      continue
    }
    const lastContactMs = Math.max(
      connection.last_sync_at ? new Date(connection.last_sync_at).getTime() : 0,
      connection.last_inbound_poll_at ? new Date(connection.last_inbound_poll_at).getTime() : 0,
    )
    if (!lastContactMs || Date.now() - lastContactMs > CONNECTION_STALE_AFTER_MS) {
      items.push({
        category: "connection_stale",
        entityType: "accounting_connection",
        entityId: connection.id,
        details: {
          last_sync_at: connection.last_sync_at,
          last_inbound_poll_at: connection.last_inbound_poll_at,
          provider: connection.provider,
        },
      })
    }
  }

  // Paged rather than capped: a silent truncation at 200 reported a clean queue for an
  // org whose backlog was the actual problem. The order is what makes paging
  // deterministic — `range()` without one can skip or repeat rows between pages — and
  // `id` breaks ties so the sort is total, not just mostly-total.
  //
  // Reconciliation keeps using the historical clocks (`created_at` for queued,
  // `last_synced_at` for delivered) because they describe its tie-out window.
  // Phase G's `updated_at` is the watchdog/current-state clock and is not a
  // substitute for either one here.
  const syncRecords = await collectPages(
    (from, to) => service
      .from("accounting_sync_records")
      .select("entity_type, entity_id, status, error_message, created_at, last_synced_at")
      .eq("org_id", orgId)
      .neq("status", "synced")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
    "accounting sync records",
  )
  for (const row of syncRecords) {
    items.push({
      category: row.status === "error" ? "sync_error" : "unreconciled_sync_record",
      entityType: row.entity_type ?? undefined,
      entityId: row.entity_id ?? undefined,
      details: {
        status: row.status,
        error: row.error_message,
        queued_at: row.created_at,
        last_synced_at: row.last_synced_at,
      },
    })
  }
  return items
}

/**
 * The seam between the payment rails and the general ledger.
 *
 * Arc Books derives the GL from `payments`, never from the rails subledger — posting
 * from both would double-count every rail payment (C2.1.2). That makes one thing
 * load-bearing: a disbursement the rails settled must have produced a `payments` row,
 * or the money moved and the ledger never heard about it. `record_ap_payment_atomic`
 * writes both in one transaction, so a gap here means that atomicity was bypassed or
 * failed part-way.
 *
 * Amounts are compared too: the rails and the books must agree on what left the bank.
 */
async function collectRailsItems(orgId: string): Promise<ReconciliationFinding[]> {
  const service = createServiceSupabaseClient()
  // `range()` without an order is not pagination — Postgres may return rows in any
  // order between pages, so a row can be skipped or read twice. `id` breaks ties so
  // the sort is total.
  const settled = await collectPages(
    (from, to) => service
      .from("disbursements")
      .select("id, bill_id, amount_cents, status")
      .eq("org_id", orgId)
      .eq("status", "paid")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
    "settled disbursements",
  )
  if (settled.length === 0) return []

  const payments = await collectPages(
    (from, to) => service
      .from("payments")
      .select("id, amount_cents, metadata")
      .eq("org_id", orgId)
      .not("metadata->>disbursement_id", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
    "rail payments",
  )
  const paymentByDisbursement = new Map<string, { id: string; amount_cents: number }>()
  for (const payment of payments) {
    const disbursementId = (payment.metadata as { disbursement_id?: unknown } | null)?.disbursement_id
    if (typeof disbursementId === "string") {
      paymentByDisbursement.set(disbursementId, { id: String(payment.id), amount_cents: Number(payment.amount_cents ?? 0) })
    }
  }

  const items: ReconciliationFinding[] = []
  for (const disbursement of settled) {
    const match = paymentByDisbursement.get(String(disbursement.id))
    const railsCents = Number(disbursement.amount_cents ?? 0)
    if (!match) {
      items.push({
        category: "rails_payment_missing_from_books",
        entityType: "disbursement",
        entityId: String(disbursement.id),
        localAmountCents: 0,
        externalAmountCents: railsCents,
        differenceCents: -railsCents,
        details: { bill_id: disbursement.bill_id, reason: "settled disbursement has no payments row" },
      })
      continue
    }
    if (match.amount_cents !== railsCents) {
      items.push({
        category: "rails_payment_amount_mismatch",
        entityType: "disbursement",
        entityId: String(disbursement.id),
        localAmountCents: match.amount_cents,
        externalAmountCents: railsCents,
        differenceCents: match.amount_cents - railsCents,
        details: { bill_id: disbursement.bill_id, payment_id: match.id },
      })
    }
  }
  return items
}

/**
 * How many projects one nightly pass will inspect.
 *
 * The project checks are the expensive part of the sweep — eight queries per project —
 * so an org with hundreds of active projects is bounded rather than allowed to run
 * unbounded overnight. When the cap bites, `checked_counts.projects_skipped` records it
 * so a truncated pass never reads as a clean one.
 */
const PROJECT_CHECK_CAP = 200

/** Bank accounts never reconciled, and posted transactions nobody has matched. */
async function collectBankItems(orgId: string, asOf: string): Promise<ReconciliationFinding[]> {
  const service = createServiceSupabaseClient()
  const [accounts, closedReconciliations, transactions] = await Promise.all([
    collectPages(
      (from, to) => service
        .from("bank_accounts")
        .select("id, name")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      "bank accounts",
    ),
    collectPages(
      (from, to) => service
        .from("bank_reconciliations")
        .select("bank_account_id")
        .eq("org_id", orgId)
        .eq("status", "closed")
        .lte("statement_end", asOf)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      "closed bank reconciliations",
    ),
    collectPages(
      (from, to) => service
        .from("bank_transactions")
        .select("id, transaction_date, bank_transaction_matches(status)")
        .eq("org_id", orgId)
        .eq("lifecycle_status", "posted")
        .eq("excluded", false)
        .lte("transaction_date", asOf)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      "bank transactions",
    ),
  ])

  const reconciled = new Set(closedReconciliations.map((row) => String(row.bank_account_id)))
  const items: ReconciliationFinding[] = []
  for (const account of accounts) {
    if (reconciled.has(String(account.id))) continue
    items.push({
      category: "bank_account_unreconciled",
      entityType: "bank_account",
      entityId: String(account.id),
      details: { name: account.name, as_of: asOf },
    })
  }
  for (const transaction of transactions) {
    const matches = Array.isArray(transaction.bank_transaction_matches) ? transaction.bank_transaction_matches : []
    if (matches.some((match: { status?: string }) => match.status === "confirmed")) continue
    items.push({
      category: "bank_transaction_unmatched",
      entityType: "bank_transaction",
      entityId: String(transaction.id),
      details: { transaction_date: transaction.transaction_date },
    })
  }
  return items
}

/**
 * The retainage control seam: what the pay applications withheld against what the
 * books carry. See `planRetainageControlFindings` for why they can disagree.
 */
async function collectRetainageControlItems(orgId: string): Promise<ReconciliationFinding[]> {
  const service = createServiceSupabaseClient()
  const [sovLines, heldRetainage] = await Promise.all([
    collectPages(
      (from, to) => service
        .from("prime_sov_lines")
        .select("contract_id, project_id, retainage_held_cents, retainage_released_cents")
        .eq("org_id", orgId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      "schedule-of-values retainage",
    ),
    collectPages(
      (from, to) => service
        .from("retainage")
        .select("contract_id, amount_cents")
        .eq("org_id", orgId)
        .eq("status", "held")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      "held retainage",
    ),
  ])
  return planRetainageControlFindings({ sovLines, heldRetainage })
}

/**
 * The eight project integrity checks, run across the org.
 *
 * These are the same functions the project reconciliation report calls — not a copy.
 * Each exception keeps its `href`, so an item persisted here still deep-links to the
 * screen that cures it.
 */
async function collectProjectItems(orgId: string) {
  const service = createServiceSupabaseClient()
  const projects = await collectPages(
    (from, to) => service
      .from("projects")
      .select("id, name")
      .eq("org_id", orgId)
      .in("status", ["active", "on_hold"])
      .order("id", { ascending: true })
      .range(from, to),
    "projects",
  )

  const inspected = projects.slice(0, PROJECT_CHECK_CAP)
  const items: ReconciliationFinding[] = []
  const failedChecks = new Set<string>()
  const ctx = { supabase: service, orgId } as OrgServiceContext

  for (let offset = 0; offset < inspected.length; offset += 5) {
    const batch = inspected.slice(offset, offset + 5)
    const results = await Promise.all(
      batch.map((project) => runProjectReconciliationChecks(ctx, String(project.id))),
    )
    for (const result of results) {
      for (const name of result.failedChecks) failedChecks.add(name)
      for (const exception of result.exceptions) {
        items.push({
          category: exception.kind,
          entityType: exception.source_type ?? "project",
          entityId: exception.source_id ?? exception.project_id,
          // One project can raise several exceptions of one kind against the same
          // record; the report's own id is what tells them apart.
          findingKey: exception.id,
          differenceCents: exception.amount_cents,
          details: {
            severity: exception.severity,
            project_id: exception.project_id,
            reference: exception.reference,
            description: exception.description,
            href: exception.href,
          },
        })
      }
    }
  }

  return {
    items,
    projectsInspected: inspected.length,
    projectsSkipped: Math.max(0, projects.length - inspected.length),
    failedChecks: Array.from(failedChecks),
  }
}

/** Unposted journals and the ledger tie-outs, for orgs running Arc Books. */
async function collectLedgerItems(orgId: string, asOf: string): Promise<ReconciliationFinding[]> {
  const service = createServiceSupabaseClient()
  const [drafts, tieOuts] = await Promise.all([
    collectPages(
      (from, to) => service
        .from("journal_entries")
        .select("id, posting_key, entry_date")
        .eq("org_id", orgId)
        .eq("status", "draft")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      "draft journal entries",
    ),
    runLedgerTieOuts(orgId, asOf),
  ])

  const items: ReconciliationFinding[] = drafts.map((row) => ({
    category: "unposted_journal",
    entityType: "journal_entry",
    entityId: row.id,
    details: { posting_key: row.posting_key, entry_date: row.entry_date },
  }))

  for (const tieOut of tieOuts) {
    if (tieOut.status !== "failed") continue
    items.push({
      category: `tie_out_${tieOut.code}`,
      localAmountCents: tieOut.ledgerCents,
      externalAmountCents: tieOut.subledgerCents,
      differenceCents: tieOut.differenceCents,
      details: { label: tieOut.label, as_of: asOf },
    })
  }
  return items
}

/** Statuses that mean "still in front of a person". Resolved items are history. */
const UNRESOLVED_ITEM_STATUSES = ["open", "explained", "ignored"] as const

function isProjectionCategory(category: string) {
  return PROJECTION_ITEM_CATEGORIES.some((value) => value === category)
}

const itemStatusSchema = z.enum(["open", "explained", "resolved", "ignored"])

/** The unresolved item set for one org, whichever run last observed each row. */
async function loadUnresolvedItems(orgId: string): Promise<PersistedReconciliationItem[]> {
  const service = createServiceSupabaseClient()
  const rows = await collectPages(
    (from, to) => service
      .from("accounting_reconciliation_items")
      .select("id, category, entity_type, entity_id, status, difference_cents, details")
      .eq("org_id", orgId)
      .in("status", [...UNRESOLVED_ITEM_STATUSES])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
    "unresolved reconciliation items",
  )
  return rows.map((row) => ({
    id: String(row.id),
    category: String(row.category),
    entityType: row.entity_type ? String(row.entity_type) : null,
    entityId: row.entity_id ? String(row.entity_id) : null,
    findingKey: (row.details as { finding_key?: unknown } | null)?.finding_key
      ? String((row.details as { finding_key: unknown }).finding_key)
      : null,
    status: itemStatusSchema.parse(row.status),
    differenceCents: row.difference_cents === null || row.difference_cents === undefined ? null : Number(row.difference_cents),
  }))
}

function itemRow(orgId: string, runId: string, finding: ReconciliationFinding, status: ReconciliationItemStatus) {
  return {
    org_id: orgId,
    run_id: runId,
    category: finding.category,
    entity_type: finding.entityType ?? null,
    entity_id: finding.entityId ?? null,
    local_amount_cents: finding.localAmountCents ?? null,
    external_amount_cents: finding.externalAmountCents ?? null,
    difference_cents: finding.differenceCents ?? null,
    status,
    details: finding.findingKey ? { ...finding.details, finding_key: finding.findingKey } : finding.details,
    updated_at: new Date().toISOString(),
  }
}

const WRITE_CHUNK = 500

function chunk<T>(rows: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size))
  return chunks
}

/**
 * Apply one sweep's findings to the persisted item set.
 *
 * Three statements, not one per row: the carried-forward rows go through `upsert`
 * on the primary key, so a 400-lot org's nightly pass costs the same as a small
 * one's.
 */
async function applyReconciliationSync(args: {
  orgId: string
  runId: string
  findings: ReconciliationFinding[]
  ownsCategory: (category: string) => boolean
  existing: PersistedReconciliationItem[]
}) {
  const service = createServiceSupabaseClient()
  const plan = planReconciliationItemSync({
    findings: args.findings,
    existing: args.existing,
    ownsCategory: args.ownsCategory,
  })

  // Reopened rows are written separately, not because they are special but because
  // PostgREST rejects a bulk upsert whose objects do not all carry the same keys —
  // only these clear the disposition columns.
  const carriedForward = plan.carryForward.filter((row) => !row.reopened)
  const reopened = plan.carryForward.filter((row) => row.reopened)

  for (const rows of chunk(carriedForward, WRITE_CHUNK)) {
    const { error } = await service
      .from("accounting_reconciliation_items")
      .upsert(rows.map((row) => ({ id: row.id, ...itemRow(args.orgId, args.runId, row.finding, row.status) })))
    if (error) throw new Error(`Failed to carry reconciliation items forward: ${error.message}`)
  }

  for (const rows of chunk(reopened, WRITE_CHUNK)) {
    const { error } = await service
      .from("accounting_reconciliation_items")
      .upsert(
        // A reopened item is no longer disposed of; the `explanation` stays as the
        // record of what somebody once accepted, and at what amount.
        rows.map((row) => ({
          id: row.id,
          ...itemRow(args.orgId, args.runId, row.finding, row.status),
          resolved_at: null,
          resolved_by: null,
        })),
      )
    if (error) throw new Error(`Failed to reopen reconciliation items: ${error.message}`)
  }

  for (const rows of chunk(plan.insert, WRITE_CHUNK)) {
    const { error } = await service
      .from("accounting_reconciliation_items")
      .insert(rows.map((finding) => itemRow(args.orgId, args.runId, finding, "open")))
    if (error) throw new Error(`Failed to record reconciliation items: ${error.message}`)
  }

  for (const ids of chunk(plan.resolveIds, WRITE_CHUNK)) {
    // `resolved_by` stays null on purpose: that is what says the sweep closed this,
    // not a person. Any `explanation` a human left is preserved.
    const { error } = await service
      .from("accounting_reconciliation_items")
      .update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_by: null })
      .eq("org_id", args.orgId)
      .in("id", ids)
    if (error) throw new Error(`Failed to resolve cured reconciliation items: ${error.message}`)
  }

  return plan
}

/** Today's run for an org: the existing row if there is one, otherwise a new one. */
async function ensureReconciliationRunForDay(orgId: string, runDate: string) {
  const service = createServiceSupabaseClient()
  const { data: existingRun, error: existingError } = await service
    .from("accounting_reconciliation_runs")
    .select("id")
    .eq("org_id", orgId)
    .eq("run_date", runDate)
    .maybeSingle()
  if (existingError) throw new Error(`Failed to look up today's reconciliation run: ${existingError.message}`)
  if (existingRun?.id) return { runId: String(existingRun.id), created: false }
  const { data: runData, error: runError } = await service
    .from("accounting_reconciliation_runs")
    .insert({ org_id: orgId, run_date: runDate, status: "running", checked_counts: {} })
    .select("id")
    .single()
  if (runError) throw new Error(`Failed to start accounting reconciliation: ${runError.message}`)
  return { runId: z.object({ id: z.string().uuid() }).parse(runData).id, created: true }
}

/** The spine's own run: today's row, restarted, so one day means one run. */
async function startReconciliationRun(orgId: string, runDate: string) {
  const run = await ensureReconciliationRunForDay(orgId, runDate)
  if (!run.created) {
    const service = createServiceSupabaseClient()
    const { error: resetError } = await service
      .from("accounting_reconciliation_runs")
      .update({ status: "running", error_message: null, completed_at: null })
      .eq("org_id", orgId)
      .eq("id", run.runId)
    if (resetError) throw new Error(`Failed to restart reconciliation run: ${resetError.message}`)
  }
  return run.runId
}

/**
 * Reconcile one org for one day.
 *
 * Re-running on the same day reuses that day's run rather than inserting a second
 * one. Items are not rewritten from scratch each pass: they carry an identity and a
 * lifecycle (see `planReconciliationItemSync`), which is what lets the close gate
 * read the current state of the books rather than every discrepancy ever observed.
 */
export async function runOrgReconciliation(orgId: string) {
  const service = createServiceSupabaseClient()
  const runDate = new Date().toISOString().slice(0, 10)
  const runId = await startReconciliationRun(orgId, runDate)

  try {
    const { data: settings, error: settingsError } = await service
      .from("books_settings")
      .select("workspace_enabled")
      .eq("org_id", orgId)
      .maybeSingle()
    if (settingsError) throw new Error(`Failed to load Books settings: ${settingsError.message}`)
    const booksEnabled = settings?.workspace_enabled === true

    // The project integrity checks apply to every org — they reconcile operational
    // records against each other and need no general ledger. Only the tie-outs and
    // bank checks require Arc Books.
    const [connectionItems, ledgerItems, bankItems, railsItems, retainageItems, projectResult, existing] = await Promise.all([
      collectConnectionItems(orgId),
      booksEnabled ? collectLedgerItems(orgId, runDate) : Promise.resolve<ReconciliationFinding[]>([]),
      booksEnabled ? collectBankItems(orgId, runDate) : Promise.resolve<ReconciliationFinding[]>([]),
      // Runs regardless of Books: a settled disbursement with no `payments` row is a
      // hole in the operational record, not just in the ledger.
      collectRailsItems(orgId),
      collectRetainageControlItems(orgId),
      collectProjectItems(orgId),
      loadUnresolvedItems(orgId),
    ])
    const items = [
      ...connectionItems,
      ...ledgerItems,
      ...bankItems,
      ...railsItems,
      ...retainageItems,
      ...projectResult.items,
    ]

    // The projection repair sweep owns its own categories; this pass cannot
    // reproduce them and must not close them.
    const ownsCategory = (category: string) => !isProjectionCategory(category)
    const plan = await applyReconciliationSync({ orgId, runId, findings: items, ownsCategory, existing })

    const status = reconciliationRunStatus({
      itemCount: items.length,
      projectsSkipped: projectResult.projectsSkipped,
    })
    const { error: completeError } = await service
      .from("accounting_reconciliation_runs")
      .update({
        status,
        checked_counts: {
          connection_items: connectionItems.length,
          ledger_items: ledgerItems.length,
          bank_items: bankItems.length,
          rails_items: railsItems.length,
          retainage_items: retainageItems.length,
          project_items: projectResult.items.length,
          projects_inspected: projectResult.projectsInspected,
          // Non-zero means the sweep was truncated: this pass is not a clean bill of
          // health for the org, only for the projects it reached, and the run status
          // above says `warning` because of it.
          projects_skipped: projectResult.projectsSkipped,
          scan_capped: projectResult.projectsSkipped > 0,
          failed_checks: projectResult.failedChecks,
          books_enabled: booksEnabled,
          resolved_items: plan.resolveIds.length,
        },
        discrepancy_count: items.length,
        completed_at: new Date().toISOString(),
      })
      .eq("org_id", orgId)
      .eq("id", runId)
    if (completeError) throw new Error(completeError.message)

    if (plan.newFindingCount > 0) {
      await recordEvent({
        orgId,
        eventType: "accounting_reconciliation_drift",
        entityType: "accounting_reconciliation_run",
        entityId: runId,
        payload: {
          message: `${plan.newFindingCount} new accounting reconciliation issue${plan.newFindingCount === 1 ? "" : "s"}`,
          discrepancy_count: items.length,
          new_discrepancy_count: plan.newFindingCount,
        },
        channel: "notification",
      })
    }
    return {
      runId,
      status,
      discrepancyCount: items.length,
      newDiscrepancyCount: plan.newFindingCount,
      resolvedCount: plan.resolveIds.length,
    }
  } catch (error) {
    await service
      .from("accounting_reconciliation_runs")
      .update({
        status: "failed",
        error_message: error instanceof Error ? error.message : String(error),
        completed_at: new Date().toISOString(),
      })
      .eq("org_id", orgId)
      .eq("id", runId)
    throw error
  }
}

/**
 * Run the reconciliation spine for the current org, on demand.
 *
 * The nightly cron is the normal path; this exists because a person who has just
 * cured a discrepancy should not have to wait until 04:45 UTC to see the checklist
 * go green — the item they cured is resolved by this pass. Same implementation,
 * same per-day run reuse.
 */
export async function runReconciliationNow(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "books.reconcile",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "accounting_reconciliation_run",
    resourceId: context.orgId,
    logDecision: true,
  })
  return runOrgReconciliation(context.orgId)
}

/**
 * A person's disposition of one reconciliation item.
 *
 * The sweep can only close what it can no longer reproduce. A known and accepted
 * difference — a rounding gap the CPA has signed off on, a stale connection nobody
 * intends to reconnect — needs a human to say so, and `resolved_by` records who.
 *
 * `explained` and `ignored` survive the nightly pass; the sweep reopens an
 * explained item only when the amount changes, because the number somebody
 * accepted is no longer the number in front of them.
 */
export async function resolveReconciliationItem(input: {
  itemId: string
  disposition: "resolved" | "explained" | "ignored"
  explanation?: string
  orgId?: string
}) {
  const context = await requireOrgContext(input.orgId)
  await requireAuthorization({
    permission: "books.reconcile",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "accounting_reconciliation_item",
    resourceId: input.itemId,
    logDecision: true,
  })
  const explanation = input.explanation?.trim() ?? ""
  if (input.disposition !== "resolved" && explanation.length < 10) {
    throw new Error("Accepting a difference requires an explanation")
  }

  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("accounting_reconciliation_items")
    .update({
      status: input.disposition,
      explanation: explanation.length > 0 ? explanation : null,
      resolved_by: context.userId,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", context.orgId)
    .eq("id", input.itemId)
    .select("id, category, status, difference_cents")
    .single()
  if (error) throw new Error(`Failed to update the reconciliation item: ${error.message}`)

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "accounting_reconciliation_item_resolved",
      entityType: "accounting_reconciliation_item",
      entityId: input.itemId,
      payload: { category: data.category, disposition: input.disposition },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "accounting_reconciliation_item",
      entityId: input.itemId,
      after: { status: input.disposition, explanation: explanation || null },
      source: "books.reconcile",
    }),
  ])
  return { itemId: input.itemId, status: input.disposition }
}

/**
 * Projection failures, as reconciliation items.
 *
 * The nightly repair sweep re-runs the projector over every source record. A
 * failure there used to live only in the JSON body of a cron response nobody
 * reads, and the worst of them repeats forever: the DB guard rightly refuses to
 * reverse a journal entry in a closed period, so a bill edited after its period
 * closed fails on every pass until a person posts an adjusting entry or reopens
 * the period. Neither retrying nor swallowing it is a cure, so it becomes an item
 * with an owner and a lifecycle like any other finding.
 *
 * This sweep owns exactly `PROJECTION_ITEM_CATEGORIES`, so a source that starts
 * projecting again has its item resolved here, and the reconciliation spine — which
 * cannot reproduce these — leaves them alone.
 */
export async function recordProjectionFailures(
  results: Array<{ orgId: string; failures: Array<{ sourceType: string; sourceId: string; error: string }> }>,
) {
  const runDate = new Date().toISOString().slice(0, 10)
  const ownsCategory = (category: string) => isProjectionCategory(category)
  let opened = 0
  let resolved = 0

  for (const result of results) {
    const findings: ReconciliationFinding[] = result.failures.map((failure) => ({
      category: classifyProjectionFailure(failure.error),
      entityType: failure.sourceType,
      entityId: failure.sourceId,
      details: {
        severity: "critical",
        error: failure.error,
        cure:
          classifyProjectionFailure(failure.error) === "projection_blocked_by_closed_period"
            ? "The source record changed after its accounting period closed. Post an adjusting entry, or reopen the period, then re-run the projection."
            : "Re-run the Books projection after correcting the source record.",
        href: "/books/close",
      },
    }))
    const existing = (await loadUnresolvedItems(result.orgId)).filter((item) => ownsCategory(item.category))
    if (findings.length === 0 && existing.length === 0) continue

    // Attaches to the day's run if the spine has already made one, and never
    // rewrites it: that row is the spine's account of what IT looked at, and
    // resetting it would erase the org's reconciliation state for the day.
    const run = await ensureReconciliationRunForDay(result.orgId, runDate)
    const plan = await applyReconciliationSync({
      orgId: result.orgId,
      runId: run.runId,
      findings,
      ownsCategory,
      existing,
    })
    opened += plan.newFindingCount
    resolved += plan.resolveIds.length

    if (run.created) {
      // Nothing has swept this org today, so this pass is the run. Leaving the row
      // `running` would read as a sweep still in flight rather than one that
      // observed something, and its counts say exactly what it looked at.
      const service = createServiceSupabaseClient()
      const { error } = await service
        .from("accounting_reconciliation_runs")
        .update({
          status: findings.length === 0 ? "passed" : "warning",
          checked_counts: { source: "books_maintenance", projection_failures: findings.length },
          discrepancy_count: findings.length,
          completed_at: new Date().toISOString(),
        })
        .eq("org_id", result.orgId)
        .eq("id", run.runId)
      if (error) throw new Error(`Failed to complete the projection reconciliation run: ${error.message}`)
    }

    if (plan.newFindingCount > 0) {
      await recordEvent({
        orgId: result.orgId,
        eventType: "accounting_reconciliation_drift",
        entityType: "accounting_reconciliation_run",
        entityId: run.runId,
        payload: {
          message: `${plan.newFindingCount} source record${plan.newFindingCount === 1 ? "" : "s"} cannot be projected into the ledger`,
          discrepancy_count: findings.length,
          new_discrepancy_count: plan.newFindingCount,
        },
        channel: "notification",
      })
    }
  }
  return { opened, resolved }
}

/**
 * The item set one run left behind, shaped for the drift notification.
 *
 * Read with the service client on purpose: the only caller is the outbox worker,
 * which has no user session. Recipient selection already happened upstream — the
 * event fan-out mails only holders of `books.reconcile` — so this is a render
 * step, not an access decision.
 */
export async function loadReconciliationDigest(args: {
  orgId: string
  runId: string
  newCount: number
  topItemLimit?: number
}): Promise<ReconciliationDigest | null> {
  const service = createServiceSupabaseClient()
  const { data: run, error: runError } = await service
    .from("accounting_reconciliation_runs")
    .select("checked_counts")
    .eq("org_id", args.orgId)
    .eq("id", args.runId)
    .maybeSingle()
  if (runError) throw new Error(`Failed to load the reconciliation run: ${runError.message}`)
  if (!run) return null

  const counts = (run.checked_counts ?? {}) as Record<string, unknown>
  const rows = await collectPages(
    (from, to) => service
      .from("accounting_reconciliation_items")
      .select("category, entity_type, difference_cents, status, details")
      .eq("org_id", args.orgId)
      .eq("run_id", args.runId)
      .in("status", ["open", "explained"])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
    "reconciliation digest items",
  )

  // Only the findings that survive into the email need a readable project name,
  // so the lookup is scoped to those rather than to every project in the org.
  const digestRows = rows.map((row) => ({
    category: String(row.category),
    entityType: row.entity_type ? String(row.entity_type) : null,
    differenceCents:
      row.difference_cents === null || row.difference_cents === undefined ? null : Number(row.difference_cents),
    status: String(row.status),
    details: (row.details ?? null) as Record<string, unknown> | null,
  }))
  const projectIds = Array.from(
    new Set(
      digestRows
        .map((row) => row.details?.project_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  )
  const projectNames: Record<string, string> = {}
  if (projectIds.length > 0) {
    const { data: projects } = await service
      .from("projects")
      .select("id, name")
      .eq("org_id", args.orgId)
      .in("id", projectIds)
    for (const project of projects ?? []) projectNames[String(project.id)] = String(project.name)
  }

  return buildReconciliationDigest({
    rows: digestRows,
    newCount: args.newCount,
    resolvedCount: typeof counts.resolved_items === "number" ? counts.resolved_items : 0,
    projectNames,
    projectsSkipped: typeof counts.projects_skipped === "number" ? counts.projects_skipped : 0,
    failedChecks: Array.isArray(counts.failed_checks) ? counts.failed_checks.map(String) : [],
    booksEnabled: counts.books_enabled !== false,
    topItemLimit: args.topItemLimit,
  })
}

export async function runNightlyAccountingReconciliation() {
  const service = createServiceSupabaseClient()
  const [connectionOrgs, booksOrgs] = await Promise.all([
    collectPages(
      (from, to) => service
        .from("accounting_connections")
        .select("org_id")
        .eq("status", "active")
        .order("org_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      "orgs with an accounting connection",
    ),
    collectPages(
      (from, to) => service
        .from("books_settings")
        .select("org_id")
        .eq("workspace_enabled", true)
        .order("org_id", { ascending: true })
        .range(from, to),
      "orgs running Arc Books",
    ),
  ])

  // Either posture earns reconciliation: an external-authoritative org has a connection
  // to verify against, an Arc-authoritative org has a ledger of its own to prove.
  const orgIds = Array.from(
    new Set([...connectionOrgs, ...booksOrgs].map((row) => String(row.org_id)).filter(Boolean)),
  ).sort()

  const failures: Array<{ orgId: string; error: string }> = []
  let completed = 0
  for (let offset = 0; offset < orgIds.length; offset += 10) {
    const batch = orgIds.slice(offset, offset + 10)
    const results = await Promise.allSettled(batch.map((orgId) => runOrgReconciliation(orgId)))
    results.forEach((result, index) => {
      if (result.status === "fulfilled") completed += 1
      else
        failures.push({
          orgId: batch[index],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
    })
  }
  return { attempted: orgIds.length, completed, failures }
}
