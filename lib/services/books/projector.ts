import "server-only";
import { loadBooksProjectDimensions } from "@/lib/services/books/dimensions";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts";

import { z } from "zod";
import { loadOpeningOwnedSources } from "@/lib/services/books/opening-sources";
import { reconcileWarrantyRecoveriesForService } from "@/lib/services/books/warranty-accounting";
import { loadInventoryPolicies, transitionInventoryForService } from "@/lib/services/books/inventory";
import { inventoryCostAccount } from "@/lib/services/books/inventory-rules";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  BILLED_INVOICE_STATUSES,
  PAYABLE_VENDOR_BILL_STATUSES,
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
import { loadRevenueBasisByProject } from "@/lib/services/books/revenue-basis";
import { recordEvent } from "@/lib/services/events";
import { isoDateOnlyFromUtcMs } from "@/lib/services/reports/dates";
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

type ProjectionWatermarks = {
  bills: string | null;
  invoices: string | null;
  payments: string | null;
  feeCharges: string | null;
  expenses: string | null;
  reversals: string | null;
  adjustments: string | null;
  labor: string | null;
};

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
 * One cursor per upstream source family.
 *
 * A global max lets a newer bill advance beyond an older invoice forever. The
 * family cursor keeps unrelated tables independent; `gte` still deliberately
 * replays the boundary row so a fact inserted before its journal can heal.
 */
async function resolveWatermarks(orgId: string): Promise<ProjectionWatermarks> {
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
  return {
    bills: earliestTimestamp([vendorBill, retainage]),
    invoices: earliestTimestamp([invoice, retainage]),
    payments: earliestTimestamp([
      billPayment,
      invoicePayment,
      customerDepositReceipt,
      customerDepositApplication,
    ]),
    feeCharges: feeCharge,
    expenses: expense,
    reversals: earliestTimestamp([reversal, customerDepositReversal]),
    adjustments: receivableAdjustment,
    labor,
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
async function loadBillCostLines(orgId: string) {
  const service = createServiceSupabaseClient();
  const [entries, billLines, accounts] = await Promise.all([
    collectPages(
      (from, to) =>
        service
          .from("job_cost_entries")
          .select("source_id, project_id, cost_cents, cost_code_id, metadata")
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
      (from, to) =>
        service
          .from("bill_lines")
          .select("id, bill_id, description, metadata")
          .eq("org_id", orgId)
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
async function loadExpenseCostLines(orgId: string) {
  const service = createServiceSupabaseClient();
  const [entries, expenseLines, accounts] = await Promise.all([
    collectPages(
      (from, to) =>
        service
          .from("job_cost_entries")
          .select("source_type, source_id, project_id, cost_cents, cost_code_id, metadata")
          .eq("org_id", orgId)
          .eq("status", "posted")
          .in("source_type", ["project_expense", "project_expense_line"])
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      "expense job cost entries",
    ),
    collectPages(
      (from, to) =>
        service
          .from("project_expense_lines")
          .select("id, expense_id, description, metadata")
          .eq("org_id", orgId)
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
async function loadLaborCostEntries(orgId: string, since: string | null) {
  const service = createServiceSupabaseClient();
  return collectPages((from, to) => {
    let query = service
      .from("job_cost_entries")
      .select("id, project_id, cost_cents, incurred_on, updated_at, status, cost_code_id, metadata")
      .eq("org_id", orgId)
      .eq("source_type", "time_entry");
    if (since) query = query.gte("updated_at", since);
    return query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
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
    basisByProject,
    costLinesByBill,
    costLinesByExpense,
    laborEntries,
    retainageByInvoice,
    releaseByInvoice,
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
    loadRevenueBasisByProject(orgId),
    loadBillCostLines(orgId),
    loadExpenseCostLines(orgId),
    loadLaborCostEntries(orgId, watermarks.labor),
    // AR retainage lives in the `retainage` table, never on the invoice row. Loaded
    // whole rather than watermarked: a release can attach retainage to an invoice
    // that itself has not changed since the last run.
    loadInvoiceRetainageCents({ supabase: service, orgId }),
    loadRetainageReleaseInvoiceCents({ supabase: service, orgId }),
    // Every paged read below imposes a total order for the reason given on
    // `collectPages`: `.range()` without one skips and duplicates rows.
    collectPages((from, to) => {
      let query = service
        .from("vendor_bills")
        .select(
          "id, project_id, company_id, bill_number, bill_date, total_cents, retainage_cents, use_tax_accrued_cents, metadata, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.bills) query = query.gte("updated_at", watermarks.bills);
      return query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    }, "vendor bills"),
    collectPages((from, to) => {
      let query = service
        .from("invoices")
        .select(
          "id, project_id, title, invoice_number, issue_date, total_cents, tax_cents, metadata, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.invoices)
        query = query.gte("updated_at", watermarks.invoices);
      return query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    }, "invoices"),
    collectPages((from, to) => {
      let query = service
        .from("payments")
        .select(
          "id, project_id, invoice_id, bill_id, amount_cents, gross_cents, fee_cents, processor_fee_cents, platform_fee_cents, method, metadata, received_at, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.payments)
        query = query.gte("updated_at", watermarks.payments);
      return query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    }, "payments"),
    collectPages((from, to) => {
      let query = service
        .from("payment_run_fee_charges")
        .select("id, amount_cents, funding_source_id, settled_at, updated_at, status")
        .eq("org_id", orgId);
      if (watermarks.feeCharges) query = query.gte("updated_at", watermarks.feeCharges);
      return query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    }, "payment run fee charges"),
    collectPages((from, to) => {
      let query = service
        .from("project_expenses")
        .select(
          "id, project_id, vendor_company_id, expense_date, amount_cents, tax_cents, description, payment_method, accounting_coding, metadata, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.expenses)
        query = query.gte("updated_at", watermarks.expenses);
      return query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    }, "project expenses"),
    collectPages((from, to) => {
      let query = service
        .from("payment_reversals")
        .select(
          "id, project_id, invoice_id, bill_id, payment_id, amount_cents, occurred_at, updated_at, status",
        )
        .eq("org_id", orgId);
      if (watermarks.reversals)
        query = query.gte("updated_at", watermarks.reversals);
      return query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    }, "payment reversals"),
    collectPages((from, to) => {
      let query = service
        .from("receivable_adjustments")
        .select(
          "id, project_id, invoice_id, adjustment_type, status, amount_cents, tax_cents, effective_date, reason, updated_at",
        )
        .eq("org_id", orgId);
      if (watermarks.adjustments)
        query = query.gte("updated_at", watermarks.adjustments);
      return query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    }, "receivable adjustments"),
  ]);

  const candidates: ProjectionCandidate[] = [];
  const failures: ProjectionFailure[] = [];
  const fundingCode = (sourceType: string, sourceId: string, resolve: () => string) => {
    try { return resolve(); } catch (error) {
      failures.push({ sourceType, sourceId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  const touchedSourceKeys = new Set<string>();
  const liveSourceKeys = new Set<string>();
  const depositInvoiceIds = new Set(
    invoices
      .filter(
        (row) =>
          (row.metadata as { invoice_kind?: unknown } | null)?.invoice_kind ===
          "earnest_deposit",
      )
      .map((row) => String(row.id)),
  );

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
    if (totalCents === 0) continue;
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
    const projectId = row.project_id ? String(row.project_id) : null;
    const basis = projectId
      ? (basisByProject.get(projectId) ?? "percentage_of_completion")
      : "percentage_of_completion";
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
      },
    });
  }

  for (const row of payments) {
    if (openingSources.payments.has(String(row.id))) continue;
    const metadata =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {};
    const isDepositReceipt =
      Boolean(row.invoice_id) && depositInvoiceIds.has(String(row.invoice_id));
    const isDepositApplication = metadata.customer_deposit_application === true;
    const classification = classifyPaymentPosting({
      method: typeof row.method === "string" ? row.method : null,
      hasBill: Boolean(row.bill_id),
      hasInvoice: Boolean(row.invoice_id),
      creditApplied: metadata.vendor_credit_applied === true,
    });
    const paymentIsLive = new Set(["succeeded", "completed", "paid"]).has(
      String(row.status),
    );
    // A payment linked to neither a bill nor an invoice is not a customer
    // receipt — fee collections and standalone settlements land here. Guessing
    // would fabricate an AR credit, so it is reported instead of posted.
    if (classification.kind === "unpostable") {
      if (!paymentIsLive) continue;
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
    if (!new Set(["approved", "locked"]).has(String(row.status))) continue;
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
    const projectId = row.project_id ? String(row.project_id) : null;
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
        revenue_basis: projectId
          ? (basisByProject.get(projectId) ?? "percentage_of_completion")
          : "percentage_of_completion",
      },
    });
  }

  for (const row of laborEntries) {
    const sourceKey = factSourceKey("labor_cost", String(row.id));
    touchedSourceKeys.add(sourceKey);
    if (row.status !== "posted") continue;
    const amountCents = Number(row.cost_cents ?? 0);
    if (amountCents === 0) continue;
    liveSourceKeys.add(sourceKey);
    candidates.push({
      sourceType: "labor_cost",
      sourceId: String(row.id),
      accountingDate: String(row.incurred_on),
      occurredAt: String(row.updated_at),
      payload: {
        memo: "Field labor",
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
    const ids = new Set([candidate.payload.project_id, ...(Array.isArray(candidate.payload.cost_lines) ? candidate.payload.cost_lines.map((line: FactCostLine) => line.project_id) : [])].filter((id): id is string => typeof id === "string"));
    const captured = Object.fromEntries([...ids].filter(id => projectDimensions.has(id)).map(id => [id, projectDimensions.get(id)]));
    if (Object.keys(captured).length) candidate.payload.project_dimensions = captured;
  }
  return { candidates, failures, retirementSourceKeys, liveSourceKeys };
}

const factRowSchema = z.object({
  id: z.string().uuid(),
  payload_hash: z.string(),
  payload: z.record(z.unknown()),
  accounting_date: z.string(),
  source_version: z.number().int(),
});

/**
 * Project one source transition as a single database transaction. The RPC owns
 * concurrency, prior-entry reversal, immutable fact insertion and replacement
 * posting; a worker crash can no longer expose a half-revised official ledger.
 */
async function projectCandidateAtomically(
  orgId: string,
  candidate: ProjectionCandidate,
  policyVersion: number,
  projectionVersion: number,
) {
  const service = createServiceSupabaseClient();
  const { data: existingRow, error: existingError } = await service
    .from("accounting_facts")
    .select("id, payload_hash, payload, source_version, accounting_date")
    .eq("org_id", orgId)
    .eq("source_type", candidate.sourceType)
    .eq("source_id", candidate.sourceId)
    .order("source_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError)
    throw new Error(
      `Failed to inspect accounting fact: ${existingError.message}`,
    );
  const existing = existingRow ? factRowSchema.parse(existingRow) : null;
  candidate = { ...candidate, payload: preserveLegacyDimensionPayload(candidate.sourceType, candidate.accountingDate, candidate.payload, existing) };
  const { sourceVersion, payloadHash, idempotencyKey } = factTransitionIdentity({
    orgId, sourceType: candidate.sourceType, sourceId: candidate.sourceId,
    accountingDate: candidate.accountingDate,
    payload: hashableFactPayload(candidate.sourceType, candidate.payload), previous: existing,
  });
  const draft = draftFromFact({
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    accountingDate: candidate.accountingDate,
    payload: candidate.payload,
    sourceVersion,
    projectionVersion,
    policyVersion,
  });
  if (!draft) throw new Error(`No posting rule covers ${candidate.sourceType}`);
  return projectBooksFactAndJournalForService({
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
  options: { since?: string; full?: boolean; sourceKeys?: string[] } = {},
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
    };
  }

  const policyVersion = Number(settings.active_policy_version);
  const projectionVersion = await resolveProjectionVersion(orgId);
  const allFrom = (value: string | null): ProjectionWatermarks => ({
    bills: value,
    invoices: value,
    payments: value,
    feeCharges: value,
    expenses: value,
    reversals: value,
    adjustments: value,
    labor: value,
  });
  const watermarks = options.full || options.sourceKeys
    ? allFrom(null)
    : options.since
      ? allFrom(options.since)
      : await resolveWatermarks(orgId);
  const { candidates, failures: candidateFailures, retirementSourceKeys, liveSourceKeys } =
    await projectionCandidates(orgId, watermarks);

  const requestedKeys = options.sourceKeys ? new Set(options.sourceKeys) : null;
  const failures = candidateFailures.filter((row) => !requestedKeys || requestedKeys.has(factSourceKey(row.sourceType, row.sourceId)));
  let projected = 0;
  let skipped = 0;
  let revised = 0;
  for (const candidate of candidates) {
    if (requestedKeys && !requestedKeys.has(factSourceKey(candidate.sourceType, candidate.sourceId))) continue;
    try {
      const projection = await projectCandidateAtomically(
        orgId,
        candidate,
        policyVersion,
        projectionVersion,
      );
      if (projection.superseded) revised += 1;
      if (projection.created || projection.journalCreated) projected += 1;
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
    // projectable status set, so voids/rejections retire immediately. Deletions
    // still require the nightly full pass because no row remains to watermark.
    const retirement = await retireDepartedSources(
      orgId,
      new Set<string>(),
      policyVersion,
      retirementSourceKeys,
    );
    retired = retirement.retired;
    failures.push(...retirement.failures);
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
    try {
      await transitionInventoryForService({ orgId, projectId, transition: policy.soldOn ? "sale_relief" : "completion", date, evidenceUrl: policy.evidenceUrl });
    } catch (error) {
      failures.push({ sourceType: "inventory_cost_relief", sourceId: projectId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  failures.push(...await reconcileWarrantyRecoveriesForService(orgId, requestedProjects));
  return { projected, skipped, revised, retired, failures };
}

export async function runBooksProjection(options: { full?: boolean } = {}) {
  const service = createServiceSupabaseClient();
  const { data, error } = await service
    .from("books_settings")
    .select("org_id")
    .eq("workspace_enabled", true)
    .neq("arc_ledger_mode", "disabled")
    .order("org_id");
  if (error)
    throw new Error(`Failed to load Books organizations: ${error.message}`);
  const results = [];
  for (const row of data ?? [])
    results.push({
      orgId: row.org_id,
      ...(await projectJournal(row.org_id, { full: options.full })),
    });
  return { organizations: results.length, results };
}
