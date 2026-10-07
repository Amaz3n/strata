import "server-only";
import { laborBasisFromJobCost } from "./labor-evidence";
import { loadInvoiceRevenueLines } from "@/lib/services/books/invoice-revenue";
import { timestampMicros } from "@/lib/services/books/posting-state";
import { allocateInvoiceRevenue, invoiceRevenueBasis, invoiceHasAccountingPrincipal } from "@/lib/services/books/invoice-revenue-rules";
import { loadBooksProjectDimensions } from "@/lib/services/books/dimensions";
import { directSettlementEvidence, paymentProjectionSourceKeys } from "@/lib/services/books/settlement-evidence";
import { loadPaymentAllocationEvidence } from "@/lib/services/books/settlement-allocation-loader";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts";

import { z } from "zod";
import { loadOpeningOwnedSources } from "@/lib/services/books/opening-sources";
import { reconcileWarrantyRecoveriesForService } from "@/lib/services/books/warranty-accounting";
import { loadInventoryPolicies, transitionInventoryForService } from "@/lib/services/books/inventory";
import { inventoryCostAccount } from "@/lib/services/books/inventory-rules";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { chunk } from "@/lib/utils";
import { checkFactJournals, factCheckSchema, FACT_CHECK_COLUMNS, type LedgerDifference } from "@/lib/services/books/fact-journal-check";
import { PROJECTION_RUN_SOURCE_TYPE } from "@/lib/services/books/reconciliation-rules";
import {
  BILLED_INVOICE_STATUSES,
  PAYABLE_VENDOR_BILL_STATUSES,
  POSTED_EXPENSE_STATUSES,
  POSTED_PAYMENT_STATUSES,
} from "@/lib/financials/ledger-status";
import {
  draftFromFact,
  factSourceKey,
  hashableFactPayload,
  retiredFactKind,
  retirementFactPayload,
  selectFactsToRetire,
  sortFactCostLines,
  preserveLegacyDimensionPayload,
  preserveLegacySettlementPayload,
  preserveLegacyInvoiceIncomePayload,
  preserveLegacyLaborPayload,
  type FactCostLine,
} from "@/lib/services/books/fact-drafts";
import { loadBooksFundingResolver } from "@/lib/services/books/funding";
import { factTransitionIdentity } from "@/lib/services/books/fact-identity";
import { booksDigest } from "@/lib/services/books/hash";
import {
  projectBooksFactAndJournalForService,
  reverseBooksJournalEntryForService,
} from "@/lib/services/books/ledger";
import { classifyPaymentPosting } from "@/lib/services/books/posting-rules";
import { loadRevenuePolicyResolver, recordInferredRevenuePolicies } from "@/lib/services/books/revenue-basis";
import { recordEvent } from "@/lib/services/events";
import { isoDateOnlyFromUtcMs, todayIsoDateOnly } from "@/lib/services/reports/dates";
import {
  loadInvoiceRetainageCents,
  loadRetainageReleaseInvoiceCents,
} from "@/lib/services/retainage";

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

const PROJECTION_PAGE_SIZE = 500;

/**
 * A hard bound on any one paged read. `collectPages` runs until it sees a short
 * page, which is correct but unbounded; a runaway query would otherwise consume
 * the whole job's memory and die without saying why. Reaching this is a loud
 * failure, never a silent truncation.
 */
const PROJECTION_MAX_ROWS = 250_000;

/** Ids per `.in()` filter: about 200 uuids keep a request URL comfortably short. */
const PROJECTION_ID_CHUNK = 200;

/**
 * How far before its cursor each ordinary run re-reads. `updated_at` is stamped
 * with the writing transaction's start time, so a write that commits after a
 * newer one has already been projected carries a timestamp behind the cursor.
 * Re-reading this window finds it; anything unchanged in it is skipped without
 * a database call. Longer-running writes wait for the nightly pass.
 */
const LATE_COMMIT_WINDOW_MS = 5 * 60 * 1000;

/** Source types the projector owns end to end, and may therefore retire. */
const PROJECTED_SOURCE_TYPES = [
  "vendor_bill",
  "invoice",
  "retainage_release",
  "bill_payment",
  "ap_fee_charge",
  "invoice_payment",
  "customer_deposit_receipt",
  "customer_deposit_application",
  "customer_deposit_reversal",
  "expense",
  "payment_reversal",
  "receivable_adjustment",
  "labor_cost",
] as const;

const RETIREMENT_REASON = "source no longer qualifies for projection";

type ProjectionCandidate = {
  sourceType: string;
  sourceId: string;
  accountingDate: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

type ProjectionFailure = {
  sourceType: string;
  sourceId: string;
  error: string;
};

/**
 * Reads every page of a query.
 *
 * The loader MUST impose a total order. PostgREST resolves `.range()` as
 * `limit/offset` over whatever order the planner chose, so an unordered paged
 * read can hand back the same row twice and skip another entirely — which in a
 * ledger means a bill posted twice and a bill never posted at all.
 */
async function collectPages<T>(
  loadPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; ; page += 1) {
    const from = page * PROJECTION_PAGE_SIZE;
    const { data, error } = await loadPage(
      from,
      from + PROJECTION_PAGE_SIZE - 1,
    );
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PROJECTION_PAGE_SIZE) return rows;
    if (rows.length >= PROJECTION_MAX_ROWS) {
      throw new Error(
        `Refusing to project a truncated read: ${label} exceeded ${PROJECTION_MAX_ROWS} rows`,
      );
    }
  }
}

/**
 * Reads every row of a query in primary-key order, each page starting after the
 * last id seen. Unlike offset paging, a row deleted or updated while the read is
 * in flight cannot shift a later row out of the result.
 */
async function collectByKey<T extends { id: unknown }>(
  loadPage: (afterId: string | null) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { data, error } = await loadPage(afterId);
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PROJECTION_PAGE_SIZE) return rows;
    if (rows.length >= PROJECTION_MAX_ROWS) {
      throw new Error(`Refusing to project a truncated read: ${label} exceeded ${PROJECTION_MAX_ROWS} rows`);
    }
    afterId = String(batch[batch.length - 1].id);
  }
}

/** Every page of a query for each slice of ids, e.g. the lines of the bills being projected. */
async function collectForIds<T>(
  ids: string[],
  loadPage: (slice: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (const slice of chunk([...new Set(ids)], PROJECTION_ID_CHUNK)) {
    rows.push(...(await collectPages((from, to) => loadPage(slice, from, to), label)));
  }
  return rows;
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
  if (typeof value !== "string" && typeof value !== "number") return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? isoDateOnlyFromUtcMs(ms) : null;
}

type ByFamily<T> = {
  bills: T;
  invoices: T;
  payments: T;
  feeCharges: T;
  expenses: T;
  reversals: T;
  adjustments: T;
  labor: T;
};

/**
 * What a family's read selects: rows from a timestamp (or strictly after it) plus
 * sources that failed to post and are read again whatever their timestamp; or
 * exactly the listed ids; or, when null, every row.
 */
type ReadFrom = { at: string; inclusive: boolean; retryIds: string[] } | { ids: string[] } | null;

/** The PostgREST `or` filter for a family's read. */
function readFromFilter(from: NonNullable<ReadFrom>) {
  if ("ids" in from) return `id.in.(${from.ids.join(",")})`;
  const bound = `updated_at.${from.inclusive ? "gte" : "gt"}."${from.at}"`;
  return from.retryIds.length ? `${bound},id.in.(${from.retryIds.join(",")})` : bound;
}

/**
 * A run for chosen sources reads exactly those rows. A family asked for more ids
 * than one filter carries is read whole, and the run still evaluates only the
 * chosen sources.
 */
function watermarksForSources(sourceKeys: string[]): ProjectionWatermarks {
  const ids: ByFamily<string[]> = { bills: [], invoices: [], payments: [], feeCharges: [], expenses: [], reversals: [], adjustments: [], labor: [] };
  for (const key of sourceKeys) {
    const separator = key.indexOf(":");
    const id = z.string().uuid().safeParse(key.slice(separator + 1));
    if (!id.success) continue;
    for (const family of RETRY_FAMILIES[key.slice(0, separator)] ?? []) ids[family].push(id.data);
  }
  const read = (family: string[]): ReadFrom => (family.length > PROJECTION_ID_CHUNK ? null : { ids: family });
  return {
    bills: read(ids.bills), invoices: read(ids.invoices), payments: read(ids.payments), feeCharges: read(ids.feeCharges),
    expenses: read(ids.expenses), reversals: read(ids.reversals), adjustments: read(ids.adjustments), labor: read(ids.labor),
  };
}

/** A failed source's finding names it by projection source type; this is the table family it is read from. */
const RETRY_FAMILIES: Record<string, Array<keyof ByFamily<unknown>>> = {
  vendor_bill: ["bills"],
  invoice: ["invoices"],
  retainage_release: ["bills", "invoices"],
  payment: ["payments"],
  bill_payment: ["payments"],
  invoice_payment: ["payments"],
  customer_deposit_receipt: ["payments"],
  customer_deposit_application: ["payments"],
  ap_fee_charge: ["feeCharges"],
  expense: ["expenses"],
  payment_reversal: ["reversals"],
  customer_deposit_reversal: ["reversals"],
  receivable_adjustment: ["adjustments"],
  labor_cost: ["labor"],
};

/** Sources an earlier run failed to post, by family, oldest first and at most 200 each. */
async function loadRetryIds(orgId: string): Promise<ByFamily<string[]>> {
  const { data, error } = await createServiceSupabaseClient()
    .from("accounting_reconciliation_items")
    .select("entity_type, entity_id")
    .eq("org_id", orgId)
    .eq("category", "projection_failed")
    .neq("status", "resolved")
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`Failed to load sources to retry: ${error.message}`);
  const retry: ByFamily<string[]> = { bills: [], invoices: [], payments: [], feeCharges: [], expenses: [], reversals: [], adjustments: [], labor: [] };
  for (const row of data ?? []) {
    const id = z.string().uuid().safeParse(row.entity_id);
    if (!id.success) continue;
    for (const family of RETRY_FAMILIES[String(row.entity_type)] ?? []) {
      if (retry[family].length < PROJECTION_ID_CHUNK) retry[family].push(id.data);
    }
  }
  return retry;
}
type ProjectionWatermarks = ByFamily<ReadFrom>;

async function latestFactTimestamp(orgId: string, sourceType: string) {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("accounting_facts")
    .select("occurred_at")
    .eq("org_id", orgId)
    .eq("source_type", sourceType)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error)
    throw new Error(
      `Failed to resolve the ${sourceType} projection watermark: ${error.message}`,
    );
  return data?.occurred_at ? String(data.occurred_at) : null;
}

function earliestTimestamp(values: Array<string | null>) {
  const present = values
    .filter((value): value is string => Boolean(value))
    .sort();
  return present[0] ?? null;
}

/**
 * Where an ordinary run starts, per source family (one cursor per family, so a
 * newer bill never carries the cursor past an older invoice).
 *
 * Everything up to the saved cursor was read by an earlier run, except writes
 * still in flight while that run read: their transaction began before it, so
 * their updated_at falls inside the late-commit window before the run started.
 * The read therefore starts at that window when it reaches back past the cursor,
 * and strictly after the cursor otherwise, so a settled company reads nothing.
 * A company with no saved progress starts from its latest facts, replaying the
 * boundary row.
 */
async function resolveWatermarks(orgId: string): Promise<ProjectionWatermarks> {
  const [{ data, error }, retry] = await Promise.all([
    createServiceSupabaseClient().from("books_projection_progress").select("cursors, read_started_at").eq("org_id", orgId).maybeSingle(),
    loadRetryIds(orgId),
  ]);
  if (error) throw new Error(`Failed to load projection progress: ${error.message}`);
  if (!data) return factWatermarks(orgId, retry);
  // A contract whose effective date arrived since the last read changes its
  // project's revenue basis with no edit; touching those sources puts them in
  // this run's read.
  if (data.read_started_at) {
    const { error: touchError } = await createServiceSupabaseClient().rpc("books_touch_sources_for_effective_contracts", {
      p_org_id: orgId, p_after: isoDateOnlyFromUtcMs(Date.parse(String(data.read_started_at))), p_through: todayIsoDateOnly(),
    });
    if (touchError) throw new Error(`Failed to refresh sources for contracts taking effect: ${touchError.message}`);
  }
  const cursors = z.record(z.string()).parse(data.cursors);
  const window = data.read_started_at ? new Date(Date.parse(String(data.read_started_at)) - LATE_COMMIT_WINDOW_MS).toISOString() : null;
  const from = (cursor: string | undefined, retryIds: string[]): ReadFrom => {
    if (!cursor) return null;
    return window && !isAtOrAfter(window, cursor) ? { at: window, inclusive: true, retryIds } : { at: cursor, inclusive: false, retryIds };
  };
  return {
    bills: from(cursors.bills, retry.bills), invoices: from(cursors.invoices, retry.invoices), payments: from(cursors.payments, retry.payments),
    feeCharges: from(cursors.feeCharges, retry.feeCharges), expenses: from(cursors.expenses, retry.expenses), reversals: from(cursors.reversals, retry.reversals),
    adjustments: from(cursors.adjustments, retry.adjustments), labor: from(cursors.labor, retry.labor),
  };
}

async function factWatermarks(orgId: string, retry: ByFamily<string[]>): Promise<ProjectionWatermarks> {
  const [
    vendorBill,
    invoice,
    retainage,
    billPayment,
    invoicePayment,
    customerDepositReceipt,
    customerDepositApplication,
    feeCharge,
    expense,
    reversal,
    customerDepositReversal,
    receivableAdjustment,
    labor,
  ] = await Promise.all([
    latestFactTimestamp(orgId, "vendor_bill"),
    latestFactTimestamp(orgId, "invoice"),
    latestFactTimestamp(orgId, "retainage_release"),
    latestFactTimestamp(orgId, "bill_payment"),
    latestFactTimestamp(orgId, "invoice_payment"),
    latestFactTimestamp(orgId, "customer_deposit_receipt"),
    latestFactTimestamp(orgId, "customer_deposit_application"),
    latestFactTimestamp(orgId, "ap_fee_charge"),
    latestFactTimestamp(orgId, "expense"),
    latestFactTimestamp(orgId, "payment_reversal"),
    latestFactTimestamp(orgId, "customer_deposit_reversal"),
    latestFactTimestamp(orgId, "receivable_adjustment"),
    latestFactTimestamp(orgId, "labor_cost"),
  ]);
  const at = (value: string | null, retryIds: string[]): ReadFrom => (value ? { at: value, inclusive: true, retryIds } : null);
  return {
    bills: at(earliestTimestamp([vendorBill, retainage]), retry.bills),
    invoices: at(earliestTimestamp([invoice, retainage]), retry.invoices),
    payments: at(earliestTimestamp([
      billPayment,
      invoicePayment,
      customerDepositReceipt,
      customerDepositApplication,
    ]), retry.payments),
    feeCharges: at(feeCharge, retry.feeCharges),
    expenses: at(expense, retry.expenses),
    reversals: at(earliestTimestamp([reversal, customerDepositReversal]), retry.reversals),
    adjustments: at(receivableAdjustment, retry.adjustments),
    labor: at(labor, retry.labor),
  };
}

/**
 * Job cost per bill, from the subledger.
 *
 * `job_cost_entries.source_id` for a `vendor_bill_line` row is the BILL LINE id,
 * so the mapping to a bill runs through `bill_lines`. A line can also be
 * allocated to a different project than its bill's primary project, which is
 * exactly the detail the GL loses when it posts from bill headers.
 */
async function loadBillCostLines(orgId: string, billIds: string[]) {
  const service = createServiceSupabaseClient();
  // Only the bills being projected: an ordinary run must not read the ledger's
  // whole job-cost history to post the handful of bills that changed.
  const [billLines, accounts] = await Promise.all([
    collectForIds(
      billIds,
      // `bill_lines` has no `created_at`; its primary key is the whole total order.
      (slice, from, to) =>
        service
          .from("bill_lines")
          .select("id, bill_id, description, metadata")
          .eq("org_id", orgId)
          .in("bill_id", slice)
          .order("id", { ascending: true })
          .range(from, to),
      "bill lines",
    ),
    collectPages(
      (from, to) =>
        service
          .from("gl_accounts")
          .select("id,code")
          .eq("org_id", orgId)
          .eq("active", true)
          .eq("account_type", "cogs")
          .order("id", { ascending: true })
          .range(from, to),
      "Arc Books accounts",
    ),
  ]);
  const entries = await collectForIds(
    billLines.map((row) => String(row.id)),
    (slice, from, to) =>
      service
        .from("job_cost_entries")
        .select("source_id, project_id, cost_cents, cost_code_id, metadata")
        .eq("org_id", orgId)
        .eq("status", "posted")
        .eq("source_type", "vendor_bill_line")
        .in("source_id", slice)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    "job cost entries",
  );
  const accountCodeById = new Map(
    accounts.map((account) => [String(account.id), String(account.code)]),
  );
  const billByLine = new Map(
    billLines.map((row) => {
      const metadata =
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {};
      // Provider ids and Arc GL ids are different namespaces. Reading the QBO id
      // here made an inbound sync look like an economic recode and then failed the
      // Arc account lookup. Only an explicitly namespaced Books override is valid.
      const selectedAccountId =
        typeof metadata.arc_books_gl_account_id === "string"
          ? metadata.arc_books_gl_account_id
          : null;
      return [
        String(row.id),
        {
          billId: String(row.bill_id),
          description: row.description ? String(row.description) : undefined,
          accountCode: selectedAccountId
            ? accountCodeById.get(selectedAccountId)
            : undefined,
        },
      ];
    }),
  );
  const byBill = new Map<string, FactCostLine[]>();
  for (const row of entries) {
    const link = billByLine.get(String(row.source_id));
    if (!link) continue;
    const list = byBill.get(link.billId) ?? [];
    list.push({
      dimensions: { cost_type: ({ "5010": "Subcontractor", "5020": "Materials", "5030": "Labor", "5040": "Equipment", "5050": "Warranty" } as Record<string, string>)[link.accountCode ?? ""] ?? "General job costs", ...(row.cost_code_id ? { cost_code_id: row.cost_code_id } : {}) },
      amount_cents: Number(row.cost_cents ?? 0),
      project_id: row.project_id ? String(row.project_id) : null,
      description: link.description,
      account_code: link.accountCode,
    });
    byBill.set(link.billId, list);
  }
  // Sorted on the way out, not merely read in order: the hash must depend on the
  // set of cost lines and never on how they were paged.
  for (const [billId, list] of byBill)
    byBill.set(billId, sortFactCostLines(list));
  return byBill;
}

/** Expense cost lines, including cross-project splits, from the same subledger. */
async function loadExpenseCostLines(orgId: string, expenseIds: string[]) {
  const service = createServiceSupabaseClient();
  const [expenseLines, accounts] = await Promise.all([
    collectForIds(
      expenseIds,
      (slice, from, to) =>
        service
          .from("project_expense_lines")
          .select("id, expense_id, description, metadata")
          .eq("org_id", orgId)
          .in("expense_id", slice)
          .order("id", { ascending: true })
          .range(from, to),
      "project expense lines",
    ),
    collectPages(
      (from, to) =>
        service
          .from("gl_accounts")
          .select("id, code")
          .eq("org_id", orgId)
          .eq("active", true)
          .eq("account_type", "cogs")
          .order("id", { ascending: true })
          .range(from, to),
      "Arc Books job-cost accounts",
    ),
  ]);
  // A cost row points at the expense itself or at one of its lines.
  const entries = await collectForIds(
    [...expenseIds, ...expenseLines.map((row) => String(row.id))],
    (slice, from, to) =>
      service
        .from("job_cost_entries")
        .select("source_type, source_id, project_id, cost_cents, cost_code_id, metadata")
        .eq("org_id", orgId)
        .eq("status", "posted")
        .in("source_type", ["project_expense", "project_expense_line"])
        .in("source_id", slice)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    "expense job cost entries",
  );
  const accountCodeById = new Map(
    accounts.map((account) => [String(account.id), String(account.code)]),
  );
  const lineById = new Map(
    expenseLines.map((row) => {
      const metadata =
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : {};
      const accountId =
        typeof metadata.arc_books_gl_account_id === "string"
          ? metadata.arc_books_gl_account_id
          : null;
      return [
        String(row.id),
        {
          expenseId: String(row.expense_id),
          description: row.description ? String(row.description) : undefined,
          accountCode: accountId ? accountCodeById.get(accountId) : undefined,
        },
      ];
    }),
  );
  const byExpense = new Map<string, FactCostLine[]>();
  for (const row of entries) {
    const line =
      row.source_type === "project_expense_line"
        ? lineById.get(String(row.source_id))
        : null;
    const expenseId =
      line?.expenseId ??
      (row.source_type === "project_expense" ? String(row.source_id) : null);
    if (!expenseId) continue;
    const list = byExpense.get(expenseId) ?? [];
    list.push({
      dimensions: { cost_type: ({ "5010": "Subcontractor", "5020": "Materials", "5030": "Labor", "5040": "Equipment", "5050": "Warranty" } as Record<string, string>)[line?.accountCode ?? ""] ?? "General job costs", ...(row.cost_code_id ? { cost_code_id: row.cost_code_id } : {}) },
      amount_cents: Number(row.cost_cents ?? 0),
      project_id: row.project_id ? String(row.project_id) : null,
      description: line?.description,
      account_code: line?.accountCode,
    });
    byExpense.set(expenseId, list);
  }
  for (const [expenseId, list] of byExpense)
    byExpense.set(expenseId, sortFactCostLines(list));
  return byExpense;
}

/**
 * Field labor from the time subledger. Time entries have no other route into the
 * GL, so without this the job-cost tie-out can never balance.
 */
async function loadLaborCostEntries(orgId: string, since: ReadFrom) {
  const service = createServiceSupabaseClient();
  return collectByKey((afterId) => {
    let query = service
      .from("job_cost_entries")
      .select("id, org_id, source_type, source_id, project_id, cost_cents, incurred_on, updated_at, status, cost_code_id, metadata")
      .eq("org_id", orgId)
      .eq("source_type", "time_entry");
    if (since) query = query.or(readFromFilter(since));
    if (afterId) query = query.gt("id", afterId);
    return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
  }, "labor job cost entries");
}

async function projectionCandidates(
  orgId: string,
  watermarks: ProjectionWatermarks,
) {
  const service = createServiceSupabaseClient();
  const [
    funding,
    projectDimensions,
    openingSources,
    inventoryPolicies,
    revenuePolicies,
    laborEntries,
    bills,
    invoices,
    payments,
    feeCharges,
    expenses,
    reversals,
    adjustments,
  ] = await Promise.all([
    loadBooksFundingResolver(orgId),
    loadBooksProjectDimensions(orgId),
    loadOpeningOwnedSources(orgId),
    loadInventoryPolicies(orgId),
    loadRevenuePolicyResolver(orgId),
    loadLaborCostEntries(orgId, watermarks.labor),
    // Every paged read below imposes a total order for the reason given on
    // `collectPages`: `.range()` without one skips and duplicates rows.
    collectByKey((afterId) => {
      let query = service
        .from("vendor_bills")
        .select(
          "id, project_id, company_id, bill_number, bill_date, total_cents, retainage_cents, use_tax_accrued_cents, metadata, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.bills) query = query.or(readFromFilter(watermarks.bills));
      if (afterId) query = query.gt("id", afterId);
      return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
    }, "vendor bills"),
    collectByKey((afterId) => {
      let query = service
        .from("invoices")
        .select(
          "id, project_id, title, invoice_number, issue_date, total_cents, tax_cents, metadata, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.invoices) query = query.or(readFromFilter(watermarks.invoices));
      if (afterId) query = query.gt("id", afterId);
      return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
    }, "invoices"),
    collectByKey((afterId) => {
      let query = service
        .from("payments")
        .select(
          "id, project_id, invoice_id, bill_id, amount_cents, gross_cents, fee_cents, processor_fee_cents, platform_fee_cents, method, metadata, received_at, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.payments) query = query.or(readFromFilter(watermarks.payments));
      if (afterId) query = query.gt("id", afterId);
      return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
    }, "payments"),
    collectByKey((afterId) => {
      let query = service
        .from("payment_run_fee_charges")
        .select("id, amount_cents, funding_source_id, settled_at, updated_at, status")
        .eq("org_id", orgId);
      if (watermarks.feeCharges) query = query.or(readFromFilter(watermarks.feeCharges));
      if (afterId) query = query.gt("id", afterId);
      return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
    }, "payment run fee charges"),
    collectByKey((afterId) => {
      let query = service
        .from("project_expenses")
        .select(
          "id, project_id, vendor_company_id, expense_date, amount_cents, tax_cents, description, payment_method, accounting_coding, metadata, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.expenses) query = query.or(readFromFilter(watermarks.expenses));
      if (afterId) query = query.gt("id", afterId);
      return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
    }, "project expenses"),
    collectByKey((afterId) => {
      let query = service
        .from("payment_reversals")
        .select(
          "id, project_id, invoice_id, bill_id, payment_id, amount_cents, occurred_at, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.reversals) query = query.or(readFromFilter(watermarks.reversals));
      if (afterId) query = query.gt("id", afterId);
      return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
    }, "payment reversals"),
    collectByKey((afterId) => {
      let query = service
        .from("receivable_adjustments")
        .select(
          "id, project_id, invoice_id, adjustment_type, status, amount_cents, tax_cents, effective_date, reason, updated_at",
        )
        .eq("org_id", orgId);
      if (watermarks.adjustments) query = query.or(readFromFilter(watermarks.adjustments));
      if (afterId) query = query.gt("id", afterId);
      return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
    }, "receivable adjustments"),
  ]);

  // What the selected documents need, read for those documents only. AR retainage
  // lives in the `retainage` table, never on the invoice row; a change to it
  // touches its invoices, so the invoices selected here are the ones it affects.
  const invoiceIds = invoices.map((row) => String(row.id));
  // A receipt or reversal is a customer deposit when its invoice is a deposit
  // request, whether or not that invoice changed in this run's window.
  const referencedInvoiceIds = [...payments, ...reversals].map((row) => row.invoice_id).filter((id): id is string => typeof id === "string");
  // On a job with several contracts, what an invoice bills (and a credit memo
  // credits) is that contract's position, so its lines carry the contract. With
  // one contract the project tags already name it.
  const today = todayIsoDateOnly();
  const documentProjects = new Set([...invoices, ...adjustments].map((row) => row.project_id).filter((id): id is string => typeof id === "string"));
  const multiContract = new Map([...documentProjects].flatMap((projectId) => {
    try {
      const resolved = revenuePolicies.resolve(projectId, today);
      return resolved.contractIds.length > 1 ? [[projectId, new Set(resolved.contractIds)] as const] : [];
    } catch {
      return []; // The job's documents report the policy conflict themselves.
    }
  }));
  const billedContract = (projectId: unknown, metadata: unknown) => {
    const contracts = typeof projectId === "string" ? multiContract.get(projectId) : undefined;
    const contractId = metadata && typeof metadata === "object" ? Reflect.get(metadata, "source_contract_id") : null;
    return contracts && typeof contractId === "string" && contracts.has(contractId) ? contractId : null;
  };
  const creditedInvoiceIds = adjustments.filter((row) => row.project_id && multiContract.has(String(row.project_id))).map((row) => String(row.invoice_id));
  const [costLinesByBill, costLinesByExpense, retainageByInvoice, releaseByInvoice, referencedDeposits, creditedInvoices] = await Promise.all([
    loadBillCostLines(orgId, bills.map((row) => String(row.id))),
    loadExpenseCostLines(orgId, expenses.map((row) => String(row.id))),
    loadInvoiceRetainageCents({ supabase: service, orgId, invoiceIds }),
    loadRetainageReleaseInvoiceCents({ supabase: service, orgId, invoiceIds }),
    collectForIds(referencedInvoiceIds, (slice, from, to) => service.from("invoices").select("id")
      .eq("org_id", orgId).eq("metadata->>invoice_kind", "earnest_deposit").in("id", slice)
      .order("id", { ascending: true }).range(from, to), "deposit invoices"),
    collectForIds(creditedInvoiceIds, (slice, from, to) => service.from("invoices").select("id, project_id, metadata")
      .eq("org_id", orgId).in("id", slice).order("id", { ascending: true }).range(from, to), "credited invoices"),
  ]);
  const creditedContract = new Map(creditedInvoices.map((row) => [String(row.id), billedContract(row.project_id, row.metadata)]));
  const quietDocumentBasis = (projectId: unknown, contractId: string | null, date: string) => {
    if (typeof projectId !== "string") return invoiceRevenueBasis(null);
    try { return invoiceRevenueBasis(projectId, revenuePolicies.forDocument(projectId, contractId, date).method); } catch { return null; }
  };

  const candidates: ProjectionCandidate[] = [];
  const invoiceIncome = await loadInvoiceRevenueLines(orgId, [
    ...invoices.map(row => String(row.id)),
    ...adjustments.filter(row => row.status === "posted" && row.adjustment_type === "credit_memo" && quietDocumentBasis(row.project_id, creditedContract.get(String(row.invoice_id)) ?? null, String(row.effective_date)) !== "percentage_of_completion").map(row => String(row.invoice_id)),
  ]);
  const failures: ProjectionFailure[] = [];
  /**
   * How one invoice or credit earns revenue: the job's recorded policy on the
   * document's own date (a later change of billing settings cannot reach back),
   * or on invoice when it has no project. A policy that cannot be decided is a
   * finding on that document.
   */
  const documentPolicy = (sourceType: string, sourceId: string, projectId: unknown, contractId: string | null, date: string) => {
    if (typeof projectId !== "string") return { basis: invoiceRevenueBasis(null), policyId: null };
    try {
      const policy = revenuePolicies.forDocument(projectId, contractId, date);
      return { basis: invoiceRevenueBasis(projectId, policy.method), policyId: policy.source === "approved" ? policy.policyId : null };
    } catch (error) {
      failures.push({ sourceType, sourceId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  const fundingCode = (sourceType: string, sourceId: string, resolve: () => string) => {
    try { return resolve(); } catch (error) {
      failures.push({ sourceType, sourceId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  const touchedSourceKeys = new Set<string>();
  const liveSourceKeys = new Set<string>();
  const depositInvoiceIds = new Set([
    ...invoices
      .filter(
        (row) =>
          (row.metadata as { invoice_kind?: unknown } | null)?.invoice_kind ===
          "earnest_deposit",
      )
      .map((row) => String(row.id)),
    ...referencedDeposits.map((row) => String(row.id)),
  ]);

  // Only a zero-amount source is skipped. A negative one is a credit — a vendor
  // credit, an expense credit — that the cost subledger already carries signed,
  // so dropping it drives job cost out of balance with no failure to point at.
  for (const row of bills) {
    if (openingSources.bills.has(String(row.id))) continue;
    const sourceType =
      (row.metadata as { source?: unknown } | null)?.source ===
      "retainage_release"
        ? "retainage_release"
        : "vendor_bill";
    const sourceKey = factSourceKey(sourceType, String(row.id));
    touchedSourceKeys.add(sourceKey);
    if (
      !(PAYABLE_VENDOR_BILL_STATUSES as readonly string[]).includes(
        String(row.status),
      )
    )
      continue;
    const totalCents = Number(row.total_cents ?? 0);
    const useTaxCents = Number(row.use_tax_accrued_cents ?? 0);
    if (totalCents === 0) continue;
    liveSourceKeys.add(sourceKey);
    // A retainage-release payable carries no cost: the whole gross was expensed when
    // the original bill posted, and this bill only moves the withheld portion out of
    // `2010 Retainage payable` and into AP so it can be paid. Posting it as an ordinary
    // bill would debit job costs twice and leave 2010 growing forever.
    if (
      (row.metadata as { source?: unknown } | null)?.source ===
      "retainage_release"
    ) {
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
      });
      continue;
    }
    const subledgerLines = costLinesByBill.get(String(row.id)) ?? [];
    const subledgerTotal = subledgerLines.reduce(
      (sum, item) => sum + item.amount_cents,
      0,
    );
    // The subledger is authoritative for job cost, but it only drives the entry
    // when it fully accounts for the bill. A partially-coded bill falls back to
    // a single header line so the GL still balances; the nightly tie-out reports
    // the gap rather than the projector inventing detail it does not have.
    const costLines: FactCostLine[] =
      subledgerLines.length > 0 && subledgerTotal === totalCents + useTaxCents
        ? subledgerLines
        : [
            {
              amount_cents: totalCents + useTaxCents,
              project_id: row.project_id ? String(row.project_id) : null,
            },
          ];
    candidates.push({
      sourceType: "vendor_bill",
      sourceId: String(row.id),
      accountingDate: String(row.bill_date),
      occurredAt: String(row.updated_at),
      payload: {
        memo: `Vendor bill ${row.bill_number ?? ""}`.trim(),
        total_cents: totalCents,
        use_tax_accrued_cents: useTaxCents,
        retainage_cents: Number(row.retainage_cents ?? 0),
        project_id: row.project_id ?? null,
        company_id: row.company_id ?? null,
        cost_lines: costLines.map(item => { const code = inventoryCostAccount(inventoryPolicies.get(item.project_id ?? ""), String(row.bill_date), item.account_code); return code === (item.account_code ?? SYSTEM_ACCOUNT_CODES.jobCosts) ? item : { ...item, account_code: code }; }),
      },
    });
  }

  for (const row of invoices) {
    if (openingSources.invoices.has(String(row.id))) continue;
    if (depositInvoiceIds.has(String(row.id))) {
      // A deposit request is operationally an invoice so it can be collected in
      // the customer portal, but it is not AR or revenue. The receipt below is
      // the accounting event and credits the customer-deposit liability.
      touchedSourceKeys.add(factSourceKey("invoice", String(row.id)));
      continue;
    }
    const sourceType = releaseByInvoice.has(String(row.id))
      ? "retainage_release"
      : "invoice";
    const sourceKey = factSourceKey(sourceType, String(row.id));
    touchedSourceKeys.add(sourceKey);
    if (
      !(BILLED_INVOICE_STATUSES as readonly string[]).includes(
        String(row.status),
      )
    )
      continue;
    const totalCents = Number(row.total_cents ?? 0);
    const policy = sourceType === "invoice" ? documentPolicy("invoice", String(row.id), row.project_id, billedContract(row.project_id, row.metadata), String(row.issue_date)) : null;
    if (sourceType === "invoice" && !policy) { liveSourceKeys.add(sourceKey); continue; }
    if (sourceType === "retainage_release" ? totalCents === 0 : !invoiceHasAccountingPrincipal(totalCents, retainageByInvoice.get(String(row.id)) ?? 0, policy?.basis ?? "percentage_of_completion")) continue;
    liveSourceKeys.add(sourceKey);
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
      });
      continue;
    }
    if (!policy) continue;
    const basis = policy.basis;
    if (invoiceIncome.errors.has(String(row.id))) {
      failures.push({ sourceType: "invoice", sourceId: String(row.id), error: invoiceIncome.errors.get(String(row.id))! });
      continue;
    }
    const capturedRevision = invoiceIncome.sourceVersions.get(String(row.id));
    if (!capturedRevision || timestampMicros(capturedRevision) === null || timestampMicros(capturedRevision) !== timestampMicros(String(row.updated_at))) {
      failures.push({ sourceType: "invoice", sourceId: String(row.id), error: "Invoice changed while its income evidence was captured. Refresh posting to capture the current revision." });
      continue;
    }
    candidates.push({
      sourceType: "invoice",
      sourceId: String(row.id),
      accountingDate: String(row.issue_date),
      occurredAt: String(row.updated_at),
      payload: {
        memo: row.title || `Invoice ${row.invoice_number ?? ""}`.trim(),
        // Net of retainage, exactly as stored. `fact-drafts` rebuilds the gross.
        total_cents: totalCents,
        tax_cents: Number(row.tax_cents ?? 0),
        retainage_cents: retainageByInvoice.get(String(row.id)) ?? 0,
        project_id: row.project_id ?? null,
        revenue_basis: basis,
        ...(policy.policyId ? { revenue_policy_id: policy.policyId } : {}),
        revenue_lines: invoiceIncome.lines.get(String(row.id)) ?? [],
        ...(billedContract(row.project_id, row.metadata) ? { dimensions: { contract_id: billedContract(row.project_id, row.metadata) } } : {}),
      },
    });
  }

  const paymentAllocations = await loadPaymentAllocationEvidence(orgId, payments);
  for (const row of payments) {
    if (openingSources.payments.has(String(row.id))) continue;
    const metadata =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const isDepositReceipt =
      Boolean(row.invoice_id) && depositInvoiceIds.has(String(row.invoice_id));
    const isDepositApplication = metadata.customer_deposit_application === true;
    const allocationEvidence = paymentAllocations.evidence.get(String(row.id));
    const classification = classifyPaymentPosting({
      method: typeof row.method === "string" ? row.method : null,
      hasBill: Boolean(row.bill_id) || Boolean(allocationEvidence?.allocations[0].bill_id),
      hasInvoice: Boolean(row.invoice_id) || Boolean(allocationEvidence?.allocations[0].invoice_id),
      creditApplied: metadata.vendor_credit_applied === true,
    });
    const paymentIsLive = (POSTED_PAYMENT_STATUSES as readonly string[]).includes(
      String(row.status),
    );
    const paymentKeys = paymentProjectionSourceKeys(String(row.id));
    if (!paymentIsLive) for (const key of paymentKeys) touchedSourceKeys.add(key);
    if (paymentIsLive && paymentAllocations.errors.has(String(row.id))) {
      for (const key of paymentKeys) liveSourceKeys.add(key);
      failures.push({ sourceType: "payment", sourceId: String(row.id), error: paymentAllocations.errors.get(String(row.id))! });
      continue;
    }
    // A payment linked to neither a bill nor an invoice is not a customer
    // receipt — fee collections and standalone settlements land here. Guessing
    // would fabricate an AR credit, so it is reported instead of posted.
    if (classification.kind === "unpostable") {
      if (!paymentIsLive) continue;
      for (const key of paymentKeys) liveSourceKeys.add(key);
      failures.push({
        sourceType: "payment",
        sourceId: String(row.id),
        error: classification.reason,
      });
      continue;
    }
    const paymentSourceType = isDepositApplication
      ? "customer_deposit_application"
      : isDepositReceipt
        ? "customer_deposit_receipt"
        : classification.kind === "credit_application"
          ? row.bill_id
            ? "bill_payment"
            : "invoice_payment"
          : classification.kind;
    for (const possibleSourceType of [
      "bill_payment",
      "invoice_payment",
      "customer_deposit_receipt",
      "customer_deposit_application",
    ])
      touchedSourceKeys.add(factSourceKey(possibleSourceType, String(row.id)));
    const sourceKey = factSourceKey(paymentSourceType, String(row.id));
    touchedSourceKeys.add(sourceKey);
    if (!paymentIsLive) continue;
    // Applying a vendor credit moves no cash. The credit note is itself a
    // negative bill that already posted Dr AP / Cr cost, so the application only
    // nets AP against AP and has no journal entry of its own.
    if (classification.kind === "credit_application" && !isDepositApplication)
      continue;
    const amountCents = Number(row.amount_cents ?? 0);
    if (amountCents === 0) continue;
    liveSourceKeys.add(sourceKey);
    const accountingDate = accountingDateFromTimestamp(row.received_at);
    if (!accountingDate) {
      failures.push({
        sourceType: "payment",
        sourceId: String(row.id),
        error: "Payment has no readable received_at to date the entry",
      });
      continue;
    }
    // `fee_cents` is a rollup of the processor/platform split on rows that carry
    // both, so adding all three double-counts. Prefer the split when present.
    const splitFeeCents =
      Number(row.processor_fee_cents ?? 0) +
      Number(row.platform_fee_cents ?? 0);
    const feeCents =
      splitFeeCents > 0 ? splitFeeCents : Number(row.fee_cents ?? 0);
    const cashCode = paymentSourceType === "bill_payment" ? fundingCode(paymentSourceType, String(row.id), () => funding.resolve({ metadata, method: row.method })) : SYSTEM_ACCOUNT_CODES.operatingCash;
    if (!cashCode) continue;
    let settlementEvidence;
    try {
      if (allocationEvidence && (isDepositApplication || isDepositReceipt)) throw new Error("Deposit allocations require the deposit workflow");
      settlementEvidence = allocationEvidence ?? directSettlementEvidence({ paymentId: String(row.id), invoiceId: row.invoice_id, billId: row.bill_id });
    } catch (error) {
      failures.push({ sourceType: paymentSourceType, sourceId: String(row.id), error: `Payment document evidence is invalid: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    candidates.push({
      sourceType: paymentSourceType,
      sourceId: String(row.id),
      accountingDate,
      occurredAt: String(row.updated_at),
      payload: {
        memo:
          paymentSourceType === "bill_payment"
            ? "Vendor bill payment"
            : paymentSourceType === "customer_deposit_receipt"
              ? "Customer deposit received"
              : paymentSourceType === "customer_deposit_application"
                ? "Customer deposit applied"
                : "Customer payment",
        amount_cents: amountCents,
        gross_cents: Math.max(
          amountCents,
          Number(row.gross_cents ?? amountCents),
        ),
        fee_cents: feeCents,
        project_id: row.project_id ?? null,
        ...(paymentSourceType === "bill_payment" && cashCode !== SYSTEM_ACCOUNT_CODES.operatingCash ? { cash_account_code: cashCode } : {}),
        deposit_payment_id: metadata.deposit_payment_id ?? null,
        settlement_evidence: settlementEvidence,
      },
    });
  }

  for (const row of feeCharges) {
    const sourceKey = factSourceKey("ap_fee_charge", String(row.id));
    touchedSourceKeys.add(sourceKey);
    if (row.status !== "succeeded") continue;
    const amountCents = Number(row.amount_cents ?? 0);
    if (amountCents <= 0) continue;
    liveSourceKeys.add(sourceKey);
    const accountingDate = accountingDateFromTimestamp(row.settled_at);
    if (!accountingDate) {
      failures.push({ sourceType: "ap_fee_charge", sourceId: String(row.id), error: "Settled AP fee charge has no readable settled_at" });
      continue;
    }
    const cashCode = fundingCode("ap_fee_charge", String(row.id), () => funding.resolve({ fundingSourceId: row.funding_source_id }));
    if (!cashCode) continue;
    candidates.push({
      sourceType: "ap_fee_charge",
      sourceId: String(row.id),
      accountingDate,
      occurredAt: String(row.updated_at),
      payload: { memo: "Arc Pay fees", amount_cents: amountCents, ...(cashCode !== SYSTEM_ACCOUNT_CODES.operatingCash ? { cash_account_code: cashCode } : {}) },
    });
  }

  for (const row of expenses) {
    const sourceKey = factSourceKey("expense", String(row.id));
    touchedSourceKeys.add(sourceKey);
    if (!(POSTED_EXPENSE_STATUSES as readonly string[]).includes(String(row.status))) continue;
    const amountCents =
      Number(row.amount_cents ?? 0) + Number(row.tax_cents ?? 0);
    if (amountCents === 0) continue;
    liveSourceKeys.add(sourceKey);
    const subledgerLines = costLinesByExpense.get(String(row.id)) ?? [];
    const subledgerTotal = subledgerLines.reduce(
      (sum, item) => sum + item.amount_cents,
      0,
    );
    const costLines: FactCostLine[] =
      subledgerLines.length > 0 && subledgerTotal === amountCents
        ? subledgerLines
        : [
            {
              amount_cents: amountCents,
              project_id: row.project_id ? String(row.project_id) : null,
            },
          ];
    const paymentCode = row.payment_method === "reimbursable_personal" ? SYSTEM_ACCOUNT_CODES.employeeReimbursements : fundingCode("expense", String(row.id), () => funding.resolve({ metadata: row.metadata, method: row.payment_method }));
    if (!paymentCode) continue;
    candidates.push({
      sourceType: "expense",
      sourceId: String(row.id),
      accountingDate: String(row.expense_date),
      occurredAt: String(row.updated_at),
      payload: {
        memo: row.description || "Expense",
        amount_cents: amountCents,
        project_id: row.project_id ?? null,
        ...(paymentCode !== SYSTEM_ACCOUNT_CODES.operatingCash ? { payment_account_code: paymentCode } : {}),
        vendor_company_id: row.vendor_company_id ?? null,
        cost_lines: costLines.map(item => { const code = inventoryCostAccount(inventoryPolicies.get(item.project_id ?? ""), String(row.expense_date), item.account_code); return code === (item.account_code ?? SYSTEM_ACCOUNT_CODES.jobCosts) ? item : { ...item, account_code: code }; }),
      },
    });
  }

  for (const row of reversals) {
    const depositReversal =
      Boolean(row.invoice_id) && depositInvoiceIds.has(String(row.invoice_id));
    const reversalSourceType = depositReversal
      ? "customer_deposit_reversal"
      : "payment_reversal";
    touchedSourceKeys.add(factSourceKey("payment_reversal", String(row.id)));
    touchedSourceKeys.add(
      factSourceKey("customer_deposit_reversal", String(row.id)),
    );
    const sourceKey = factSourceKey(reversalSourceType, String(row.id));
    touchedSourceKeys.add(sourceKey);
    if (row.status !== "succeeded") continue;
    const amountCents = Number(row.amount_cents ?? 0);
    if (amountCents === 0) continue;
    liveSourceKeys.add(sourceKey);
    const accountingDate = accountingDateFromTimestamp(row.occurred_at);
    if (!accountingDate) {
      failures.push({
        sourceType: reversalSourceType,
        sourceId: String(row.id),
        error: "Reversal has no readable occurred_at to date the entry",
      });
      continue;
    }
    // `payment_reversals` carries a DB check that exactly one of invoice_id and
    // bill_id is set, so the side is unambiguous here.
    const hasBill = Boolean(row.bill_id);
    const cashCode = hasBill ? fundingCode(reversalSourceType, String(row.id), () => funding.reversal(String(row.payment_id))) : SYSTEM_ACCOUNT_CODES.undepositedFunds;
    if (!cashCode) continue;
    let settlementEvidence;
    try {
      settlementEvidence = directSettlementEvidence({ paymentId: String(row.payment_id), invoiceId: row.invoice_id, billId: row.bill_id });
    } catch (error) {
      failures.push({ sourceType: reversalSourceType, sourceId: String(row.id), error: `Reversal document evidence is invalid: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    candidates.push({
      sourceType: reversalSourceType,
      sourceId: String(row.id),
      accountingDate,
      occurredAt: String(row.updated_at),
      payload: {
        memo: depositReversal
          ? "Customer deposit refunded"
          : hasBill
            ? "Vendor payment returned"
            : "Customer payment reversed",
        amount_cents: amountCents,
        ...(hasBill && cashCode !== SYSTEM_ACCOUNT_CODES.operatingCash ? { cash_account_code: cashCode } : {}),
        side: hasBill ? "bill_payment" : "invoice_payment",
        project_id: row.project_id ?? null,
        settlement_evidence: settlementEvidence,
      },
    });
  }

  for (const row of adjustments) {
    const sourceKey = factSourceKey("receivable_adjustment", String(row.id));
    touchedSourceKeys.add(sourceKey);
    if (row.status !== "posted") continue;
    const amountCents = Number(row.amount_cents ?? 0);
    if (amountCents <= 0) continue;
    liveSourceKeys.add(sourceKey);
    const adjustmentPolicy = documentPolicy("receivable_adjustment", String(row.id), row.project_id, creditedContract.get(String(row.invoice_id)) ?? null, String(row.effective_date));
    if (!adjustmentPolicy) continue;
    const basis = adjustmentPolicy.basis;
    let revenueLines: ReturnType<typeof allocateInvoiceRevenue> | undefined;
    if (basis !== "percentage_of_completion" && row.adjustment_type === "credit_memo") {
      try {
        const error = invoiceIncome.errors.get(String(row.invoice_id));
        if (error) throw new Error(error);
        revenueLines = allocateInvoiceRevenue(amountCents - Number(row.tax_cents ?? 0), invoiceIncome.lines.get(String(row.invoice_id)) ?? []);
      } catch (error) {
        failures.push({ sourceType: "receivable_adjustment", sourceId: String(row.id), error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    candidates.push({
      sourceType: "receivable_adjustment",
      sourceId: String(row.id),
      accountingDate: String(row.effective_date),
      occurredAt: String(row.updated_at),
      payload: {
        memo: `${row.adjustment_type === "write_off" ? "Write-off" : "Credit memo"}: ${row.reason}`,
        amount_cents: amountCents,
        tax_cents: Number(row.tax_cents ?? 0),
        adjustment_type: row.adjustment_type,
        project_id: row.project_id ?? null,
        invoice_id: row.invoice_id,
        revenue_basis: basis,
        ...(adjustmentPolicy.policyId ? { revenue_policy_id: adjustmentPolicy.policyId } : {}),
        ...(revenueLines?.length ? { revenue_lines: revenueLines } : {}),
        ...(creditedContract.get(String(row.invoice_id)) ? { dimensions: { contract_id: creditedContract.get(String(row.invoice_id)) } } : {}),
      },
    });
  }

  for (const row of laborEntries) {
    const sourceKey = factSourceKey("labor_cost", String(row.id));
    touchedSourceKeys.add(sourceKey);
    if (row.status !== "posted") continue;
    const amountCents = Number(row.cost_cents ?? 0);
    if (amountCents === 0) continue;
    const laborBasis = laborBasisFromJobCost(orgId,row as unknown as Record<string,unknown>);
    liveSourceKeys.add(sourceKey);
    candidates.push({
      sourceType: "labor_cost",
      sourceId: String(row.id),
      accountingDate: String(row.incurred_on),
      occurredAt: String(row.updated_at),
      payload: {
        memo: "Field labor",
        ...(laborBasis ? {labor_basis:laborBasis} : {}),
        dimensions: { cost_type: "labor", ...(row.cost_code_id ? { cost_code_id: row.cost_code_id } : {}) },
        ...(inventoryCostAccount(inventoryPolicies.get(String(row.project_id)), String(row.incurred_on), SYSTEM_ACCOUNT_CODES.laborCosts) !== SYSTEM_ACCOUNT_CODES.laborCosts ? { cost_account_code: inventoryCostAccount(inventoryPolicies.get(String(row.project_id)), String(row.incurred_on), SYSTEM_ACCOUNT_CODES.laborCosts) } : {}),
        amount_cents: amountCents,
        project_id: row.project_id ?? null,
      },
    });
  }

  const retirementSourceKeys = new Set(
    [...touchedSourceKeys].filter(
      (sourceKey) => !liveSourceKeys.has(sourceKey),
    ),
  );
  for (const candidate of candidates) {
    const evidence = candidate.payload.settlement_evidence as { allocations?: Array<{ project_id: string | null }> } | undefined;
    const ids = new Set([candidate.payload.project_id, ...(evidence?.allocations?.map(row => row.project_id) ?? []), ...(Array.isArray(candidate.payload.cost_lines) ? candidate.payload.cost_lines.map((line: FactCostLine) => line.project_id) : [])].filter((id): id is string => typeof id === "string"));
    const captured = Object.fromEntries([...ids].filter(id => projectDimensions.has(id)).map(id => [id, projectDimensions.get(id)]));
    if (Object.keys(captured).length) candidate.payload.project_dimensions = captured;
  }
  // How far this run read, per family: the next run's cursor.
  const latest = (rows: Array<{ updated_at?: unknown }>) => rows.reduce<string | null>((max, row) => {
    const at = row.updated_at == null ? null : String(row.updated_at);
    return at && (max === null || !isAtOrAfter(max, at)) ? at : max;
  }, null);
  const observed: ByFamily<string | null> = {
    bills: latest(bills), invoices: latest(invoices), payments: latest(payments), feeCharges: latest(feeCharges),
    expenses: latest(expenses), reversals: latest(reversals), adjustments: latest(adjustments), labor: latest(laborEntries),
  };
  return { candidates, failures, retirementSourceKeys, liveSourceKeys, observed, unrecordedPolicies: revenuePolicies.unrecorded() };
}

const factRowSchema = z.object({
  id: z.string().uuid(),
  payload_hash: z.string(),
  payload: z.record(z.unknown()),
  accounting_date: z.string(),
  source_version: z.number().int(),
});

const priorFactSchema = factCheckSchema.extend({ payload_hash: z.string() });

type PriorProjection = {
  fact: z.infer<typeof priorFactSchema> | null;
  /** The posted journal of `fact`, if it still stands. */
  journalId: string | null;
  receipt: { factId: string; observedAt: string } | null;
};

/**
 * What the ledger already holds for the selected sources, read in bulk: each
 * source's latest fact, whether that fact's journal is still posted, and its
 * receipt. An unchanged source with a standing journal then costs no call.
 */
async function loadPriorProjections(orgId: string, candidates: ProjectionCandidate[]) {
  const service = createServiceSupabaseClient();
  const sourceTypes = [...new Set(candidates.map((candidate) => candidate.sourceType))];
  const sourceIds = candidates.map((candidate) => candidate.sourceId);
  const [facts, receipts] = await Promise.all([
    collectForIds(sourceIds, (slice, from, to) => service.from("accounting_facts")
      .select(`${FACT_CHECK_COLUMNS}, payload_hash`)
      .eq("org_id", orgId).in("source_type", sourceTypes).in("source_id", slice)
      .order("id", { ascending: true }).range(from, to), "accounting facts"),
    collectForIds(sourceIds, (slice, from, to) => service.from("books_projection_receipts")
      .select("id, source_type, source_id, fact_id, source_observed_at")
      .eq("org_id", orgId).in("source_type", sourceTypes).in("source_id", slice)
      .order("id", { ascending: true }).range(from, to), "projection receipts"),
  ]);
  const latest = new Map<string, z.infer<typeof priorFactSchema>>();
  for (const row of facts) {
    const fact = priorFactSchema.parse(row);
    const key = factSourceKey(fact.source_type, fact.source_id);
    const current = latest.get(key);
    if (!current || fact.source_version > current.source_version) latest.set(key, fact);
  }
  const journals = await collectForIds([...latest.values()].map((fact) => fact.id), (slice, from, to) => service.from("journal_entries")
    .select("id, fact_id").eq("org_id", orgId).eq("status", "posted").in("fact_id", slice)
    .order("id", { ascending: true }).range(from, to), "posted journals");
  const journalByFact = new Map(journals.map((row) => [String(row.fact_id), String(row.id)]));
  const receiptByKey = new Map(receipts.map((row) => [factSourceKey(String(row.source_type), String(row.source_id)), { factId: String(row.fact_id), observedAt: String(row.source_observed_at) }]));
  return new Map<string, PriorProjection>(candidates.map((candidate) => {
    const key = factSourceKey(candidate.sourceType, candidate.sourceId);
    const fact = latest.get(key) ?? null;
    return [key, { fact, journalId: fact ? journalByFact.get(fact.id) ?? null : null, receipt: receiptByKey.get(key) ?? null }];
  }));
}

/** True when `later` is the same instant as `earlier` or after it, to the microsecond. */
function isAtOrAfter(later: string, earlier: string) {
  const a = timestampMicros(later), b = timestampMicros(earlier);
  return a !== null && b !== null && a >= b;
}

/**
 * Project one source transition as a single database transaction. The RPC owns
 * concurrency, prior-entry reversal, immutable fact insertion and replacement
 * posting; a worker crash can no longer expose a half-revised official ledger.
 */
/**
 * Project tags kept as posted: where a job sits in the org, and the contract it
 * had when the document posted. A later second contract does not unbill an
 * earlier invoice from the only contract it could have billed.
 */
const REPORTING_TAG_KEYS = ["division_id", "division_name", "community_id", "community_name", "lot_id", "lot_name", "contract_id"];

/** The payload with each project's reporting tags as the posted fact recorded them. */
function withPostedReportingTags(payload: Record<string, unknown>, posted: Record<string, unknown>) {
  const current = payload.project_dimensions;
  const recorded = posted.project_dimensions;
  if (!current || typeof current !== "object" || !recorded || typeof recorded !== "object") return payload;
  const merged = Object.fromEntries(Object.entries(current as Record<string, Record<string, unknown>>).map(([projectId, dimensions]) => {
    const was = (recorded as Record<string, Record<string, unknown> | undefined>)[projectId];
    if (!was) return [projectId, dimensions];
    const kept = Object.fromEntries(Object.entries(dimensions).filter(([key]) => !REPORTING_TAG_KEYS.includes(key)));
    for (const key of REPORTING_TAG_KEYS) if (key in was) kept[key] = was[key];
    return [projectId, kept];
  }));
  return { ...payload, project_dimensions: merged };
}

/**
 * What the ledger should hold for a source given its latest fact: the payload
 * (legacy facts keep the shape they were posted with), its revision identity and
 * the journal draft. Pure, so posting and the narrowed proof decide alike.
 */
function prepareCandidate(orgId: string, candidate: ProjectionCandidate, policyVersion: number, projectionVersion: number, existing: z.infer<typeof factRowSchema> | null) {
  let payload = preserveLegacyLaborPayload(candidate.sourceType, candidate.accountingDate, candidate.payload, existing);
  payload = preserveLegacyDimensionPayload(candidate.sourceType, candidate.accountingDate, preserveLegacySettlementPayload(candidate.sourceType, candidate.accountingDate, preserveLegacyInvoiceIncomePayload(candidate.sourceType, candidate.accountingDate, payload, existing), existing), existing);
  const identify = (candidatePayload: Record<string, unknown>) => factTransitionIdentity({
    orgId, sourceType: candidate.sourceType, sourceId: candidate.sourceId,
    accountingDate: candidate.accountingDate,
    payload: hashableFactPayload(candidate.sourceType, candidatePayload), previous: existing,
  });
  let identity = identify(payload);
  // Reporting tags stay as posted (B07): a project moving to another division,
  // community or lot does not restate what it already posted. When the tags are
  // the only difference from the posted fact, the posted tags are kept and the
  // source is unchanged; a real revision posts with the current tags.
  if (existing && identity.payloadHash !== existing.payload_hash) {
    const asPosted = withPostedReportingTags(payload, existing.payload);
    if (asPosted !== payload) {
      const postedIdentity = identify(asPosted);
      if (postedIdentity.payloadHash === existing.payload_hash) {
        payload = asPosted;
        identity = postedIdentity;
      }
    }
  }
  const { sourceVersion, payloadHash, idempotencyKey } = identity;
  const journal = draftFromFact({
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    accountingDate: candidate.accountingDate,
    payload,
    sourceVersion,
    projectionVersion,
    policyVersion,
  });
  if (!journal) throw new Error(`No posting rule covers ${candidate.sourceType}`);
  return { sourceVersion, payloadHash, idempotencyKey, payload, draft: journal };
}

async function projectCandidateAtomically(
  orgId: string,
  candidate: ProjectionCandidate,
  policyVersion: number,
  projectionVersion: number,
  prior: PriorProjection,
): Promise<
  | { kind: "current" }
  | { kind: "receipt"; factId: string; journalId: string }
  | ({ kind: "projected" } & Awaited<ReturnType<typeof projectBooksFactAndJournalForService>>)
> {
  const existing = prior.fact;
  const { sourceVersion, payloadHash, idempotencyKey, payload, draft } = prepareCandidate(orgId, candidate, policyVersion, projectionVersion, existing);
  candidate = { ...candidate, payload };
  // The same economics with its journal still standing is exactly what the RPC
  // would leave alone; only the receipt may need to follow the newer revision.
  if (existing && payloadHash === existing.payload_hash && prior.journalId) {
    return prior.receipt?.factId === existing.id && isAtOrAfter(prior.receipt.observedAt, candidate.occurredAt)
      ? { kind: "current" }
      : { kind: "receipt", factId: existing.id, journalId: prior.journalId };
  }
  const projection = await projectBooksFactAndJournalForService({
    orgId,
    expectedFactId: existing?.id ?? null,
    fact: {
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      sourceVersion,
      factKind: `${candidate.sourceType}.recognized`,
      occurredAt: candidate.occurredAt,
      accountingDate: candidate.accountingDate,
      payload: candidate.payload,
      payloadHash,
      policyVersion,
      idempotencyKey,
    },
    draft,
    reversalReason: `${candidate.sourceType} was revised after posting`,
  });
  return { kind: "projected", ...projection };
}

const retirableFactRowSchema = z.object({
  id: z.string().uuid(),
  source_type: z.string(),
  source_id: z.string().uuid(),
  source_version: z.number().int(),
  fact_kind: z.string(),
  accounting_date: z.string(),
  occurred_at: z.string(),
});

type RetirableFactRow = z.infer<typeof retirableFactRowSchema>;

/**
 * Un-posts the sources that left.
 *
 * `projectionCandidates` enumerates what CURRENTLY qualifies, so an invoice
 * voided after it posted, a bill moved to `rejected`, or a row deleted upstream
 * simply stops appearing — and its journal entry stands forever, with the AR or
 * AP tie-out red and no cure. This is the other half: reverse the entry, then
 * append a retirement fact so the source is never posted again.
 *
 * A full pass compares the complete live set. An incremental pass supplies an
 * explicit `onlySourceKeys` set made from changed rows that no longer qualify;
 * absence outside that set is never interpreted as departure.
 *
 * Re-running is safe. The reversal's posting key is derived from the entry id,
 * the fact's own accounting date and a constant reason, so a second reversal
 * collides with the first and does nothing; and the retirement fact makes the
 * source skip the scan entirely on every later pass. A source that comes back
 * supersedes the retirement fact through the ordinary path and posts again.
 */
async function retireDepartedSources(
  orgId: string,
  liveSourceKeys: ReadonlySet<string>,
  policyVersion: number,
  onlySourceKeys?: ReadonlySet<string>,
) {
  const service = createServiceSupabaseClient();
  const rows = await collectPages(
    (from, to) =>
      service
        .from("accounting_facts")
        .select(
          "id, source_type, source_id, source_version, fact_kind, accounting_date, occurred_at",
        )
        .eq("org_id", orgId)
        .in("source_type", [...PROJECTED_SOURCE_TYPES])
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    "accounting facts for retirement",
  );
  const latestBySource = new Map<string, RetirableFactRow>();
  for (const raw of rows) {
    const row = retirableFactRowSchema.parse(raw);
    const key = factSourceKey(row.source_type, row.source_id);
    const current = latestBySource.get(key);
    if (!current || row.source_version > current.source_version)
      latestBySource.set(key, row);
  }

  const latestFacts = Array.from(latestBySource.values()).filter(
    (row) =>
      !onlySourceKeys ||
      onlySourceKeys.has(factSourceKey(row.source_type, row.source_id)),
  );
  const departed = selectFactsToRetire(
    latestFacts.map((row) => ({
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceVersion: row.source_version,
      factKind: row.fact_kind,
      row,
    })),
    liveSourceKeys,
  );

  const failures: ProjectionFailure[] = [];
  let retired = 0;
  for (const fact of departed) {
    try {
      const { data: postedEntries, error: postedError } = await service
        .from("journal_entries")
        .select("id")
        .eq("org_id", orgId)
        .eq("fact_id", fact.row.id)
        .eq("status", "posted");
      if (postedError)
        throw new Error(
          `Failed to load the retired journal entry: ${postedError.message}`,
        );
      for (const entry of postedEntries ?? []) {
        await reverseBooksJournalEntryForService({
          entryId: String(entry.id),
          // The fact's own date, not today's: it is the only value that stays the
          // same on every re-run, which is what makes the reversal idempotent.
          reversalDate: fact.row.accounting_date,
          reason: RETIREMENT_REASON,
          orgId,
        });
      }
      const payload = retirementFactPayload(fact.sourceVersion);
      const payloadHash = booksDigest(
        hashableFactPayload("retirement", payload),
      );
      const { error: insertError } = await service
        .from("accounting_facts")
        .insert({
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
          idempotency_key: booksDigest({
            orgId,
            sourceType: fact.sourceType,
            sourceId: fact.sourceId,
            payloadHash,
          }),
        });
      if (insertError)
        throw new Error(
          `Failed to record the retirement fact: ${insertError.message}`,
        );
      await recordEvent({
        orgId,
        eventType: "books.projection_source_retired",
        entityType: fact.sourceType,
        entityId: fact.sourceId,
        payload: {
          retired_fact_id: fact.row.id,
          retired_version: fact.sourceVersion,
          entries_reversed: (postedEntries ?? []).length,
        },
      });
      retired += 1;
    } catch (retirementError) {
      failures.push({
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
        error:
          retirementError instanceof Error
            ? retirementError.message
            : String(retirementError),
      });
    }
  }
  return { retired, failures };
}

/**
 * The rule-set version the ledger is projected under. Approving a new
 * `accounting_policies` version re-projects every source into a parallel set of
 * entries the verifier can compare before the old version is retired.
 */
export async function resolveProjectionVersion(orgId: string) {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("accounting_policies")
    .select("version")
    .eq("org_id", orgId)
    .eq("status", "approved")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error)
    throw new Error(
      `Failed to resolve the projection version: ${error.message}`,
    );
  return data?.version ? Number(data.version) : 1;
}

export async function projectJournal(
  orgId: string,
  options: { full?: boolean; sourceKeys?: string[] } = {},
) {
  const service = createServiceSupabaseClient();
  const { data: settings, error } = await service
    .from("books_settings")
    .select("workspace_enabled, arc_ledger_mode, active_policy_version")
    .eq("org_id", orgId)
    .single();
  if (error) throw new Error(`Failed to load Books settings: ${error.message}`);
  if (!settings.workspace_enabled || settings.arc_ledger_mode === "disabled") {
    return {
      projected: 0,
      skipped: 0,
      revised: 0,
      retired: 0,
      failures: [] as ProjectionFailure[],
      fullScanCompleted: false,
      evaluatedSourceKeys: [] as string[],
    };
  }

  const policyVersion = Number(settings.active_policy_version);
  const projectionVersion = await resolveProjectionVersion(orgId);
  // When this run began reading: the next run's late-commit window ends here.
  const readStartedAt = new Date().toISOString();
  const everything: ProjectionWatermarks = { bills: null, invoices: null, payments: null, feeCharges: null, expenses: null, reversals: null, adjustments: null, labor: null };
  const watermarks = options.full ? everything : options.sourceKeys ? watermarksForSources(options.sourceKeys) : await resolveWatermarks(orgId);
  const { candidates, failures: candidateFailures, retirementSourceKeys, liveSourceKeys, observed, unrecordedPolicies } =
    await projectionCandidates(orgId, watermarks);
  // The revenue policy each job was posted under is recorded the first time,
  // so a later change of its billing settings cannot rewrite how it earned.
  await recordInferredRevenuePolicies(orgId, unrecordedPolicies);

  const requestedKeys = options.sourceKeys ? new Set(options.sourceKeys) : null;
  const failures = candidateFailures.filter((row) => !requestedKeys || requestedKeys.has(factSourceKey(row.sourceType, row.sourceId)));
  const evaluatedSourceKeys = new Set<string>(failures.map(row => factSourceKey(row.sourceType, row.sourceId)));
  const selected = requestedKeys ? candidates.filter((candidate) => requestedKeys.has(factSourceKey(candidate.sourceType, candidate.sourceId))) : candidates;
  const priors = await loadPriorProjections(orgId, selected);
  let projected = 0;
  let skipped = 0;
  let revised = 0;
  for (const candidate of selected) {
    const key = factSourceKey(candidate.sourceType, candidate.sourceId);
    evaluatedSourceKeys.add(key);
    try {
      const outcome = await projectCandidateAtomically(
        orgId,
        candidate,
        policyVersion,
        projectionVersion,
        priors.get(key) ?? { fact: null, journalId: null, receipt: null },
      );
      if (outcome.kind !== "current") {
        const { error: receiptError } = await service.rpc("record_books_projection_receipt", {
          p_org_id: orgId, p_source_type: candidate.sourceType, p_source_id: candidate.sourceId,
          p_source_observed_at: candidate.occurredAt, p_fact_id: outcome.factId, p_journal_id: outcome.journalId,
        });
        if (receiptError) throw new Error(`Journal recorded but posting verification could not be saved: ${receiptError.message}`);
      }
      if (outcome.kind === "projected" && outcome.superseded) revised += 1;
      if (outcome.kind === "projected" && (outcome.created || outcome.journalCreated)) projected += 1;
      else skipped += 1;
    } catch (projectionError) {
      failures.push({
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        error:
          projectionError instanceof Error
            ? projectionError.message
            : String(projectionError),
      });
    }
  }

  let retired = 0;
  if (options.full && !requestedKeys) {
    // Sources that could not resolve coding remain live. A failed projection is
    // never permission to retire the source's existing economic history.
    const retirement = await retireDepartedSources(
      orgId,
      liveSourceKeys,
      policyVersion,
    );
    retired = retirement.retired;
    failures.push(...retirement.failures);
  } else if (!requestedKeys && retirementSourceKeys.size > 0) {
    // Incremental rows include lifecycle changes even after they leave the
    // projectable status set, so voids/rejections retire immediately. A source
    // with a posted journal cannot be deleted (books_guard_posted_source_delete),
    // so a deletion never leaves money behind waiting for the nightly pass.
    const retirement = await retireDepartedSources(
      orgId,
      new Set<string>(),
      policyVersion,
      retirementSourceKeys,
    );
    retired = retirement.retired;
    failures.push(...retirement.failures);
    for (const key of retirementSourceKeys) evaluatedSourceKeys.add(key);
  }
  const inventoryPolicies = await loadInventoryPolicies(orgId);
  const requestedProjects = requestedKeys ? new Set(candidates.filter(candidate => requestedKeys.has(factSourceKey(candidate.sourceType, candidate.sourceId))).flatMap(candidate => {
    const lines = Array.isArray(candidate.payload.cost_lines) ? candidate.payload.cost_lines as FactCostLine[] : [];
    return [candidate.payload.project_id, ...lines.map(line => line.project_id)].filter((id): id is string => typeof id === "string");
  })) : null;
  for (const [projectId, policy] of inventoryPolicies) {
    if (requestedProjects && !requestedProjects.has(projectId)) continue;
    const date = policy.soldOn ?? policy.completedOn;
    if (!date || !policy.evidenceUrl) continue;
    evaluatedSourceKeys.add(factSourceKey("inventory_cost_relief", projectId));
    try {
      await transitionInventoryForService({ orgId, projectId, transition: policy.soldOn ? "sale_relief" : "completion", date, evidenceUrl: policy.evidenceUrl });
    } catch (error) {
      failures.push({ sourceType: "inventory_cost_relief", sourceId: projectId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  failures.push(...await reconcileWarrantyRecoveriesForService(orgId, requestedProjects));
  for (const failure of failures) evaluatedSourceKeys.add(factSourceKey(failure.sourceType, failure.sourceId));
  // A run over every changed source moves the cursor to what it read. A run for
  // chosen sources leaves it: it did not read the rest.
  if (!requestedKeys) {
    const { error: progressError } = await service.rpc("complete_books_projection_run", {
      p_org_id: orgId, p_cursors: Object.fromEntries(Object.entries(observed).filter(([, at]) => at !== null)), p_full: options.full === true, p_read_started_at: readStartedAt,
    });
    if (progressError) throw new Error(`Failed to record projection progress: ${progressError.message}`);
  }
  return { projected, skipped, revised, retired, failures, evaluatedSourceKeys: [...evaluatedSourceKeys], fullScanCompleted: options.full === true && !requestedKeys };
}

/**
 * A read-only proof that the ledger holds what chosen sources say it should,
 * without reading the rest of the ledger.
 *
 * For each source it rebuilds the fact the projector would write and checks: a
 * fact exists (`missing_fact`), it matches the source now (`stale_fact`), its
 * journal stands (`missing_journal`) and equals the journal rebuilt from the fact
 * (`journal_divergence`, by the same check as the full rebuild drill). It also
 * finds journals that should not stand: one posted with no fact behind it
 * (`unexpected_journal`), one from a superseded fact (`superseded_journal`), and
 * one left behind by a source that no longer qualifies (`retained_journal`).
 *
 * Scope is either chosen source keys, or every source whose row, fact or journal
 * changed since a time — the nightly proof between full drills.
 */
export async function proveProjectedSources(orgId: string, scope: { sourceKeys: string[] } | { changedSince: string }) {
  const service = createServiceSupabaseClient();
  const { data: settings, error } = await service.from("books_settings").select("workspace_enabled, arc_ledger_mode, active_policy_version").eq("org_id", orgId).single();
  if (error) throw new Error(`Failed to load Books settings: ${error.message}`);
  if (!settings.workspace_enabled || settings.arc_ledger_mode === "disabled") return { sourcesChecked: 0, differences: [] as LedgerDifference[] };
  const policyVersion = Number(settings.active_policy_version);
  const projectionVersion = await resolveProjectionVersion(orgId);

  let watermarks: ProjectionWatermarks;
  let scopeKeys: Set<string>;
  if ("sourceKeys" in scope) {
    scopeKeys = new Set(scope.sourceKeys);
    watermarks = watermarksForSources(scope.sourceKeys);
  } else {
    // A fact or journal can change without its source row: a late projection, a
    // reversal. Those sources are read by id beside every row changed since.
    const [facts, entries] = await Promise.all([
      collectByKey((afterId) => {
        let query = service.from("accounting_facts").select("id, source_type, source_id").eq("org_id", orgId).gte("created_at", scope.changedSince);
        if (afterId) query = query.gt("id", afterId);
        return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
      }, "changed facts"),
      // Journals are immutable; a reversal is a new entry pointing at the one it reverses.
      collectByKey((afterId) => {
        let query = service.from("journal_entries").select("id, source_type, source_id, reversal_of_entry_id").eq("org_id", orgId).gte("created_at", scope.changedSince);
        if (afterId) query = query.gt("id", afterId);
        return query.order("id", { ascending: true }).limit(PROJECTION_PAGE_SIZE);
      }, "new journals"),
    ]);
    const reversed = await collectForIds(entries.filter((row) => !row.source_id && row.reversal_of_entry_id).map((row) => String(row.reversal_of_entry_id)), (slice, from, to) => service.from("journal_entries")
      .select("id, source_type, source_id").eq("org_id", orgId).not("source_id", "is", null).in("id", slice).order("id", { ascending: true }).range(from, to), "reversed journals");
    scopeKeys = new Set([...facts, ...entries.filter((row) => row.source_id), ...reversed].map((row) => factSourceKey(String(row.source_type), String(row.source_id))));
    const byId = watermarksForSources([...scopeKeys]);
    const since = (family: ReadFrom): ReadFrom => (family && "ids" in family ? { at: scope.changedSince, inclusive: true, retryIds: family.ids } : null);
    watermarks = {
      bills: since(byId.bills), invoices: since(byId.invoices), payments: since(byId.payments), feeCharges: since(byId.feeCharges),
      expenses: since(byId.expenses), reversals: since(byId.reversals), adjustments: since(byId.adjustments), labor: since(byId.labor),
    };
  }

  const { candidates, failures, retirementSourceKeys } = await projectionCandidates(orgId, watermarks);
  const inScope = (key: string) => !("sourceKeys" in scope) || scopeKeys.has(key);
  const selected = candidates.filter((candidate) => inScope(factSourceKey(candidate.sourceType, candidate.sourceId)));
  const liveKeys = new Set(selected.map((candidate) => factSourceKey(candidate.sourceType, candidate.sourceId)));
  if (!("sourceKeys" in scope)) for (const key of retirementSourceKeys) scopeKeys.add(key);
  for (const candidate of selected) scopeKeys.add(factSourceKey(candidate.sourceType, candidate.sourceId));

  const differences: LedgerDifference[] = failures
    .filter((failure) => inScope(factSourceKey(failure.sourceType, failure.sourceId)))
    .map((failure) => ({ type: "unprojectable", source_type: failure.sourceType, source_id: failure.sourceId, message: failure.error }));
  const priors = await loadPriorProjections(orgId, selected);
  const standing: z.infer<typeof factCheckSchema>[] = [];
  for (const candidate of selected) {
    const prior = priors.get(factSourceKey(candidate.sourceType, candidate.sourceId));
    const where = { source_type: candidate.sourceType, source_id: candidate.sourceId };
    if (!prior?.fact) { differences.push({ type: "missing_fact", ...where }); continue; }
    if (prepareCandidate(orgId, candidate, policyVersion, projectionVersion, prior.fact).payloadHash !== prior.fact.payload_hash) { differences.push({ type: "stale_fact", fact_id: prior.fact.id, ...where }); continue; }
    if (!prior.journalId) { differences.push({ type: "missing_journal", fact_id: prior.fact.id, ...where }); continue; }
    standing.push(prior.fact);
  }
  for (const slice of chunk(standing, PROJECTION_ID_CHUNK)) differences.push(...(await checkFactJournals(orgId, slice, projectionVersion)).differences);

  // Every posted journal that names a source in scope must be its latest fact's.
  const latestFact = new Map([...priors].map(([key, prior]) => [key, prior.fact?.id ?? null]));
  const scopedIds = [...new Set([...scopeKeys].map((key) => key.slice(key.indexOf(":") + 1)))];
  const posted = await collectForIds(scopedIds, (slice, from, to) => service.from("journal_entries")
    .select("id, source_type, source_id, fact_id, entry_kind").eq("org_id", orgId).eq("status", "posted").in("source_id", slice)
    .order("id", { ascending: true }).range(from, to), "posted journals in scope");
  for (const entry of posted) {
    const key = factSourceKey(String(entry.source_type), String(entry.source_id));
    if (!scopeKeys.has(key)) continue;
    const where = { entry_id: entry.id, source_type: entry.source_type, source_id: entry.source_id };
    if (!entry.fact_id) { if (entry.entry_kind === "operational") differences.push({ type: "unexpected_journal", ...where }); continue; }
    if (!liveKeys.has(key)) differences.push({ type: "retained_journal", ...where });
    else if (latestFact.get(key) !== entry.fact_id) differences.push({ type: "superseded_journal", ...where });
  }
  return { sourcesChecked: scopeKeys.size, differences };
}

/**
 * Every Books company, least recently completed first, until `deadline`.
 *
 * A company the run does not reach, or whose run stops, is reported as a finding
 * on the company itself, never left looking clean; it is first in line next
 * time, and its next completed run resolves the finding. One company's failure
 * (a row cap, an unreadable source) never stops the companies after it.
 */
export async function runBooksProjection(options: { full?: boolean; deadline?: number } = {}) {
  const service = createServiceSupabaseClient();
  const [enabled, progress] = await Promise.all([
    collectPages((from, to) => service
      .from("books_settings")
      .select("org_id")
      .eq("workspace_enabled", true)
      .neq("arc_ledger_mode", "disabled")
      .order("org_id")
      .range(from, to), "Books organizations"),
    collectPages((from, to) => service
      .from("books_projection_progress")
      .select("org_id, incremental_completed_at, full_completed_at")
      .order("org_id")
      .range(from, to), "projection progress"),
  ]);
  const completedAt = new Map(progress.map((row) => {
    const at = options.full ? row.full_completed_at : row.incremental_completed_at;
    return [String(row.org_id), at ? String(at) : null];
  }));
  const orgIds = enabled.map((row) => String(row.org_id)).sort((left, right) => {
    const a = completedAt.get(left) ?? null, b = completedAt.get(right) ?? null;
    if (a === b) return left < right ? -1 : 1;
    if (a === null) return -1;
    if (b === null) return 1;
    return isAtOrAfter(a, b) ? 1 : -1;
  });
  const runFailure = (orgId: string, error: string) => ({
    orgId, projected: 0, skipped: 0, revised: 0, retired: 0, evaluatedSourceKeys: [] as string[], fullScanCompleted: false,
    failures: [{ sourceType: PROJECTION_RUN_SOURCE_TYPE, sourceId: orgId, error }],
  });
  const results = [];
  for (const orgId of orgIds) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      results.push(runFailure(orgId, "Books projection did not reach this company before the run's time limit"));
      continue;
    }
    try {
      const result = await projectJournal(orgId, { full: options.full });
      results.push({ orgId, ...result, evaluatedSourceKeys: [...result.evaluatedSourceKeys, factSourceKey(PROJECTION_RUN_SOURCE_TYPE, orgId)] });
    } catch (error) {
      results.push(runFailure(orgId, `Books projection stopped: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return { organizations: results.length, results };
}
