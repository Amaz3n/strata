import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { BILLED_INVOICE_STATUSES, PAYABLE_VENDOR_BILL_STATUSES } from "@/lib/financials/ledger-status"
import {
  draftFromFact,
  factSourceKey,
  hashableFactPayload,
  retiredFactKind,
  retirementFactPayload,
  selectFactsToRetire,
  sortFactCostLines,
  type FactCostLine,
} from "@/lib/services/books/fact-drafts"
import { booksDigest } from "@/lib/services/books/hash"
import { postBooksJournalEntryForService, reverseBooksJournalEntryForService } from "@/lib/services/books/ledger"
import { classifyPaymentPosting } from "@/lib/services/books/posting-rules"
import { loadRevenueBasisByProject } from "@/lib/services/books/revenue-basis"
import { recordEvent } from "@/lib/services/events"
import { isoDateOnlyFromUtcMs } from "@/lib/services/reports/dates"
import { loadInvoiceRetainageCents, loadRetainageReleaseInvoiceCents } from "@/lib/services/retainage"

/**
 * The projector reads Arc's own records and emits balanced journal entries. It
 * never mutates a source record, and re-projection from zero must always
 * reproduce the same ledger — that is the correctness escape hatch.
 *
 * Four invariants earn their keep here:
 *  - The hashed payload holds ONLY economic fields, and every array inside it is
 *    sorted. Lifecycle columns such as `status` and `updated_at` move constantly
 *    and must never look like a revision; neither must the order Postgres
 *    happened to return subledger rows in.
 *  - A genuine economic revision supersedes the prior fact, reverses the entry
 *    it produced, and posts a replacement on the same pass.
 *  - A source that LEAVES the projectable set is retired: its entry is reversed
 *    and a retirement fact stops it being posted again. Enumerating only what
 *    currently qualifies is not enough — a voided invoice simply vanishes from
 *    the candidate set and would leave its journal entry standing forever.
 *  - Job cost is derived from the `job_cost_entries` subledger, not from bill
 *    headers, so the GL ties to the subledger by construction rather than by
 *    a reconciliation run after the fact.
 */

const PROJECTION_PAGE_SIZE = 500

/**
 * A hard bound on any one paged read. `collectPages` runs until it sees a short
 * page, which is correct but unbounded; a runaway query would otherwise consume
 * the whole job's memory and die without saying why. Reaching this is a loud
 * failure, never a silent truncation.
 */
const PROJECTION_MAX_ROWS = 250_000

/** Source types the projector owns end to end, and may therefore retire. */
const PROJECTED_SOURCE_TYPES = [
  "vendor_bill",
  "invoice",
  "retainage_release",
  "bill_payment",
  "invoice_payment",
  "expense",
  "payment_reversal",
  "labor_cost",
] as const

const RETIREMENT_REASON = "source no longer qualifies for projection"

type ProjectionCandidate = {
  sourceType: string
  sourceId: string
  accountingDate: string
  occurredAt: string
  payload: Record<string, unknown>
}

type ProjectionFailure = { sourceType: string; sourceId: string; error: string }

/**
 * Reads every page of a query.
 *
 * The loader MUST impose a total order. PostgREST resolves `.range()` as
 * `limit/offset` over whatever order the planner chose, so an unordered paged
 * read can hand back the same row twice and skip another entirely — which in a
 * ledger means a bill posted twice and a bill never posted at all.
 */
async function collectPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; ; page += 1) {
    const from = page * PROJECTION_PAGE_SIZE
    const { data, error } = await loadPage(from, from + PROJECTION_PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PROJECTION_PAGE_SIZE) return rows
    if (rows.length >= PROJECTION_MAX_ROWS) {
      throw new Error(`Refusing to project a truncated read: ${label} exceeded ${PROJECTION_MAX_ROWS} rows`)
    }
  }
}

/**
 * The accounting date of a timestamp column.
 *
 * Slicing the first ten characters off the stored string dates the row by
 * whatever offset PostgREST rendered it in, so an evening payment lands in the
 * wrong day and, at a month end, the wrong period. Every other accounting date
 * in Arc is a UTC-anchored date-only value (`lib/services/reports/dates.ts` —
 * `todayIsoDateOnly`, period bounds, aging as-of), so this resolves to the same
 * convention rather than inventing a second one.
 */
function accountingDateFromTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? isoDateOnlyFromUtcMs(ms) : null
}

/**
 * Incremental watermark. Facts store the source row's `updated_at` as
 * `occurred_at`, so the newest fact is a true high-water mark and no extra
 * column is needed. A full pass ignores it and rescans everything, which is how
 * a backfill from zero and the nightly repair sweep both run.
 */
async function resolveWatermark(orgId: string) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("accounting_facts")
    .select("occurred_at")
    .eq("org_id", orgId)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to resolve the projection watermark: ${error.message}`)
  return data?.occurred_at ? String(data.occurred_at) : null
}

/**
 * Job cost per bill, from the subledger.
 *
 * `job_cost_entries.source_id` for a `vendor_bill_line` row is the BILL LINE id,
 * so the mapping to a bill runs through `bill_lines`. A line can also be
 * allocated to a different project than its bill's primary project, which is
 * exactly the detail the GL loses when it posts from bill headers.
 */
async function loadBillCostLines(orgId: string) {
  const service = createServiceSupabaseClient()
  const [entries, billLines, accounts] = await Promise.all([
    collectPages(
      (from, to) => service
        .from("job_cost_entries")
        .select("source_id, project_id, cost_cents")
        .eq("org_id", orgId)
        .eq("status", "posted")
        .eq("source_type", "vendor_bill_line")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
      "job cost entries",
    ),
    collectPages(
      // `bill_lines` has no `created_at`; its primary key is the whole total order.
      (from, to) => service.from("bill_lines").select("id, bill_id, description, metadata").eq("org_id", orgId).order("id", { ascending: true }).range(from, to),
      "bill lines",
    ),
    collectPages(
      (from, to) => service
        .from("gl_accounts")
        .select("id,code")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("id", { ascending: true })
        .range(from, to),
      "Arc Books accounts",
    ),
  ])
  const accountCodeById = new Map(
    accounts.map((account) => [String(account.id), String(account.code)]),
  )
  const billByLine = new Map(billLines.map((row) => {
    const metadata = row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : {}
    const selectedAccountId = typeof metadata.qbo_expense_account_id === "string"
      ? metadata.qbo_expense_account_id
      : null
    return [String(row.id), {
      billId: String(row.bill_id),
      description: row.description ? String(row.description) : undefined,
      accountCode: selectedAccountId ? accountCodeById.get(selectedAccountId) : undefined,
    }]
  }))
  const byBill = new Map<string, FactCostLine[]>()
  for (const row of entries) {
    const link = billByLine.get(String(row.source_id))
    if (!link) continue
    const list = byBill.get(link.billId) ?? []
    list.push({
      amount_cents: Number(row.cost_cents ?? 0),
      project_id: row.project_id ? String(row.project_id) : null,
      description: link.description,
      account_code: link.accountCode,
    })
    byBill.set(link.billId, list)
  }
  // Sorted on the way out, not merely read in order: the hash must depend on the
  // set of cost lines and never on how they were paged.
  for (const [billId, list] of byBill) byBill.set(billId, sortFactCostLines(list))
  return byBill
}

/**
 * Field labor from the time subledger. Time entries have no other route into the
 * GL, so without this the job-cost tie-out can never balance.
 */
async function loadLaborCostEntries(orgId: string, since: string | null) {
  const service = createServiceSupabaseClient()
  return collectPages(
    (from, to) => {
      let query = service
        .from("job_cost_entries")
        .select("id, project_id, cost_cents, incurred_on, updated_at")
        .eq("org_id", orgId)
        .eq("status", "posted")
        .eq("source_type", "time_entry")
      if (since) query = query.gte("updated_at", since)
      return query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to)
    },
    "labor job cost entries",
  )
}

async function projectionCandidates(orgId: string, since: string | null) {
  const service = createServiceSupabaseClient()
  const [basisByProject, costLinesByBill, laborEntries, retainageByInvoice, releaseByInvoice, bills, invoices, payments, expenses, reversals] = await Promise.all([
    loadRevenueBasisByProject(orgId),
    loadBillCostLines(orgId),
    loadLaborCostEntries(orgId, since),
    // AR retainage lives in the `retainage` table, never on the invoice row. Loaded
    // whole rather than watermarked: a release can attach retainage to an invoice
    // that itself has not changed since the last run.
    loadInvoiceRetainageCents({ supabase: service, orgId }),
    loadRetainageReleaseInvoiceCents({ supabase: service, orgId }),
    // Every paged read below imposes a total order for the reason given on
    // `collectPages`: `.range()` without one skips and duplicates rows.
    collectPages((from, to) => {
      let query = service.from("vendor_bills").select("id, project_id, company_id, bill_number, bill_date, total_cents, retainage_cents, metadata, updated_at").eq("org_id", orgId).in("status", [...PAYABLE_VENDOR_BILL_STATUSES])
      if (since) query = query.gte("updated_at", since)
      return query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to)
    }, "vendor bills"),
    collectPages((from, to) => {
      let query = service.from("invoices").select("id, project_id, title, invoice_number, issue_date, total_cents, updated_at").eq("org_id", orgId).in("status", [...BILLED_INVOICE_STATUSES])
      if (since) query = query.gte("updated_at", since)
      return query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to)
    }, "invoices"),
    collectPages((from, to) => {
      let query = service.from("payments").select("id, project_id, invoice_id, bill_id, amount_cents, fee_cents, processor_fee_cents, platform_fee_cents, method, metadata, received_at, updated_at").eq("org_id", orgId).in("status", ["succeeded", "completed", "paid"])
      if (since) query = query.gte("updated_at", since)
      return query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to)
    }, "payments"),
    collectPages((from, to) => {
      let query = service.from("project_expenses").select("id, project_id, vendor_company_id, expense_date, amount_cents, tax_cents, description, updated_at").eq("org_id", orgId).in("status", ["approved", "locked"])
      if (since) query = query.gte("updated_at", since)
      return query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to)
    }, "project expenses"),
    collectPages((from, to) => {
      let query = service.from("payment_reversals").select("id, project_id, invoice_id, bill_id, amount_cents, occurred_at, updated_at").eq("org_id", orgId).eq("status", "succeeded")
      if (since) query = query.gte("updated_at", since)
      return query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, to)
    }, "payment reversals"),
  ])

  const candidates: ProjectionCandidate[] = []
  const failures: ProjectionFailure[] = []

  // Only a zero-amount source is skipped. A negative one is a credit — a vendor
  // credit, an expense credit — that the cost subledger already carries signed,
  // so dropping it drives job cost out of balance with no failure to point at.
  for (const row of bills) {
    const totalCents = Number(row.total_cents ?? 0)
    if (totalCents === 0) continue
    // A retainage-release payable carries no cost: the whole gross was expensed when
    // the original bill posted, and this bill only moves the withheld portion out of
    // `2010 Retainage payable` and into AP so it can be paid. Posting it as an ordinary
    // bill would debit job costs twice and leave 2010 growing forever.
    if ((row.metadata as { source?: unknown } | null)?.source === "retainage_release") {
      candidates.push({
        sourceType: "retainage_release",
        sourceId: String(row.id),
        accountingDate: String(row.bill_date),
        occurredAt: String(row.updated_at),
        payload: {
          memo: `Retainage release ${row.bill_number ?? ""}`.trim(),
          amount_cents: totalCents,
          side: "payable",
          project_id: row.project_id ?? null,
          company_id: row.company_id ?? null,
        },
      })
      continue
    }
    const subledgerLines = costLinesByBill.get(String(row.id)) ?? []
    const subledgerTotal = subledgerLines.reduce((sum, item) => sum + item.amount_cents, 0)
    // The subledger is authoritative for job cost, but it only drives the entry
    // when it fully accounts for the bill. A partially-coded bill falls back to
    // a single header line so the GL still balances; the nightly tie-out reports
    // the gap rather than the projector inventing detail it does not have.
    const costLines = subledgerLines.length > 0 && subledgerTotal === totalCents
      ? subledgerLines
      : [{ amount_cents: totalCents, project_id: row.project_id ? String(row.project_id) : null }]
    candidates.push({
      sourceType: "vendor_bill",
      sourceId: String(row.id),
      accountingDate: String(row.bill_date),
      occurredAt: String(row.updated_at),
      payload: {
        memo: `Vendor bill ${row.bill_number ?? ""}`.trim(),
        total_cents: totalCents,
        retainage_cents: Number(row.retainage_cents ?? 0),
        project_id: row.project_id ?? null,
        company_id: row.company_id ?? null,
        cost_lines: costLines,
      },
    })
  }

  for (const row of invoices) {
    const totalCents = Number(row.total_cents ?? 0)
    if (totalCents === 0) continue
    // A release invoice collects retainage billed on an earlier invoice. The amount
    // posted is the invoice's own total so AR keeps tying to invoice balances; any
    // divergence from the retainage subledger is reported by the retainage tie-out
    // rather than silently absorbed here.
    if (releaseByInvoice.has(String(row.id))) {
      candidates.push({
        sourceType: "retainage_release",
        sourceId: String(row.id),
        accountingDate: String(row.issue_date),
        occurredAt: String(row.updated_at),
        payload: {
          memo: `Retainage release ${row.invoice_number ?? ""}`.trim(),
          amount_cents: totalCents,
          side: "receivable",
          project_id: row.project_id ?? null,
        },
      })
      continue
    }
    const projectId = row.project_id ? String(row.project_id) : null
    const basis = projectId ? basisByProject.get(projectId) ?? "percentage_of_completion" : "percentage_of_completion"
    candidates.push({
      sourceType: "invoice",
      sourceId: String(row.id),
      accountingDate: String(row.issue_date),
      occurredAt: String(row.updated_at),
      payload: {
        memo: row.title || `Invoice ${row.invoice_number ?? ""}`.trim(),
        // Net of retainage, exactly as stored. `fact-drafts` rebuilds the gross.
        total_cents: totalCents,
        retainage_cents: retainageByInvoice.get(String(row.id)) ?? 0,
        project_id: row.project_id ?? null,
        revenue_basis: basis,
      },
    })
  }

  for (const row of payments) {
    const amountCents = Number(row.amount_cents ?? 0)
    if (amountCents === 0) continue
    const metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {}
    const classification = classifyPaymentPosting({
      method: typeof row.method === "string" ? row.method : null,
      hasBill: Boolean(row.bill_id),
      hasInvoice: Boolean(row.invoice_id),
      creditApplied: metadata.vendor_credit_applied === true,
    })
    // A payment linked to neither a bill nor an invoice is not a customer
    // receipt — fee collections and standalone settlements land here. Guessing
    // would fabricate an AR credit, so it is reported instead of posted.
    if (classification.kind === "unpostable") {
      failures.push({ sourceType: "payment", sourceId: String(row.id), error: classification.reason })
      continue
    }
    // Applying a vendor credit moves no cash. The credit note is itself a
    // negative bill that already posted Dr AP / Cr cost, so the application only
    // nets AP against AP and has no journal entry of its own.
    if (classification.kind === "credit_application") continue
    const accountingDate = accountingDateFromTimestamp(row.received_at)
    if (!accountingDate) {
      failures.push({ sourceType: "payment", sourceId: String(row.id), error: "Payment has no readable received_at to date the entry" })
      continue
    }
    // `fee_cents` is a rollup of the processor/platform split on rows that carry
    // both, so adding all three double-counts. Prefer the split when present.
    const splitFeeCents = Number(row.processor_fee_cents ?? 0) + Number(row.platform_fee_cents ?? 0)
    const feeCents = splitFeeCents > 0 ? splitFeeCents : Number(row.fee_cents ?? 0)
    candidates.push({
      sourceType: classification.kind,
      sourceId: String(row.id),
      accountingDate,
      occurredAt: String(row.updated_at),
      payload: {
        memo: classification.kind === "bill_payment" ? "Vendor bill payment" : "Customer payment",
        amount_cents: amountCents,
        fee_cents: feeCents,
        project_id: row.project_id ?? null,
      },
    })
  }

  for (const row of expenses) {
    const amountCents = Number(row.amount_cents ?? 0) + Number(row.tax_cents ?? 0)
    if (amountCents === 0) continue
    candidates.push({
      sourceType: "expense",
      sourceId: String(row.id),
      accountingDate: String(row.expense_date),
      occurredAt: String(row.updated_at),
      payload: {
        memo: row.description || "Expense",
        amount_cents: amountCents,
        project_id: row.project_id ?? null,
        vendor_company_id: row.vendor_company_id ?? null,
      },
    })
  }

  for (const row of reversals) {
    const amountCents = Number(row.amount_cents ?? 0)
    if (amountCents === 0) continue
    const accountingDate = accountingDateFromTimestamp(row.occurred_at)
    if (!accountingDate) {
      failures.push({ sourceType: "payment_reversal", sourceId: String(row.id), error: "Reversal has no readable occurred_at to date the entry" })
      continue
    }
    // `payment_reversals` carries a DB check that exactly one of invoice_id and
    // bill_id is set, so the side is unambiguous here.
    const hasBill = Boolean(row.bill_id)
    candidates.push({
      sourceType: "payment_reversal",
      sourceId: String(row.id),
      accountingDate,
      occurredAt: String(row.updated_at),
      payload: {
        memo: hasBill ? "Vendor payment returned" : "Customer payment reversed",
        amount_cents: amountCents,
        side: hasBill ? "bill_payment" : "invoice_payment",
        project_id: row.project_id ?? null,
      },
    })
  }

  for (const row of laborEntries) {
    const amountCents = Number(row.cost_cents ?? 0)
    if (amountCents === 0) continue
    candidates.push({
      sourceType: "labor_cost",
      sourceId: String(row.id),
      accountingDate: String(row.incurred_on),
      occurredAt: String(row.updated_at),
      payload: {
        memo: "Field labor",
        amount_cents: amountCents,
        project_id: row.project_id ?? null,
      },
    })
  }

  return { candidates, failures }
}

const factRowSchema = z.object({
  id: z.string().uuid(),
  payload_hash: z.string(),
  source_version: z.number().int(),
})

type FactResolution = { factId: string; sourceVersion: number; created: boolean; superseded: boolean }

/**
 * Records the economic fact behind a candidate. An unchanged payload is a no-op;
 * a changed payload supersedes the prior fact and reverses the journal entry it
 * produced, so the replacement can post cleanly on the same pass.
 *
 * The supersede is three writes — reverse, insert, post — and is not one
 * transaction. It does not need to be, but only because every step is keyed and
 * every pass re-runs it:
 *
 *  - Crash after the reversal: the next pass recomputes the same payload hash,
 *    finds the same prior fact, and reverses again — into the same posting key
 *    (`reversal:<entryId>:<digest of date + reason>`), which is a no-op because
 *    both the date and the reason are derived from the candidate and never from
 *    the clock. It then inserts and posts.
 *  - Crash after the insert: the next pass sees the NEW fact with a MATCHING
 *    hash and returns `created: false` — and `projectJournal` posts on every
 *    pass regardless of that flag, so the missing entry is written then.
 *
 * Both recoveries depend on the incremental watermark still reaching the row:
 * facts store the source's `updated_at` as `occurred_at` and the candidate
 * queries filter `gte`, so a row at exactly the watermark is included. Change
 * any of those four things — a clock in the reversal reason, a `gt` watermark, a
 * `created`-guarded post, or a retirement fact stamped `occurred_at: now()` —
 * and the ledger stops healing itself.
 */
async function resolveProjectionFact(
  orgId: string,
  candidate: ProjectionCandidate,
  policyVersion: number,
): Promise<FactResolution> {
  const service = createServiceSupabaseClient()
  const payloadHash = booksDigest(hashableFactPayload(candidate.payload))
  const { data: existingRow, error: existingError } = await service.from("accounting_facts")
    .select("id, payload_hash, source_version")
    .eq("org_id", orgId)
    .eq("source_type", candidate.sourceType)
    .eq("source_id", candidate.sourceId)
    .order("source_version", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw new Error(`Failed to inspect accounting fact: ${existingError.message}`)
  const existing = existingRow ? factRowSchema.parse(existingRow) : null
  if (existing?.payload_hash === payloadHash) {
    return { factId: existing.id, sourceVersion: existing.source_version, created: false, superseded: false }
  }

  const sourceVersion = existing ? existing.source_version + 1 : 1
  if (existing) {
    const { data: priorEntries, error: priorError } = await service
      .from("journal_entries")
      .select("id")
      .eq("org_id", orgId)
      .eq("fact_id", existing.id)
      .eq("status", "posted")
    if (priorError) throw new Error(`Failed to load the superseded journal entry: ${priorError.message}`)
    for (const entry of priorEntries ?? []) {
      await reverseBooksJournalEntryForService({
        entryId: String(entry.id),
        reversalDate: candidate.accountingDate,
        reason: `${candidate.sourceType} was revised after posting`,
        orgId,
      })
    }
    await recordEvent({
      orgId,
      eventType: "books.projection_source_revised",
      entityType: candidate.sourceType,
      entityId: candidate.sourceId,
      payload: { prior_fact_id: existing.id, prior_version: existing.source_version, new_version: sourceVersion },
    })
  }

  const idempotencyKey = booksDigest({ orgId, sourceType: candidate.sourceType, sourceId: candidate.sourceId, payloadHash })
  const { data, error } = await service.from("accounting_facts").insert({
    org_id: orgId,
    source_type: candidate.sourceType,
    source_id: candidate.sourceId,
    source_version: sourceVersion,
    fact_kind: `${candidate.sourceType}.recognized`,
    occurred_at: candidate.occurredAt,
    accounting_date: candidate.accountingDate,
    payload: candidate.payload,
    payload_hash: payloadHash,
    policy_version: policyVersion,
    supersedes_fact_id: existing?.id ?? null,
    idempotency_key: idempotencyKey,
  }).select("id").single()
  if (error) throw new Error(`Failed to record accounting fact: ${error.message}`)
  return {
    factId: z.object({ id: z.string().uuid() }).parse(data).id,
    sourceVersion,
    created: true,
    superseded: Boolean(existing),
  }
}

const retirableFactRowSchema = z.object({
  id: z.string().uuid(),
  source_type: z.string(),
  source_id: z.string().uuid(),
  source_version: z.number().int(),
  fact_kind: z.string(),
  accounting_date: z.string(),
  occurred_at: z.string(),
})

type RetirableFactRow = z.infer<typeof retirableFactRowSchema>

/**
 * Un-posts the sources that left.
 *
 * `projectionCandidates` enumerates what CURRENTLY qualifies, so an invoice
 * voided after it posted, a bill moved to `rejected`, or a row deleted upstream
 * simply stops appearing — and its journal entry stands forever, with the AR or
 * AP tie-out red and no cure. This is the other half: reverse the entry, then
 * append a retirement fact so the source is never posted again.
 *
 * FULL PASSES ONLY. On an incremental pass the candidate set is a watermarked
 * slice, and treating absence as departure would retire the entire ledger.
 *
 * Re-running is safe. The reversal's posting key is derived from the entry id,
 * the fact's own accounting date and a constant reason, so a second reversal
 * collides with the first and does nothing; and the retirement fact makes the
 * source skip the scan entirely on every later pass. A source that comes back
 * supersedes the retirement fact through the ordinary path and posts again.
 */
async function retireDepartedSources(orgId: string, liveSourceKeys: ReadonlySet<string>, policyVersion: number) {
  const service = createServiceSupabaseClient()
  const rows = await collectPages(
    (from, to) => service
      .from("accounting_facts")
      .select("id, source_type, source_id, source_version, fact_kind, accounting_date, occurred_at")
      .eq("org_id", orgId)
      .in("source_type", [...PROJECTED_SOURCE_TYPES])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
    "accounting facts for retirement",
  )
  const latestBySource = new Map<string, RetirableFactRow>()
  for (const raw of rows) {
    const row = retirableFactRowSchema.parse(raw)
    const key = factSourceKey(row.source_type, row.source_id)
    const current = latestBySource.get(key)
    if (!current || row.source_version > current.source_version) latestBySource.set(key, row)
  }

  const departed = selectFactsToRetire(
    Array.from(latestBySource.values()).map((row) => ({
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceVersion: row.source_version,
      factKind: row.fact_kind,
      row,
    })),
    liveSourceKeys,
  )

  const failures: ProjectionFailure[] = []
  let retired = 0
  for (const fact of departed) {
    try {
      const { data: postedEntries, error: postedError } = await service
        .from("journal_entries")
        .select("id")
        .eq("org_id", orgId)
        .eq("fact_id", fact.row.id)
        .eq("status", "posted")
      if (postedError) throw new Error(`Failed to load the retired journal entry: ${postedError.message}`)
      for (const entry of postedEntries ?? []) {
        await reverseBooksJournalEntryForService({
          entryId: String(entry.id),
          // The fact's own date, not today's: it is the only value that stays the
          // same on every re-run, which is what makes the reversal idempotent.
          reversalDate: fact.row.accounting_date,
          reason: RETIREMENT_REASON,
          orgId,
        })
      }
      const payload = retirementFactPayload(fact.sourceVersion)
      const payloadHash = booksDigest(hashableFactPayload(payload))
      const { error: insertError } = await service.from("accounting_facts").insert({
        org_id: orgId,
        source_type: fact.sourceType,
        source_id: fact.sourceId,
        source_version: fact.sourceVersion + 1,
        fact_kind: retiredFactKind(fact.sourceType),
        // Carried over rather than stamped `now()`: `occurred_at` IS the
        // incremental watermark, and advancing it here would make the next
        // incremental pass skip every source touched since this run started.
        occurred_at: fact.row.occurred_at,
        accounting_date: fact.row.accounting_date,
        payload,
        payload_hash: payloadHash,
        policy_version: policyVersion,
        supersedes_fact_id: fact.row.id,
        reversal_of_fact_id: fact.row.id,
        idempotency_key: booksDigest({ orgId, sourceType: fact.sourceType, sourceId: fact.sourceId, payloadHash }),
      })
      if (insertError) throw new Error(`Failed to record the retirement fact: ${insertError.message}`)
      await recordEvent({
        orgId,
        eventType: "books.projection_source_retired",
        entityType: fact.sourceType,
        entityId: fact.sourceId,
        payload: { retired_fact_id: fact.row.id, retired_version: fact.sourceVersion, entries_reversed: (postedEntries ?? []).length },
      })
      retired += 1
    } catch (retirementError) {
      failures.push({
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
        error: retirementError instanceof Error ? retirementError.message : String(retirementError),
      })
    }
  }
  return { retired, failures }
}

/**
 * The rule-set version the ledger is projected under. Approving a new
 * `accounting_policies` version re-projects every source into a parallel set of
 * entries the verifier can compare before the old version is retired.
 */
export async function resolveProjectionVersion(orgId: string) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("accounting_policies")
    .select("version")
    .eq("org_id", orgId)
    .eq("status", "approved")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to resolve the projection version: ${error.message}`)
  return data?.version ? Number(data.version) : 1
}

export async function projectJournal(orgId: string, options: { since?: string; full?: boolean } = {}) {
  const service = createServiceSupabaseClient()
  const { data: settings, error } = await service.from("books_settings")
    .select("workspace_enabled, arc_ledger_mode, active_policy_version")
    .eq("org_id", orgId)
    .single()
  if (error) throw new Error(`Failed to load Books settings: ${error.message}`)
  if (!settings.workspace_enabled || settings.arc_ledger_mode === "disabled") {
    return { projected: 0, skipped: 0, revised: 0, retired: 0, failures: [] as ProjectionFailure[] }
  }

  const policyVersion = Number(settings.active_policy_version)
  const projectionVersion = await resolveProjectionVersion(orgId)
  const since = options.full ? null : options.since ?? (await resolveWatermark(orgId))
  const { candidates, failures } = await projectionCandidates(orgId, since)

  let projected = 0
  let skipped = 0
  let revised = 0
  for (const candidate of candidates) {
    try {
      const fact = await resolveProjectionFact(orgId, candidate, policyVersion)
      if (fact.superseded) revised += 1
      const draft = draftFromFact({
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        accountingDate: candidate.accountingDate,
        payload: candidate.payload,
        sourceVersion: fact.sourceVersion,
        projectionVersion,
        policyVersion,
      })
      if (!draft) throw new Error(`No posting rule covers ${candidate.sourceType}`)
      const journal = await postBooksJournalEntryForService(draft, orgId, fact.factId)
      if (fact.created || journal.created) projected += 1
      else skipped += 1
    } catch (projectionError) {
      failures.push({
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        error: projectionError instanceof Error ? projectionError.message : String(projectionError),
      })
    }
  }

  // Only a full pass has a complete candidate set, and only a complete set can
  // tell "this source is gone" apart from "this source is behind the watermark".
  let retired = 0
  if (options.full) {
    const liveSourceKeys = new Set(candidates.map((candidate) => factSourceKey(candidate.sourceType, candidate.sourceId)))
    const retirement = await retireDepartedSources(orgId, liveSourceKeys, policyVersion)
    retired = retirement.retired
    failures.push(...retirement.failures)
  }
  return { projected, skipped, revised, retired, failures }
}

export async function runBooksProjection(options: { full?: boolean } = {}) {
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("books_settings").select("org_id").eq("workspace_enabled", true).neq("arc_ledger_mode", "disabled").order("org_id")
  if (error) throw new Error(`Failed to load Books organizations: ${error.message}`)
  const results = []
  for (const row of data ?? []) results.push({ orgId: row.org_id, ...await projectJournal(row.org_id, { full: options.full }) })
  return { organizations: results.length, results }
}
