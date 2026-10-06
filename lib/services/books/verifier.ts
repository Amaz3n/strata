import { receivableRetainageAsOf, payableRetainageAsOf } from "@/lib/services/books/retainage-history";
import { isInvoiceReceivableAsOf, loadSubledgerSettlements } from "@/lib/services/books/subledger-settlements";
import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  PAYABLE_VENDOR_BILL_STATUSES,
} from "@/lib/financials/ledger-status";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts";
import {
  buildBalanceSheet,
  buildTrialBalance,
} from "@/lib/services/books/statements";

/**
 * The ledger tie-outs.
 *
 * Run nightly for every org by the reconciliation spine
 * (`books/reconciliation.ts`), which persists each failure as an
 * `accounting_reconciliation_items` row, and again at period close, which turns them
 * into blocking close checks. Both callers read these results; neither recomputes them.
 *
 * These are the four checks the Books design calls non-negotiable: the trial
 * balance sums to zero, the balance sheet balances, GL job cost ties to the
 * `job_cost_entries` subledger, and AR/AP tie to the aging subledgers. The
 * job-cost tie-out is the one that never existed — the GL and the cost subledger
 * were derived independently, so nothing would have noticed them diverging.
 */

export type LedgerTieOut = {
  code:
    | "trial_balance"
    | "balance_sheet"
    | "job_cost_control"
    | "ar_control"
    | "ap_control"
    | "retainage_receivable_control"
    | "retainage_payable_control"
    | "customer_deposits_control"
    | "debt_register_control"
    | "fixed_assets_control"
    | "accumulated_depreciation_control";
  label: string;
  status: "passed" | "failed";
  differenceCents: number;
  ledgerCents: number;
  subledgerCents: number;
};

const PAGE_SIZE = 1000;

async function collectPages<T>(
  loadPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await loadPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

/** Job cost recognized in the GL: cost-of-goods lines carrying a project. */
async function loadGlJobCostCents(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient();
  const rows = await collectPages(
    (from, to) =>
      service
        .from("journal_lines")
        .select(
          "debit_cents, credit_cents, dimensions, entry:journal_entries!journal_lines_entry_owner_fk!inner(status, entry_date), account:gl_accounts!journal_lines_account_owner_fk!inner(account_type,code)",
        )
        .eq("org_id", orgId)
        .in("entry.status", ["posted", "reversed"])
        .lte("entry.entry_date", asOf)
        .or("account_type.eq.cogs,code.in.(1160,1170)", { referencedTable: "account" })
        .not("project_id", "is", null)
        .neq("account.code", SYSTEM_ACCOUNT_CODES.expectedLossExpense)
        .range(from, to),
    "GL job cost lines",
  );
  return rows.filter(row => !(row.dimensions && typeof row.dimensions === "object" && Reflect.get(row.dimensions, "warranty_reserve_adjustment") === true)).reduce(
    (sum, row) =>
      sum + Number(row.debit_cents ?? 0) - Number(row.credit_cents ?? 0),
    0,
  );
}

async function loadSubledgerJobCostCents(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient();
  const rows = await collectPages(
    (from, to) =>
      service
        .from("job_cost_entries")
        .select("cost_cents")
        .eq("org_id", orgId)
        .eq("status", "posted")
        .lte("incurred_on", asOf)
        .range(from, to),
    "job cost subledger",
  );
  return rows.reduce((sum, row) => sum + Number(row.cost_cents ?? 0), 0);
}

async function loadArApSubledgerCents(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient();
  const [invoiceRows, bills] = await Promise.all([
    collectPages((from, to) => service.from("invoices")
      .select("id,total_cents,status,metadata").eq("org_id", orgId)
      .lte("issue_date", asOf).order("id").range(from, to), "AR subledger"),
    collectPages((from, to) => service.from("vendor_bills")
      .select("id,total_cents,retainage_cents").eq("org_id", orgId)
      .lte("bill_date", asOf).in("status", [...PAYABLE_VENDOR_BILL_STATUSES])
      .order("id").range(from, to), "AP subledger"),
  ]);
  const invoices = invoiceRows.filter(row => isInvoiceReceivableAsOf(row, asOf));
  const [arSettlements, apSettlements] = await Promise.all([
    loadSubledgerSettlements(service, orgId, "receivable", invoices.map(row => row.id), asOf),
    loadSubledgerSettlements(service, orgId, "payable", bills.map(row => row.id), asOf),
  ]);
  return {
    arCents: invoices.reduce((sum, row) => sum + Number(row.total_cents) - (arSettlements.get(row.id) ?? 0), 0),
    apCents: bills.reduce((sum, row) => sum + Number(row.total_cents) - Number(row.retainage_cents ?? 0) - (apSettlements.get(row.id) ?? 0), 0),
  };
}

/**
 * Retainage still held, per side.
 *
 * Accounts 1110 and 2010 are posted to by the invoice and vendor-bill rules but were
 * never verified against anything — retainage could drift indefinitely without a single
 * check noticing. AR retainage lives in the `retainage` table (its authoritative home);
 * AP retainage lives in the vendor-bill columns, net of what has been released.
 */
async function loadRetainageSubledgerCents(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient();
  const [holds, bills] = await Promise.all([
    collectPages((from, to) => service.from("retainage")
      // Disambiguate both invoice FKs. Release state is evaluated at its accounting
      // date, never from today's hold status or lifetime released amount.
      .select("id,amount_cents,invoice:invoices!invoice_id!inner(status,issue_date,metadata),release:invoices!release_invoice_id(status,issue_date,metadata)")
      .eq("org_id", orgId).lte("invoice.issue_date", asOf)
      .order("id").range(from, to), "AR retainage history"),
    collectPages((from, to) => service.from("vendor_bills")
      .select("id,status,bill_date,total_cents,retainage_cents,metadata")
      .eq("org_id", orgId).lte("bill_date", asOf)
      .in("status", [...PAYABLE_VENDOR_BILL_STATUSES]).order("id").range(from, to), "AP retainage history"),
  ]);
  return {
    receivableCents: receivableRetainageAsOf(holds, asOf),
    payableCents: payableRetainageAsOf(bills, asOf),
  };
}

async function loadCustomerDepositSubledgerCents(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient();
  const depositInvoices = await collectPages(
    (from, to) =>
      service
        .from("invoices")
        .select("id")
        .eq("org_id", orgId)
        .contains("metadata", { invoice_kind: "earnest_deposit" })
        .lte("issue_date", asOf)
        .range(from, to),
    "customer-deposit invoices",
  );
  const invoiceIds = depositInvoices.map((row) => row.id);
  if (invoiceIds.length === 0) return 0;
  let received = 0;
  let refunded = 0;
  const depositPaymentIds: string[] = [];
  for (let start = 0; start < invoiceIds.length; start += 200) {
    const payments = await collectPages(
      (from, to) =>
        service
          .from("payments")
          .select("id,amount_cents")
          .eq("org_id", orgId)
          .in("invoice_id", invoiceIds.slice(start, start + 200))
          .in("status", ["succeeded", "completed"])
          .lte("received_at", `${asOf}T23:59:59.999Z`)
          .range(from, to),
      "customer-deposit receipts",
    );
    received += payments.reduce(
      (sum, row) => sum + Number(row.amount_cents ?? 0),
      0,
    );
    depositPaymentIds.push(...payments.map((row) => String(row.id)));
  }
  let applied = 0;
  for (let start = 0; start < depositPaymentIds.length; start += 200) {
    const ids = depositPaymentIds.slice(start, start + 200);
    const [reversals, applications] = await Promise.all([
      collectPages(
        (from, to) =>
          service
            .from("payment_reversals")
            .select("amount_cents")
            .eq("org_id", orgId)
            .in("payment_id", ids)
            .eq("status", "succeeded")
            .lte("occurred_at", `${asOf}T23:59:59.999Z`)
            .range(from, to),
        "customer-deposit refunds",
      ),
      collectPages(
        (from, to) =>
          service
            .from("payments")
            .select("amount_cents")
            .eq("org_id", orgId)
            .in("metadata->>deposit_payment_id", ids)
            .contains("metadata", { customer_deposit_application: true })
            .in("status", ["succeeded", "completed"])
            .lte("received_at", `${asOf}T23:59:59.999Z`)
            .range(from, to),
        "customer-deposit applications",
      ),
    ]);
    refunded += reversals.reduce(
      (sum, row) => sum + Number(row.amount_cents ?? 0),
      0,
    );
    applied += applications.reduce(
      (sum, row) => sum + Number(row.amount_cents ?? 0),
      0,
    );
  }
  return received - refunded - applied;
}

async function loadOperationalRegisterBalances(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient();
  const [debtInstruments, debtEvents, assets, assetEvents] = await Promise.all([
    collectPages(
      (from, to) =>
        service
          .from("books_debt_instruments")
          .select("original_principal_cents,opened_on")
          .eq("org_id", orgId)
          .lte("opened_on", asOf)
          .range(from, to),
      "debt instruments",
    ),
    collectPages(
      (from, to) =>
        service
          .from("books_debt_events")
          .select("event_type,principal_cents,interest_cents")
          .eq("org_id", orgId)
          .lte("event_date", asOf)
          .range(from, to),
      "debt register",
    ),
    collectPages(
      (from, to) =>
        service
          .from("books_fixed_assets")
          .select("id,status,disposed_on,acquisition_cost_cents,opening_accumulated_depreciation_cents,opening_as_of")
          .eq("org_id", orgId)
          .lte("placed_in_service_on", asOf)
          .range(from, to),
      "fixed-asset register",
    ),
    collectPages(
      (from, to) =>
        service
          .from("books_fixed_asset_events")
          .select("asset_id,event_type,amount_cents")
          .eq("org_id", orgId)
          .lte("event_date", asOf)
          .in("event_type", ["depreciation", "impairment"])
          .range(from, to),
      "fixed-asset depreciation register",
    ),
  ]);
  return {
    debtCents: debtEvents.reduce(
      (sum, event) => {
        if (event.event_type === "draw")
          return sum + Number(event.principal_cents ?? 0);
        if (event.event_type === "interest_accrual")
          return sum + Number(event.interest_cents ?? 0);
        if (event.event_type === "payment")
          return sum - Number(event.principal_cents ?? 0);
        return sum;
      },
      debtInstruments.reduce(
        (sum, instrument) =>
          sum + Number(instrument.original_principal_cents ?? 0),
        0,
      ),
    ),
    fixedAssetCents: assets
      .filter(
        (asset) =>
          asset.status !== "disposed" || String(asset.disposed_on) > asOf,
      )
      .reduce(
        (sum, asset) => sum + Number(asset.acquisition_cost_cents ?? 0),
        0,
      ),
    depreciationCents: assetEvents
      .filter((event) =>
        assets.some(
          (asset) =>
            asset.id === event.asset_id &&
            (asset.status !== "disposed" || String(asset.disposed_on) > asOf),
        ),
      )
      .reduce((sum, event) => sum + Number(event.amount_cents ?? 0), assets.filter((asset) => (!asset.opening_as_of || asset.opening_as_of <= asOf) && (asset.status !== "disposed" || String(asset.disposed_on) > asOf)).reduce((sum, asset) => sum + Number(asset.opening_accumulated_depreciation_cents ?? 0), 0)),
  };
}

export async function runLedgerTieOuts(
  orgId: string,
  asOf: string,
): Promise<LedgerTieOut[]> {
  const [
    trialBalance,
    balanceSheet,
    glJobCostCents,
    subledgerJobCostCents,
    arAp,
    retainage,
    customerDepositsCents,
    registers,
  ] = await Promise.all([
    buildTrialBalance(orgId, asOf),
    buildBalanceSheet(orgId, asOf),
    loadGlJobCostCents(orgId, asOf),
    loadSubledgerJobCostCents(orgId, asOf),
    loadArApSubledgerCents(orgId, asOf),
    loadRetainageSubledgerCents(orgId, asOf),
    loadCustomerDepositSubledgerCents(orgId, asOf),
    loadOperationalRegisterBalances(orgId, asOf),
  ]);
  const accountBalance = (code: string) =>
    trialBalance.rows.find((row) => row.code === code)?.balanceCents ?? 0;
  const trialDifference =
    trialBalance.totalDebitCents - trialBalance.totalCreditCents;
  const jobCostDifference = glJobCostCents - subledgerJobCostCents;
  const arDifference =
    accountBalance(SYSTEM_ACCOUNT_CODES.accountsReceivable) - arAp.arCents;
  const apDifference =
    accountBalance(SYSTEM_ACCOUNT_CODES.accountsPayable) - arAp.apCents;
  const retainageReceivableDifference =
    accountBalance(SYSTEM_ACCOUNT_CODES.retainageReceivable) -
    retainage.receivableCents;
  const retainagePayableDifference =
    accountBalance(SYSTEM_ACCOUNT_CODES.retainagePayable) -
    retainage.payableCents;
  const customerDepositDifference =
    accountBalance(SYSTEM_ACCOUNT_CODES.customerDeposits) -
    customerDepositsCents;
  const balanceBySubtype = (subtypes: string[]) =>
    trialBalance.rows
      .filter((row) => subtypes.includes(row.subtype))
      .reduce((sum, row) => sum + row.balanceCents, 0);
  const debtLedgerCents = balanceBySubtype(["current_debt", "long_term_debt"]);
  const fixedAssetLedgerCents = balanceBySubtype(["fixed_assets"]);
  const depreciationLedgerCents = balanceBySubtype([
    "accumulated_depreciation",
  ]);

  return [
    {
      code: "trial_balance",
      label: "Trial balance sums to zero",
      status: trialDifference === 0 ? "passed" : "failed",
      differenceCents: trialDifference,
      ledgerCents: trialBalance.totalDebitCents,
      subledgerCents: trialBalance.totalCreditCents,
    },
    {
      code: "balance_sheet",
      label: "Balance sheet balances",
      status: balanceSheet.differenceCents === 0 ? "passed" : "failed",
      differenceCents: balanceSheet.differenceCents,
      ledgerCents: balanceSheet.assetCents,
      subledgerCents: balanceSheet.liabilityCents + balanceSheet.equityCents,
    },
    {
      code: "job_cost_control",
      label: "GL job cost ties to the job-cost subledger",
      status: jobCostDifference === 0 ? "passed" : "failed",
      differenceCents: jobCostDifference,
      ledgerCents: glJobCostCents,
      subledgerCents: subledgerJobCostCents,
    },
    {
      code: "ar_control",
      label: "Accounts receivable ties to the AR subledger",
      status: arDifference === 0 ? "passed" : "failed",
      differenceCents: arDifference,
      ledgerCents: accountBalance(SYSTEM_ACCOUNT_CODES.accountsReceivable),
      subledgerCents: arAp.arCents,
    },
    {
      code: "ap_control",
      label: "Accounts payable ties to the AP subledger",
      status: apDifference === 0 ? "passed" : "failed",
      differenceCents: apDifference,
      ledgerCents: accountBalance(SYSTEM_ACCOUNT_CODES.accountsPayable),
      subledgerCents: arAp.apCents,
    },
    {
      code: "retainage_receivable_control",
      label: "Retainage receivable ties to retainage still held",
      status: retainageReceivableDifference === 0 ? "passed" : "failed",
      differenceCents: retainageReceivableDifference,
      ledgerCents: accountBalance(SYSTEM_ACCOUNT_CODES.retainageReceivable),
      subledgerCents: retainage.receivableCents,
    },
    {
      code: "retainage_payable_control",
      label: "Retainage payable ties to unreleased vendor retainage",
      status: retainagePayableDifference === 0 ? "passed" : "failed",
      differenceCents: retainagePayableDifference,
      ledgerCents: accountBalance(SYSTEM_ACCOUNT_CODES.retainagePayable),
      subledgerCents: retainage.payableCents,
    },
    {
      code: "customer_deposits_control",
      label: "Customer-deposit liability ties to unapplied deposits",
      status: customerDepositDifference === 0 ? "passed" : "failed",
      differenceCents: customerDepositDifference,
      ledgerCents: accountBalance(SYSTEM_ACCOUNT_CODES.customerDeposits),
      subledgerCents: customerDepositsCents,
    },
    {
      code: "debt_register_control",
      label: "Debt accounts tie to the debt register",
      status: debtLedgerCents === registers.debtCents ? "passed" : "failed",
      differenceCents: debtLedgerCents - registers.debtCents,
      ledgerCents: debtLedgerCents,
      subledgerCents: registers.debtCents,
    },
    {
      code: "fixed_assets_control",
      label: "Fixed-asset accounts tie to the asset register",
      status:
        fixedAssetLedgerCents === registers.fixedAssetCents
          ? "passed"
          : "failed",
      differenceCents: fixedAssetLedgerCents - registers.fixedAssetCents,
      ledgerCents: fixedAssetLedgerCents,
      subledgerCents: registers.fixedAssetCents,
    },
    {
      code: "accumulated_depreciation_control",
      label: "Accumulated depreciation ties to the asset register",
      status:
        depreciationLedgerCents === registers.depreciationCents
          ? "passed"
          : "failed",
      differenceCents: depreciationLedgerCents - registers.depreciationCents,
      ledgerCents: depreciationLedgerCents,
      subledgerCents: registers.depreciationCents,
    },
  ];
}
