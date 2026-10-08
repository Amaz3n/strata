import { receivableRetainageAsOf, payableRetainageAsOf } from "@/lib/services/books/retainage-history";
import { AS_OF_BILL_STATUSES, isBillPayableAsOf, isInvoiceReceivableAsOf, loadLedgerRemovalDates, loadSubledgerSettlements } from "@/lib/services/books/subledger-settlements";
import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { z } from "zod";
import { isPayableVendorBillStatus } from "@/lib/financials/ledger-status";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts";
import {
  buildBalanceSheet,
  buildTrialBalance,
  loadLedgerBalances,
  type LoadedLedger,
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
    | "accumulated_depreciation_control"
    | "land_inventory_control"
    | "completed_homes_control"
    | "warranty_reserve_control"
    | "impairment_control"
    | "intercompany_control";
  label: string;
  status: "passed" | "failed";
  differenceCents: number;
  ledgerCents: number;
  subledgerCents: number;
  /** What failed, row by row, for controls that tie per lot or per home. */
  exceptions?: unknown[];
  /** Supporting rows (completed homes with their age) for the close and its saved evidence. */
  rows?: unknown[];
};

const homeInventoryControlsSchema = z.object({
  land: z.object({ ledgerCents: z.number(), subledgerCents: z.number(), exceptions: z.array(z.unknown()) }),
  completedHomes: z.object({ ledgerCents: z.number(), heldCents: z.number(), homes: z.array(z.unknown()), exceptions: z.array(z.unknown()) }),
  warrantyReserve: z.object({ ledgerCents: z.number(), subledgerCents: z.number() }),
});

/** Land by lot, completed homes held for sale, and warranty reserve consumption (`books_home_inventory_controls`). */
async function loadHomeInventoryControls(orgId: string, asOf: string) {
  const { data, error } = await createServiceSupabaseClient().rpc("books_home_inventory_controls", { p_org_id: orgId, p_as_of: asOf });
  if (error) throw new Error(`Failed to tie home inventory: ${error.message}`);
  return homeInventoryControlsSchema.parse(data);
}

/**
 * What companies owe each other, from both sides (`books_intercompany_positions`):
 * every company's net position with an affiliate must be the affiliate's opposite.
 */
async function loadIntercompanyControl(orgId: string, asOf: string) {
  const { data, error } = await createServiceSupabaseClient().rpc("books_intercompany_positions", { p_org_id: orgId, p_as_of: asOf });
  if (error) throw new Error(`Failed to tie intercompany balances: ${error.message}`);
  const rows = z.array(z.object({ entityId: z.string().uuid(), counterpartyId: z.string().uuid(), dueFromCents: z.coerce.number(), dueToCents: z.coerce.number() })).parse(data ?? []);
  const net = new Map(rows.map((row) => [`${row.entityId}:${row.counterpartyId}`, row.dueFromCents - row.dueToCents]));
  const exceptions = [...new Set(rows.map((row) => [row.entityId, row.counterpartyId].sort().join(":")))].flatMap((key) => {
    const [a, b] = key.split(":");
    const difference = (net.get(`${a}:${b}`) ?? 0) + (net.get(`${b}:${a}`) ?? 0);
    return difference === 0 ? [] : [{ entityId: a, counterpartyId: b, differenceCents: difference }];
  });
  return { dueFromCents: rows.reduce((sum, row) => sum + row.dueFromCents, 0), dueToCents: rows.reduce((sum, row) => sum + row.dueToCents, 0), exceptions };
}

/** Write-downs posted to 5070 against approved impairment reviews (`books_impairment_control`). */
async function loadImpairmentControl(orgId: string, asOf: string) {
  const { data, error } = await createServiceSupabaseClient().rpc("books_impairment_control", { p_org_id: orgId, p_as_of: asOf });
  if (error) throw new Error(`Failed to tie inventory impairments: ${error.message}`);
  return z.object({ ledgerCents: z.number(), subledgerCents: z.number() }).parse(data);
}

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
function glJobCostCents(ledger: LoadedLedger) {
  const jobCostAccounts = new Set(ledger.accounts
    .filter((account) => (account.account_type === "cogs" || ["1160", "1170"].includes(account.code)) && account.code !== SYSTEM_ACCOUNT_CODES.expectedLossExpense)
    .map((account) => account.id));
  return ledger.lines
    .filter((line) => line.project_id !== null && jobCostAccounts.has(line.account_id) && line.dimensions?.warranty_reserve_adjustment !== true)
    .reduce((sum, line) => sum + line.debit_cents - line.credit_cents, 0);
}

async function loadSubledgerJobCostCents(orgId: string, asOf: string) {
  const { data, error } = await createServiceSupabaseClient().rpc("books_job_cost_subledger_cents", { p_org_id: orgId, p_as_of: asOf });
  if (error) throw new Error(`Failed to load job cost subledger: ${error.message}`);
  return Number(data ?? 0);
}

/** Payable bills dated by `asOf`, read once for both the AP and the AP retainage tie-outs. */
async function loadPayableBills(orgId: string, asOf: string) {
  const service = createServiceSupabaseClient();
  return collectPages((from, to) => service.from("vendor_bills")
    .select("id,status,bill_date,total_cents,retainage_cents,metadata")
    .eq("org_id", orgId).lte("bill_date", asOf)
    .in("status", [...AS_OF_BILL_STATUSES]).order("id").range(from, to), "AP subledger");
}

/** The bills payable at `asOf`, by their ledger dates where they posted. */
async function payableAsOf(orgId: string, asOf: string, bills: PayableBill[]) {
  const removedOn = await loadLedgerRemovalDates(orgId, bills.filter((bill) => !isPayableVendorBillStatus(bill.status)).map((bill) => String(bill.id)));
  return (bill: PayableBill) => isBillPayableAsOf(bill, asOf, removedOn);
}
type PayableBill = Awaited<ReturnType<typeof loadPayableBills>>[number];

async function loadArApSubledgerCents(orgId: string, asOf: string, allBills: PayableBill[], isPayable: (bill: PayableBill) => boolean) {
  const bills = allBills.filter(isPayable);
  const service = createServiceSupabaseClient();
  const invoiceRows = await collectPages((from, to) => service.from("invoices")
    .select("id,total_cents,status,metadata").eq("org_id", orgId)
    .lte("issue_date", asOf).order("id").range(from, to), "AR subledger");
  const removedOn = await loadLedgerRemovalDates(orgId, invoiceRows.filter(row => row.status === "void").map(row => String(row.id)));
  const invoices = invoiceRows.filter(row => isInvoiceReceivableAsOf(row, asOf, removedOn));
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
async function loadRetainageSubledgerCents(orgId: string, asOf: string, bills: PayableBill[], isPayable: (bill: PayableBill) => boolean) {
  const service = createServiceSupabaseClient();
  const holds = await collectPages((from, to) => service.from("retainage")
    // Disambiguate both invoice FKs. Release state is evaluated at its accounting
    // date, never from today's hold status or lifetime released amount.
    .select("id,amount_cents,invoice:invoices!invoice_id!inner(status,issue_date,metadata),release:invoices!release_invoice_id(status,issue_date,metadata)")
    .eq("org_id", orgId).lte("invoice.issue_date", asOf)
    .order("id").range(from, to), "AR retainage history");
  return {
    receivableCents: receivableRetainageAsOf(holds, asOf),
    payableCents: payableRetainageAsOf(bills, asOf, isPayable),
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
  // A refunded payment still happened; its refund is counted as of its own date.
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
          .in("status", ["succeeded", "completed", "refunded"])
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
            .select("amount_cents, payment_reversals(amount_cents, status, occurred_at)")
            .eq("org_id", orgId)
            .in("metadata->>deposit_payment_id", ids)
            .contains("metadata", { customer_deposit_application: true })
            .in("status", ["succeeded", "completed", "refunded"])
            .lte("received_at", `${asOf}T23:59:59.999Z`)
            .range(from, to),
        "customer-deposit applications",
      ),
    ]);
    refunded += reversals.reduce(
      (sum, row) => sum + Number(row.amount_cents ?? 0),
      0,
    );
    // A reversed application returns the deposit to the buyer's liability.
    applied += applications.reduce(
      (sum, row) =>
        sum +
        Number(row.amount_cents ?? 0) -
        (row.payment_reversals ?? [])
          .filter((reversal) => reversal.status === "succeeded" && String(reversal.occurred_at) <= `${asOf}T23:59:59.999Z`)
          .reduce((total, reversal) => total + Number(reversal.amount_cents ?? 0), 0),
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
  // The ledger and the payable bills are each read once and shared by every check.
  const [ledger, bills] = await Promise.all([loadLedgerBalances(orgId, asOf), loadPayableBills(orgId, asOf)]);
  const isPayable = await payableAsOf(orgId, asOf, bills);
  const [
    trialBalance,
    balanceSheet,
    subledgerJobCostCents,
    arAp,
    retainage,
    customerDepositsCents,
    registers,
    homeInventory,
    impairment,
    intercompany,
  ] = await Promise.all([
    buildTrialBalance(orgId, asOf, ledger),
    buildBalanceSheet(orgId, asOf, ledger),
    loadSubledgerJobCostCents(orgId, asOf),
    loadArApSubledgerCents(orgId, asOf, bills, isPayable),
    loadRetainageSubledgerCents(orgId, asOf, bills, isPayable),
    loadCustomerDepositSubledgerCents(orgId, asOf),
    loadOperationalRegisterBalances(orgId, asOf),
    loadHomeInventoryControls(orgId, asOf),
    loadImpairmentControl(orgId, asOf),
    loadIntercompanyControl(orgId, asOf),
  ]);
  const glJobCost = glJobCostCents(ledger);
  const accountBalance = (code: string) =>
    trialBalance.rows.find((row) => row.code === code)?.balanceCents ?? 0;
  const trialDifference =
    trialBalance.totalDebitCents - trialBalance.totalCreditCents;
  const jobCostDifference = glJobCost - subledgerJobCostCents;
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
      ledgerCents: glJobCost,
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
    {
      code: "land_inventory_control",
      label: "Land ties lot by lot to each lot's cost basis",
      status: homeInventory.land.exceptions.length === 0 ? "passed" : "failed",
      differenceCents: homeInventory.land.ledgerCents - homeInventory.land.subledgerCents,
      ledgerCents: homeInventory.land.ledgerCents,
      subledgerCents: homeInventory.land.subledgerCents,
      exceptions: homeInventory.land.exceptions,
    },
    {
      code: "completed_homes_control",
      label: "Completed homes held for sale tie to the homes not yet sold",
      status: homeInventory.completedHomes.exceptions.length === 0 ? "passed" : "failed",
      differenceCents: homeInventory.completedHomes.ledgerCents - homeInventory.completedHomes.heldCents,
      ledgerCents: homeInventory.completedHomes.ledgerCents,
      subledgerCents: homeInventory.completedHomes.heldCents,
      exceptions: homeInventory.completedHomes.exceptions,
      rows: homeInventory.completedHomes.homes,
    },
    {
      code: "warranty_reserve_control",
      label: "Warranty reserve use ties to approved warranty costs",
      status: homeInventory.warrantyReserve.ledgerCents === homeInventory.warrantyReserve.subledgerCents ? "passed" : "failed",
      differenceCents: homeInventory.warrantyReserve.ledgerCents - homeInventory.warrantyReserve.subledgerCents,
      ledgerCents: homeInventory.warrantyReserve.ledgerCents,
      subledgerCents: homeInventory.warrantyReserve.subledgerCents,
    },
    {
      code: "impairment_control",
      label: "Inventory write-downs tie to approved impairment reviews",
      status: impairment.ledgerCents === impairment.subledgerCents ? "passed" : "failed",
      differenceCents: impairment.ledgerCents - impairment.subledgerCents,
      ledgerCents: impairment.ledgerCents,
      subledgerCents: impairment.subledgerCents,
    },
    {
      code: "intercompany_control",
      label: "What the companies owe each other agrees on both sides",
      status: intercompany.exceptions.length === 0 && intercompany.dueFromCents === intercompany.dueToCents ? "passed" : "failed",
      differenceCents: intercompany.dueFromCents - intercompany.dueToCents,
      ledgerCents: intercompany.dueFromCents,
      subledgerCents: intercompany.dueToCents,
      ...(intercompany.exceptions.length ? { exceptions: intercompany.exceptions } : {}),
    },
  ];
}
