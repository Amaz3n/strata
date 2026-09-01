require("../scripts/register-ts-node-test");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  assertApprovedCostInvoiceBillingModelAllowed,
  isCostDrivenBillingModel,
  shouldExposeOpenBookCostDetail,
} = require("../lib/financials/billing-model");
const {
  assertCostSourceCanEnterBillableLedger,
} = require("../lib/financials/billable-ledger-rules");
const {
  buildApprovedCostInvoiceIdempotencyKey,
} = require("../lib/financials/approved-cost-rules");
const {
  summarizeJobCostEntriesByCostCode,
} = require("../lib/financials/job-cost-rules");
const {
  assertBillingPeriodStatusAllowsEdit,
  assertBillingPeriodStatusAllowsInvoice,
} = require("../lib/financials/billing-period-rules");
const {
  compareForecastSnapshotLines,
  distributeForecastAcrossMonths,
} = require("../lib/financials/forecasting");

test("forecast snapshot comparison and time phasing preserve integer-cent totals", () => {
  assert.deepEqual(
    compareForecastSnapshotLines(
      [{ cost_code_id: "a", cost_code: "03", adjusted_budget_cents: 10000 }],
      [
        {
          cost_code_id: "a",
          cost_code: "03",
          estimate_at_completion_cents: 13500,
        },
        {
          cost_code_id: "b",
          cost_code: "09",
          estimate_at_completion_cents: 2500,
        },
      ],
    ).map((line) => line.variance_cents),
    [3500, 2500],
  );
  for (const curve of ["linear", "front_loaded", "back_loaded"]) {
    const phased = distributeForecastAcrossMonths({
      start: "2026-01-15",
      end: "2026-04-02",
      amount_cents: 10001,
      curve,
    });
    assert.equal(
      Object.values(phased).reduce((sum, cents) => sum + cents, 0),
      10001,
    );
  }
});

test("parity financial gates are registered at their enforcement points", () => {
  const bills = fs.readFileSync(
    path.join(__dirname, "../lib/services/vendor-bills.ts"),
    "utf8",
  );
  const holds = fs.readFileSync(
    path.join(__dirname, "../lib/services/payment-holds.ts"),
    "utf8",
  );
  const changes = fs.readFileSync(
    path.join(__dirname, "../lib/services/change-events.ts"),
    "utf8",
  );
  assert.match(bills, /assertBillReleasable\(billId/);
  assert.match(holds, /Payment is on hold/);
  assert.match(holds, /evaluateHolds\(billId/);
  assert.match(holds, /assertBillReleasable/);
  assert.match(holds, /fundingReceived/);
  assert.match(holds, /payment_hold_overridden/);
  assert.match(changes, /convertChangeEventToChangeOrder/);
  assert.match(changes, /change_event_converted/);
});

test("fixed-price projects cannot create approved-cost invoices", () => {
  assert.throws(
    () => assertApprovedCostInvoiceBillingModelAllowed("fixed_price"),
    /Fixed-price projects cannot create approved-cost invoices/,
  );

  for (const model of [
    "cost_plus_percent",
    "cost_plus_fixed_fee",
    "cost_plus_gmp",
    "time_and_materials",
  ]) {
    assert.equal(isCostDrivenBillingModel(model), true);
    assert.doesNotThrow(() =>
      assertApprovedCostInvoiceBillingModelAllowed(model),
    );
  }
});

test("cost-driven projects can promote approved sources into the billable ledger", () => {
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "cost_plus_gmp",
      sourceType: "vendor_bill_line",
      sourceStatus: "approved",
    }),
  );
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "cost_plus_percent",
      sourceType: "project_expense",
      sourceStatus: "approved",
    }),
  );
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "time_and_materials",
      sourceType: "time_entry",
      sourceStatus: "pm_approved",
      clientCostApprovalRequired: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "time_and_materials",
      sourceType: "time_entry",
      sourceStatus: "client_approved",
      clientCostApprovalRequired: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "cost_plus_gmp",
      sourceType: "time_entry",
      sourceStatus: "client_approved",
      clientCostApprovalRequired: true,
    }),
  );

  assert.throws(
    () =>
      assertCostSourceCanEnterBillableLedger({
        billingModel: "cost_plus_gmp",
        sourceType: "vendor_bill_line",
        sourceStatus: "pending",
      }),
    /Vendor bill must be approved/,
  );
  assert.throws(
    () =>
      assertCostSourceCanEnterBillableLedger({
        billingModel: "fixed_price",
        sourceType: "project_expense",
        sourceStatus: "approved",
      }),
    /Only cost-driven projects/,
  );
});

test("vendor bill billability defaults on for cost-driven projects and fixed-price allocations remain blocked", () => {
  const vendorBillSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../lib/services/vendor-bills.ts"),
    "utf8",
  );
  const costPlusSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../lib/services/cost-plus.ts"),
    "utf8",
  );

  assert.match(
    vendorBillSource,
    /billingModelByProject[\s\S]*line\.billable_to_customer !== false/,
  );
  assert.match(costPlusSource, /metadata\?\.billable_to_customer === true/);
  assert.match(
    vendorBillSource,
    /voidBillableCostsForVendorBill[\s\S]*replaceBillLineCoding/,
  );
  assert.match(
    vendorBillSource,
    /voidJobCostEntriesForVendorBill[\s\S]*replaceBillLineCoding/,
  );
});

test("approved-cost invoices cannot be edited directly and release billing-period locks", () => {
  const invoiceSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );
  const billingPeriodSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/billing-periods.ts"),
    "utf8",
  );

  assert.match(
    invoiceSource,
    /Approved-cost invoices are controlled by the cost ledger/,
  );
  assert.match(invoiceSource, /releaseInvoiceFromBillingPeriod/);
  assert.match(billingPeriodSource, /released_invoice_id/);
  assert.match(billingPeriodSource, /billing_period_id:\s*null/);
});

test("cost-plus ledger carries budget-line and GMP classification on billable costs", () => {
  const costPlusSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/cost-plus.ts"),
    "utf8",
  );
  const jobCostSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/job-cost-actuals.ts"),
    "utf8",
  );
  const migrationSource = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260707192900_cost_plus_integrity_hardening.sql",
    ),
    "utf8",
  );

  assert.match(costPlusSource, /resolveGmpClassificationForCostSource/);
  assert.match(costPlusSource, /budget_line_id/);
  assert.match(jobCostSource, /gmp_classification/);
  assert.match(migrationSource, /add column if not exists budget_line_id/);
});

test("cost-plus guardrails cover locked costs, direct change orders, manual adjustments, and tie-outs", () => {
  const costPlusSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/cost-plus.ts"),
    "utf8",
  );
  const invoiceSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );
  const reconciliationSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/reports/reconciliation.ts"),
    "utf8",
  );
  const actionsSource = fs.readFileSync(
    path.join(__dirname, "../app/(app)/projects/[id]/financials/actions.ts"),
    "utf8",
  );
  const reviewQueueSource = fs.readFileSync(
    path.join(__dirname, "../components/cost-inbox/cost-inbox-table.tsx"),
    "utf8",
  );

  assert.match(costPlusSource, /currently locked by invoice creation/);
  assert.match(invoiceSource, /Do not invoice change orders directly/);
  assert.match(costPlusSource, /createManualBillableAdjustment/);
  assert.match(actionsSource, /createManualBillableAdjustmentAction/);
  assert.match(reviewQueueSource, /adjustmentDialogOpen/);
  assert.match(reconciliationSource, /incurred_billable_tieout/);
});

test("reconciliation report has a real route and trust center stays retired", () => {
  const reconciliationSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/reports/reconciliation.ts"),
    "utf8",
  );
  // Reports are registry-driven: the slug in lib/reports/definitions/financial.ts
  // is what makes /projects/[id]/reports/reconciliation resolve.
  const financialDefinitions = fs.readFileSync(
    path.join(__dirname, "../lib/reports/definitions/financial.ts"),
    "utf8",
  );
  const projectReportRoute = fs.readFileSync(
    path.join(__dirname, "../app/(app)/projects/[id]/reports/[slug]/page.tsx"),
    "utf8",
  );
  const trustCenterPage = fs.readFileSync(
    path.join(
      __dirname,
      "../app/(app)/projects/[id]/financials/trust-center/page.tsx",
    ),
    "utf8",
  );
  const projectNav = fs.readFileSync(
    path.join(__dirname, "../components/layout/project-nav-items.ts"),
    "utf8",
  );

  assert.match(reconciliationSource, /incurred_billable_tieout/);
  assert.match(financialDefinitions, /slug: "reconciliation"/);
  assert.match(financialDefinitions, /getProjectReconciliationReport/);
  assert.match(projectReportRoute, /getReportDefinition/);
  // Trust Center was deliberately removed from nav (navigation-scopes refactor);
  // its route must stay a redirect into the reconciliation report.
  assert.match(trustCenterPage, /redirect\(/);
  assert.match(trustCenterPage, /reports\/reconciliation/);
  assert.doesNotMatch(projectNav, /trust-center/);
});

test("markup and retainage policies are explicit in cost-plus billing", () => {
  const costPlusSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/cost-plus.ts"),
    "utf8",
  );
  const projectSetupSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/project-financial-setup.ts"),
    "utf8",
  );
  const migrationSource = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260707192900_cost_plus_integrity_hardening.sql",
    ),
    "utf8",
  );

  assert.match(
    costPlusSource,
    /contractRule[\s\S]*rawContractMarkup[\s\S]*defaultCostCodeMarkup/,
  );
  assert.match(
    costPlusSource,
    /applyRetainageToInvoiceDraft\([\s\S]*retainageAppliesToFee = false/,
  );
  assert.match(
    costPlusSource,
    /!retainageAppliesToFee && isInvoiceDraftFeeLine/,
  );
  assert.match(
    projectSetupSource,
    /retainageAppliesToFee: z\.boolean\(\)\.default\(false\)/,
  );
  assert.match(
    migrationSource,
    /retainage_applies_to_fee boolean not null default false/,
  );
});

test("approved-cost invoice idempotency key is stable, sorted, and sensitive to invoice facts", () => {
  const preview = {
    lines: [],
    totals: {
      cost_cents: 12000,
      markup_cents: 2400,
      billable_cents: 14400,
    },
  };
  const base = {
    orgId: "org-1",
    projectId: "project-1",
    invoiceNumber: "INV-100",
    costIds: ["cost-2", "cost-1"],
    preview,
    reservationId: "reservation-1",
  };

  const first = buildApprovedCostInvoiceIdempotencyKey(base);
  const sortedDifferently = buildApprovedCostInvoiceIdempotencyKey({
    ...base,
    costIds: ["cost-1", "cost-2"],
  });
  const changedTotal = buildApprovedCostInvoiceIdempotencyKey({
    ...base,
    preview: {
      ...preview,
      totals: { ...preview.totals, billable_cents: 14500 },
    },
  });
  const changedReservation = buildApprovedCostInvoiceIdempotencyKey({
    ...base,
    reservationId: "reservation-2",
  });

  assert.equal(first, sortedDifferently);
  assert.notEqual(first, changedTotal);
  assert.notEqual(first, changedReservation);
  assert.match(first, /^approved_cost_invoice:[a-f0-9]{48}$/);
});

test("approved-cost invoice creation remains routed through the atomic RPC", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/approved-cost-invoicing.ts"),
    "utf8",
  );

  assert.match(source, /rpc\("create_invoice_from_billable_costs_atomic"/);
  assert.match(source, /p_idempotency_key:\s*idempotencyKey/);
  assert.match(source, /Approved-cost invoice includes duplicate costs/);
});

test("budget actuals include vendor bills, expenses, and time exactly once", () => {
  const actuals = summarizeJobCostEntriesByCostCode([
    {
      org_id: "org-1",
      cost_code_id: "03-100",
      source_type: "vendor_bill_line",
      source_id: "bill-line-1",
      cost_cents: 10000,
      status: "posted",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "03-100",
      source_type: "vendor_bill_line",
      source_id: "bill-line-1",
      cost_cents: 10000,
      status: "posted",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "03-100",
      source_type: "project_expense",
      source_id: "expense-1",
      cost_cents: 2500,
      status: "posted",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "03-100",
      source_type: "time_entry",
      source_id: "time-1",
      cost_cents: 6400,
      status: "posted",
      is_billable: false,
    },
  ]);

  assert.deepEqual(actuals, [
    {
      cost_code_id: "03-100",
      budget_line_id: null,
      actual_cents: 18900,
      billable_actual_cents: 12500,
      non_billable_actual_cents: 6400,
      entry_count: 3,
    },
  ]);
});

test("voided vendor bill actuals are ignored and reversal rows reduce actuals", () => {
  const actuals = summarizeJobCostEntriesByCostCode([
    {
      org_id: "org-1",
      cost_code_id: "04-200",
      source_type: "vendor_bill_line",
      source_id: "bill-line-voided",
      cost_cents: 18000,
      status: "voided",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "04-200",
      source_type: "manual_adjustment",
      source_id: "reversal-1",
      cost_cents: -7000,
      status: "posted",
      is_billable: true,
    },
    {
      org_id: "org-1",
      cost_code_id: "04-200",
      source_type: "vendor_bill_line",
      source_id: "replacement-line",
      cost_cents: 12000,
      status: "posted",
      is_billable: true,
    },
  ]);

  assert.deepEqual(actuals, [
    {
      cost_code_id: "04-200",
      budget_line_id: null,
      actual_cents: 5000,
      billable_actual_cents: 5000,
      non_billable_actual_cents: 0,
      entry_count: 2,
    },
  ]);
});

test("owner portal open-book detail respects open_book=false", () => {
  assert.equal(shouldExposeOpenBookCostDetail(false), false);
  assert.equal(shouldExposeOpenBookCostDetail(true), true);
  assert.equal(shouldExposeOpenBookCostDetail(null), true);
  assert.equal(shouldExposeOpenBookCostDetail(undefined), true);
});

test("closed billing periods block invoice creation and in-place edits", () => {
  for (const status of ["open", "reviewing", "reopened"]) {
    assert.doesNotThrow(() =>
      assertBillingPeriodStatusAllowsInvoice({ name: "May 2026", status }),
    );
    assert.doesNotThrow(() =>
      assertBillingPeriodStatusAllowsEdit(
        { name: "May 2026", status },
        "Vendor bill",
      ),
    );
  }

  for (const status of ["closed", "invoiced"]) {
    assert.throws(
      () =>
        assertBillingPeriodStatusAllowsInvoice({ name: "May 2026", status }),
      /reopen it before creating another approved-cost invoice/,
    );
    assert.throws(
      () =>
        assertBillingPeriodStatusAllowsEdit(
          { name: "May 2026", status },
          "Vendor bill",
        ),
      /handle it as a late-cost adjustment/,
    );
  }
});

test("receivables mutations remain routed through atomic database functions", () => {
  const paymentSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/payments.ts"),
    "utf8",
  );
  const projectActions = fs.readFileSync(
    path.join(__dirname, "../app/(app)/projects/[id]/actions.ts"),
    "utf8",
  );
  const lateFeeJob = fs.readFileSync(
    path.join(__dirname, "../app/api/jobs/late-fees/route.ts"),
    "utf8",
  );
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260607120000_receivables_hardening_and_autopilot.sql",
    ),
    "utf8",
  );

  assert.match(
    paymentSource,
    /rpc\(\s*"apply_invoice_payment_with_details_atomic"/,
  );
  const booksHardening = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812120755_books_release_hardening.sql",
    ),
    "utf8",
  );
  assert.match(booksHardening, /public\.apply_invoice_payment_atomic\(/);
  assert.match(paymentSource, /rpc\("record_payment_reversal_atomic"/);
  assert.match(projectActions, /rpc\("release_project_retainage_atomic"/);
  assert.match(
    projectActions,
    /p_reservation_id: next\.reservation_id \?\? null/,
  );
  assert.match(lateFeeJob, /rpc\("apply_invoice_late_fee_atomic"/);
  assert.match(migration, /for update/);
  assert.match(migration, /invoices_sync_retainage_release_status/);
});

test("commercial pay applications preserve base contract sums and reject unsafe posting", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/pay-applications.ts"),
    "utf8",
  );
  const correction = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260711191000_pay_application_void_corrections.sql",
    ),
    "utf8",
  );

  assert.match(source, /snapshot\?\.base_total_cents/);
  assert.ok(
    source.indexOf(
      "if (overbilledLines.length > 0 && !parsed.allow_overbilling)",
    ) < source.indexOf("for (const update of pendingUpdates)"),
  );
  assert.match(source, /overbilling_confirmed/);
  assert.match(
    source,
    /contains overbilled lines that have not been explicitly confirmed/,
  );
  assert.match(correction, /metadata ->> 'type'.*= 'retainage_release'/);
  assert.match(
    correction,
    /retainage_released_cents = retainage_released_cents - v_release_take/,
  );
  assert.match(correction, /order by line_number desc/);
  assert.match(correction, /set search_path = ''/);
  assert.match(correction, /permission_key = 'payapp\.write'/);
  assert.match(correction, /m\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(
    correction,
    /revoke all on function public\.void_pay_application\(uuid, uuid\) from public, anon, authenticated/,
  );
});

test("commercial claims use executed OCO numbering and reconcile pay-app receivables", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260711194000_commercial_claims_completion.sql",
    ),
    "utf8",
  );
  const changeOrders = fs.readFileSync(
    path.join(__dirname, "../lib/services/change-orders.ts"),
    "utf8",
  );
  const payApps = fs.readFileSync(
    path.join(__dirname, "../lib/services/pay-applications.ts"),
    "utf8",
  );

  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('oco:'/);
  assert.match(
    migration,
    /create unique index if not exists change_orders_project_executed_number_key/,
  );
  assert.match(migration, /where executed_change_order_number is not null/);
  assert.match(migration, /trg_reconcile_pay_application_invoice_status/);
  assert.match(
    migration,
    /set status = 'paid', paid_at = coalesce\(paid_at, now\(\)\)/,
  );
  assert.doesNotMatch(migration, /(?:new|old|i)\.paid_at/);
  assert.match(changeOrders, /executed_change_order_number/);
  assert.match(changeOrders, /`PCO-\$\{String\(changeOrder\.co_number\)/);
  assert.match(payApps, /permission: "invoice\.approve"/);
  assert.match(
    payApps,
    /update\(\{ status: "approved", approved_at: approvedAt \}\)/,
  );
});

test("change-order content edits cannot perform lifecycle transitions", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/change-orders.ts"),
    "utf8",
  );
  const correction = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260711191000_pay_application_void_corrections.sql",
    ),
    "utf8",
  );

  assert.match(service, /lifecycle: existing\.lifecycle \?\? "draft"/);
  assert.match(service, /lifecycle: "draft"/);
  assert.doesNotMatch(
    service,
    /lifecycle: existing\.lifecycle === "proposed" \? "proposed" : input\.lifecycle/,
  );
  assert.match(service, /rpc\("void_approved_change_order_atomic"/);
  assert.match(
    correction,
    /create or replace function public\.void_approved_change_order_atomic/,
  );
  assert.match(correction, /permission_key = 'change_order\.approve'/);
  assert.match(correction, /update public\.budget_revisions/);
  assert.match(correction, /delete from public\.prime_sov_lines/);
  assert.match(correction, /update public\.contracts/);
  assert.match(correction, /update public\.draw_schedules/);
  assert.match(
    correction,
    /revoke all on function public\.void_approved_change_order_atomic/,
  );
});

test("financial jobs and public payment links keep their authorization boundaries", () => {
  for (const route of ["reminders", "late-fees"]) {
    const source = fs.readFileSync(
      path.join(__dirname, `../app/api/jobs/${route}/route.ts`),
      "utf8",
    );
    assert.match(source, /isAuthorizedCronRequest/);
    assert.match(source, /status:\s*401/);
  }

  // The public invoice page is the one pay surface. Reminders may only link an
  // invoice its client can already see — never mint bearer access to an
  // unpublished one.
  const remindersRoute = fs.readFileSync(
    path.join(__dirname, "../app/api/jobs/reminders/route.ts"),
    "utf8",
  );
  assert.match(
    remindersRoute,
    /reminder\.invoice\.client_visible && reminder\.invoice\.token/,
  );
  assert.doesNotMatch(remindersRoute, /createPersistedPayLink/);
});

test("sent and synchronized invoices are immutable through the standard editor", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );

  assert.match(
    source,
    /existing\.sent_at \|\| hasAccountingExternalId\(existingAccountingState\)/,
  );
  assert.match(source, /Issued or accounting-synced invoices are immutable/);
  assert.match(source, /client_visible", true/);
  assert.match(source, /neq\("status", "void"\)/);
});

test("Arc Autopilot is opt-in and prepares review runs without posting invoices", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/billing-autopilot.ts"),
    "utf8",
  );

  assert.match(source, /flagKey:\s*FLAG_KEY/);
  assert.match(source, /defaultEnabled:\s*false/);
  assert.match(
    source,
    /Nothing is posted or sent automatically|status:\s*"prepared"/,
  );
  assert.doesNotMatch(source, /createInvoice\(/);
});

test("draw billing creates a linked review draft instead of issuing immediately", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/draws.ts"),
    "utf8",
  );

  // Callers state intent (`issue`), never a status. A draw builds a draft that a
  // person still has to send.
  assert.match(source, /issue:\s*false/);
  assert.doesNotMatch(source, /status:\s*"saved"/);
  assert.doesNotMatch(source, /client_visible:/);
  assert.match(source, /source_type:\s*"draw"/);
  assert.match(source, /source_draw_id:\s*draw\.id/);
});

test("invoice revisions preserve the original and create a linked replacement draft", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );
  const client = fs.readFileSync(
    path.join(__dirname, "../components/invoices/billing-queue.tsx"),
    "utf8",
  );

  assert.match(service, /export async function reviseInvoice/);
  assert.match(
    service,
    /const service = createServiceSupabaseClient\(\)[\s\S]*service\.rpc\("revise_invoice_atomic"/,
  );
  assert.doesNotMatch(service, /export async function reviseInvoice[\s\S]*await voidInvoice/);
  assert.match(service, /revision_of_invoice_id/);
  assert.match(service, /replaced_by_invoice_id/);
  assert.match(client, /Revise and reissue/);
});

test("atomic invoice correction RPCs are service-only after application permission checks", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812152902_receivables_atomic_revisions.sql",
    ),
    "utf8",
  );

  assert.match(
    service,
    /requireInvoicePermission\([\s\S]*permission:\s*"invoice\.write"[\s\S]*createServiceSupabaseClient\(\)[\s\S]*service\.rpc\("void_invoice_atomic"/,
  );
  assert.match(
    migration,
    /revoke all on function public\.void_invoice_atomic\([^;]+\) from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /revoke all on function public\.revise_invoice_atomic\([^;]+\) from public, anon, authenticated/,
  );
  assert.doesNotMatch(migration, /grant execute[^;]+to authenticated/);
  assert.match(migration, /^begin;$/m);
  assert.match(migration, /^commit;$/m);
});

test("invoice writes and commercial approvals cannot bypass application permissions", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812145624_receivables_foundation.sql",
    ),
    "utf8",
  );

  for (const rpc of [
    "create_invoice_atomic",
    "update_invoice_atomic",
    "request_invoice_approval",
    "decide_invoice_approval",
  ]) {
    assert.match(service, new RegExp(`service\\.rpc\\("${rpc}"`));
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${rpc}\\([^;]+\\) from public, anon, authenticated`),
    );
  }
  assert.doesNotMatch(migration, /grant execute[^;]+to authenticated/);
  assert.doesNotMatch(
    migration,
    /grant select, insert, update on public\.invoice_(?:deliveries|approval_requests) to authenticated/,
  );
  assert.match(migration, /grant select on public\.invoice_deliveries to authenticated/);
  assert.match(migration, /grant select on public\.invoice_approval_requests to authenticated/);
});

test("invoice reminders require send authority before service-owned delivery writes", () => {
  const actions = fs.readFileSync(
    path.join(__dirname, "../app/(app)/invoices/actions.ts"),
    "utf8",
  );
  const reminder = actions.slice(
    actions.indexOf("async function sendInvoiceReminder"),
    actions.indexOf("export async function getInvoiceComposerContextAction"),
  );

  assert.match(reminder, /permission:\s*"invoice\.send"/);
  assert.match(reminder, /const service = createServiceSupabaseClient\(\)/);
  assert.match(reminder, /service[\s\S]*\.from\("invoice_deliveries"\)/);
});

test("retainage is derived from the active contract and shown before invoice issuance", () => {
  const invoiceService = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );
  const composer = fs.readFileSync(
    path.join(__dirname, "../components/invoices/invoice-document-editor.tsx"),
    "utf8",
  );
  const receivables = fs.readFileSync(
    path.join(__dirname, "../components/financials/billing-tab.tsx"),
    "utf8",
  );
  const retainageTracker = fs.readFileSync(
    path.join(__dirname, "../components/projects/retainage-tracker.tsx"),
    "utf8",
  );

  assert.match(
    invoiceService,
    /sourceType !== "manual" && sourceType !== "draw" && sourceType !== "change_order"/,
  );
  // The retainage row is written inside create_invoice_atomic / update_invoice_atomic,
  // in the same transaction as the invoice — never a second time from the service.
  const retainageMigration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260829120000_billing_lifecycle_and_command_permissions.sql"),
    "utf8",
  );
  assert.match(retainageMigration, /insert into public\.retainage/);
  assert.doesNotMatch(invoiceService, /upsertRetainageForInvoice/);
  assert.match(composer, /billing_contract\?\.retainage_percent/);
  assert.match(composer, /Retainage held/);
  assert.match(receivables, /billing_contract: contract/);
  assert.match(receivables, /projects=\{\[invoiceProject\]\}/);
  assert.doesNotMatch(retainageTracker, /updateProjectSettingsAction/);
  assert.doesNotMatch(retainageTracker, /Total Project Value/);
});

test("contract value uses base plus approved changes exactly once", () => {
  const projectService = fs.readFileSync(
    path.join(__dirname, "../lib/services/projects.ts"),
    "utf8",
  );
  const overview = fs.readFileSync(
    path.join(
      __dirname,
      "../components/projects/overview/project-overview-stats.tsx",
    ),
    "utf8",
  );
  const contractCard = fs.readFileSync(
    path.join(__dirname, "../components/projects/contract-summary-card.tsx"),
    "utf8",
  );
  const drawManager = fs.readFileSync(
    path.join(__dirname, "../components/projects/draw-schedule-manager.tsx"),
    "utf8",
  );

  assert.match(
    projectService,
    /revisedTotalCents = baseTotalCents == null \? null : baseTotalCents \+ approvedChangeOrdersCents/,
  );
  assert.match(overview, /const totalContractCents = contractTotalCents/);
  assert.match(contractCard, /const revisedTotal = contractTotal/);
  assert.match(drawManager, /return contract\?\.total_cents \?\? 0/);
  assert.doesNotMatch(drawManager, /contract\?\.total_cents \?\? 0\) \+ /);
});

test("Autopilot treats completed linked milestones as billing evidence", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/billing-autopilot.ts"),
    "utf8",
  );

  assert.match(source, /from\("schedule_items"\)/);
  assert.match(source, /milestoneComplete/);
  assert.match(source, /Number\(milestone\.progress \?\? 0\) >= 100/);
  assert.match(source, /Review the draw before preparing its invoice/);
});

test("fixed-price pay-app packages carry GC compliance and required full-tier waivers", () => {
  const packageService = fs.readFileSync(
    path.join(__dirname, "../lib/services/owner-billing-packages.ts"),
    "utf8",
  );
  const actions = fs.readFileSync(
    path.join(__dirname, "../app/(app)/projects/[id]/financials/actions.ts"),
    "utf8",
  );
  const payAppUi = fs.readFileSync(
    path.join(__dirname, "../components/financials/pay-applications-tab.tsx"),
    "utf8",
  );

  assert.match(packageService, /source_pay_application_id/);
  assert.match(packageService, /sourcePayApplication\?\.period_end/);
  assert.match(packageService, /eq\("subject", "org"\)/);
  assert.match(packageService, /require_subtier_waivers/);
  assert.match(packageService, /role:.*"gc_compliance".*"lien_waiver"/);
  assert.match(actions, /generatePayApplicationPackageAction/);
  assert.match(actions, /generateSovPayApplicationPdf/);
  assert.match(actions, /generateInvoiceBackupPackage/);
  assert.match(payAppUi, /Attach our bonds, insurance, and licenses/);
  assert.match(payAppUi, /Full-tier lien waivers are included automatically/);
});

test("sub-tier waiver queries disambiguate the org-scoped commitment relationship", () => {
  const waiverService = fs.readFileSync(
    path.join(__dirname, "../lib/services/lien-waivers.ts"),
    "utf8",
  );

  const relationshipHint =
    "commitments!subtier_requirements_commitment_org_fkey";
  assert.equal(waiverService.split(relationshipHint).length - 1, 2);
  assert.doesNotMatch(waiverService, /commitment:commitments\(id, title\)/);
});

test("the invoice lifecycle is derived by the server, never supplied by a caller", () => {
  const validation = fs.readFileSync(
    path.join(__dirname, "../lib/validation/invoices.ts"),
    "utf8",
  );
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );

  // The public input carries INTENT and no state at all. While `status` was an
  // input, "paid with a full balance due" and "sent with no recipient" were both
  // things a caller could simply ask for.
  assert.doesNotMatch(validation, /status:\s*z\.enum/);
  assert.doesNotMatch(validation, /client_visible:\s*z\.boolean/);
  assert.match(validation, /issue:\s*z\.boolean\(\)\.default\(false\)/);

  // And the service derives it from that one flag.
  assert.match(service, /const lifecycleStatus: InvoiceLifecycleStatus = shouldIssue \? "sent" : "draft"/);
  assert.doesNotMatch(service, /status:\s*input\.status/);
});

test("an invoice edit cannot relocate the invoice past the move authorization", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260829120000_billing_lifecycle_and_command_permissions.sql"),
    "utf8",
  );

  // updateInvoice authorizes against the invoice's CURRENT project. Accepting a
  // different project_id would move it without the two-project check that
  // moveInvoiceToProject exists to perform.
  assert.match(service, /Use .{1,3}Move to project.{1,3} to change an invoice's project/);
  assert.match(migration, /An invoice edit cannot change its project/);
  assert.match(service, /export async function moveInvoiceToProject/);
});

test("money rows are readable by members and writable only by commands", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260829120000_billing_lifecycle_and_command_permissions.sql"),
    "utf8",
  );
  const writer = fs.readFileSync(
    path.join(__dirname, "../lib/services/receivables-writer.ts"),
    "utf8",
  );

  // The old policies tested org/project MEMBERSHIP for writes, which is tenancy,
  // not authorization — so invoice.write / invoice.send / payment.release lived
  // only in application code and any member could bypass them with a direct write.
  for (const table of ["invoices", "invoice_lines", "payments", "payment_intents"]) {
    assert.match(
      migration,
      new RegExp(`revoke insert, update, delete on public\\.${table} from authenticated`),
      table,
    );
    assert.match(migration, new RegExp(`grant select on public\\.${table} to authenticated`), table);
  }
  assert.match(migration, /create policy invoices_read on public\.invoices\s+for select/);
  assert.match(migration, /create policy payments_read on public\.payments\s+for select/);
  // Every auth.* call inside an RLS policy stays wrapped in a subquery so it is
  // evaluated once per statement rather than once per row (the initplan perf bug
  // fixed Jul 2026). Function bodies are exempt — plpgsql evaluates them once.
  const policySection = migration.slice(migration.indexOf("drop policy if exists invoices_access"));
  assert.doesNotMatch(policySection, /(?<!select )auth\.(uid|role)\(\)/);
  assert.match(policySection, /\(select auth\.role\(\)\) = 'service_role'/);
  assert.match(writer, /export function receivablesWriter/);
});

test("payments only apply to invoices that were actually billed", () => {
  const payments = fs.readFileSync(
    path.join(__dirname, "../lib/services/payments.ts"),
    "utf8",
  );
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260829120000_billing_lifecycle_and_command_permissions.sql"),
    "utf8",
  );

  // A draft carries balance_due_cents equal to its total from the moment it is
  // created, and the only database guard was `status = 'void'` — so a draft could
  // be settled and flipped to paid without ever going out.
  assert.match(payments, /if \(!isIssuedInvoiceStatus\(invoice\.status\)\)/);
  assert.match(migration, /Cannot apply payment to an invoice that has not been issued/);
  assert.match(migration, /create trigger payments_require_billable_invoice/);
});

test("issuing an invoice is durable and cannot double-deliver on retry", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );
  const worker = fs.readFileSync(
    path.join(__dirname, "../app/api/jobs/process-outbox/route.ts"),
    "utf8",
  );

  // One durable record is written BEFORE the side effects run, so a crash between
  // "committed as sent" and "email left the building" is recoverable.
  assert.match(service, /enqueueOutboxJob\(\{[\s\S]{0,240}INVOICE_ISSUANCE_JOB_TYPE/);
  assert.match(service, /dedupeByPayloadKeys: \["invoice_id"\]/);
  assert.match(service, /export async function runInvoiceIssuance/);
  assert.match(worker, /job\.job_type === INVOICE_ISSUANCE_JOB_TYPE/);
  // …and the retry cannot bill anyone twice.
  assert.match(service, /const pendingRecipients = uniqueRecipients\.filter/);
  assert.match(service, /to: pendingRecipients/);
});

test("open AR means the same thing to the reports, the queue, and the AI", () => {
  const aiTools = fs.readFileSync(
    path.join(__dirname, "../lib/services/ai-search/tools.ts"),
    "utf8",
  );
  const aiFinancial = fs.readFileSync(
    path.join(__dirname, "../lib/services/ai-search/financial.ts"),
    "utf8",
  );

  // Both files declared their own OPEN_INVOICE_STATUSES including `draft` and
  // `saved`, so "how much do customers owe us?" counted invoices nobody had billed.
  assert.match(aiTools, /const OPEN_INVOICE_STATUSES = OPEN_AR_INVOICE_STATUSES/);
  assert.match(aiFinancial, /const OPEN_INVOICE_STATUSES = OPEN_AR_INVOICE_STATUSES/);
  assert.doesNotMatch(aiTools, /"sent", "partial", "overdue", "saved", "draft"/);
  assert.doesNotMatch(aiFinancial, /"sent", "partial", "overdue", "saved", "draft"/);
  // Revenue billed had no status filter at all, so drafts and voids inflated it.
  assert.match(aiFinancial, /intent\.key === "revenue_billed"[\s\S]{0,300}BILLED_INVOICE_STATUSES/);
});

test("every billing destination is built in one place", () => {
  const destinations = fs.readFileSync(
    path.join(__dirname, "../lib/financials/invoice-destinations.ts"),
    "utf8",
  );
  const retainage = fs.readFileSync(
    path.join(__dirname, "../components/projects/retainage-tracker.tsx"),
    "utf8",
  );
  const reconciliation = fs.readFileSync(
    path.join(__dirname, "../lib/services/reports/reconciliation.ts"),
    "utf8",
  );
  const closeReadiness = fs.readFileSync(
    path.join(__dirname, "../lib/services/project-close-readiness.ts"),
    "utf8",
  );

  assert.match(destinations, /export function invoiceHref/);
  assert.match(destinations, /export function newInvoiceHref/);

  // The legacy project route survives for bookmarks, and now carries the query
  // across instead of swallowing it — including the old `?open=` spelling.
  const legacyRedirect = fs.readFileSync(
    path.join(__dirname, "../app/(app)/projects/[id]/invoices/page.tsx"),
    "utf8",
  );
  assert.match(legacyRedirect, /key === "open" \|\| key === "invoiceId" \? "invoice" : key/);

  // The three contracts that had drifted: `?open=` (never read), the
  // `/projects/:id/invoices` redirect (drops the query), and `/receivables`.
  for (const [name, source] of [
    ["retainage tracker", retainage],
    ["reconciliation report", reconciliation],
    ["close readiness", closeReadiness],
  ]) {
    assert.doesNotMatch(source, /\?open=/, name);
    assert.doesNotMatch(source, /\/invoices\?invoice=/, name);
    assert.doesNotMatch(source, /\/receivables\?invoice=/, name);
    assert.match(source, /invoiceHref\(/, name);
  }
});

test("the invoice inspector is the only invoice detail surface", () => {
  const componentsDir = path.join(__dirname, "../components/invoices");
  const files = fs.readdirSync(componentsDir);

  // The legacy sheet was a second implementation with its own idea of which
  // sections exist, so attachments and internal notes lived in one and payments
  // in the other. Both consumers now render the canonical inspector.
  assert.ok(!files.includes("invoice-detail-sheet.tsx"));
  assert.ok(!files.includes("invoices-client.tsx"));
  assert.ok(!files.includes("receivables-workspace.tsx"));
  assert.ok(files.includes("invoice-inspector.tsx"));

  for (const relative of [
    "../components/projects/draw-schedule-manager.tsx",
    "../components/cost-inbox/cost-inbox-detail-overlays.tsx",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, relative), "utf8");
    assert.match(source, /InvoiceInspectorSheet/, relative);
    assert.doesNotMatch(source, /InvoiceDetailSheet/, relative);
  }
});

test("composing an invoice owns a route instead of a dismissible sheet", () => {
  const composer = fs.readFileSync(
    path.join(__dirname, "../components/invoices/invoice-composer.tsx"),
    "utf8",
  );
  const routeExists = fs.existsSync(
    path.join(__dirname, "../app/(app)/projects/[id]/financials/billing/new/page.tsx"),
  );

  assert.ok(routeExists, "the composer needs its own route");
  // Review reads the SAVED draft, so what a person approves is what will be issued.
  assert.match(composer, /getInvoiceDetailAction\(invoiceId\)/);
  assert.match(composer, /issueInvoiceAction\(invoice\.id, parsedRecipients\)/);
  // And the number reservation is only released when no draft was produced.
  assert.match(composer, /if \(!reservationId \|\| draftIdRef\.current\) return/);
});

test("the billing queue filters, counts and pages in the database", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );
  const queue = fs.readFileSync(
    path.join(__dirname, "../components/invoices/billing-queue.tsx"),
    "utf8",
  );

  // Counting a loaded page while the aging strip covers the whole book is how the
  // two came to disagree on a project with more than one page of invoices.
  assert.match(service, /export async function listInvoicePage/);
  assert.match(service, /export async function getInvoiceQueueCounts/);
  assert.match(service, /\{ count: "exact" \}/);
  assert.match(queue, /loadInvoiceQueueAction/);
  assert.doesNotMatch(queue, /invoiceQueueCounts\(/);

  // A late response for an invoice the user already left must not overwrite the
  // one they are looking at.
  assert.match(queue, /if \(seq !== detailSeq\.current\) return/);
});

test("an invoice cannot reach `sent` without an immutable record of what was billed", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/invoices.ts"),
    "utf8",
  );

  // createInvoice/updateInvoice write it from their input; issueInvoice — the
  // command the queue and the composer's review step both use — writes it from
  // the persisted row. All three paths, or the snapshot is not a record.
  const issueBody = service.slice(
    service.indexOf("export async function issueInvoice"),
    service.indexOf("export async function requestInvoiceApproval"),
  );
  assert.match(issueBody, /issued_snapshot: issuedSnapshot/);
  assert.match(issueBody, /schema_version: 1/);
  assert.match(issueBody, /recipients: sentTo/);
  // …and it refuses to issue anything already issued, or voided.
  assert.match(issueBody, /This invoice has already been issued/);
  assert.match(issueBody, /A voided invoice cannot be issued/);
});

test("the invoice detail shares the page with the list instead of covering it", () => {
  const queue = fs.readFileSync(
    path.join(__dirname, "../components/invoices/billing-queue.tsx"),
    "utf8",
  );
  const shell = path.join(__dirname, "../components/financials/workspace/workspace-shell.tsx");

  // The predecessor was a fixed full-screen takeover that hid the list behind the
  // record you were reading, and squeezed the document into 550px. The panel is
  // now a flex sibling whose WIDTH animates, so opening it narrows the table and
  // closing it hands the space straight back.
  assert.doesNotMatch(queue, /fixed inset-0/);
  assert.match(queue, /transition-\[width\]/);
  assert.match(queue, /motion-reduce:transition-none/);

  // Nothing is reserved, and nothing is rendered, while nothing is selected.
  assert.match(queue, /: "hidden w-0 lg:block"/);
  assert.doesNotMatch(queue, /<InvoiceInspectorEmpty \/>/);

  // The clip that hides the fixed-width contents mid-animation has to sit ON the
  // sticky element: an overflow ancestor captures a sticky descendant and stops
  // it sticking, which is silent and only shows up when the table is long.
  const aside = queue.slice(queue.indexOf("<aside"), queue.indexOf("</aside>"));
  assert.match(aside, /overflow-hidden[^"]*"[\s\S]{0,200}lg:sticky/);

  // The old workspace shell is still used by expenses; it just no longer owns
  // receivables. If that ever changes, this test should be the thing that notices.
  assert.ok(fs.existsSync(shell));
});
