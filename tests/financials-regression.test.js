require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  assertApprovedCostInvoiceBillingModelAllowed,
  isCostDrivenBillingModel,
  shouldExposeOpenBookCostDetail,
} = require("../lib/financials/billing-model")
const { assertCostSourceCanEnterBillableLedger } = require("../lib/financials/billable-ledger-rules")
const { buildApprovedCostInvoiceIdempotencyKey } = require("../lib/financials/approved-cost-rules")
const { summarizeJobCostEntriesByCostCode } = require("../lib/financials/job-cost-rules")
const {
  assertBillingPeriodStatusAllowsEdit,
  assertBillingPeriodStatusAllowsInvoice,
} = require("../lib/financials/billing-period-rules")

test("fixed-price projects cannot create approved-cost invoices", () => {
  assert.throws(
    () => assertApprovedCostInvoiceBillingModelAllowed("fixed_price"),
    /Fixed-price projects cannot create approved-cost invoices/,
  )

  for (const model of ["cost_plus_percent", "cost_plus_fixed_fee", "cost_plus_gmp", "time_and_materials"]) {
    assert.equal(isCostDrivenBillingModel(model), true)
    assert.doesNotThrow(() => assertApprovedCostInvoiceBillingModelAllowed(model))
  }
})

test("cost-driven projects can promote approved sources into the billable ledger", () => {
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "cost_plus_gmp",
      sourceType: "vendor_bill_line",
      sourceStatus: "approved",
    }),
  )
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "cost_plus_percent",
      sourceType: "project_expense",
      sourceStatus: "approved",
    }),
  )
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "time_and_materials",
      sourceType: "time_entry",
      sourceStatus: "pm_approved",
      clientCostApprovalRequired: false,
    }),
  )
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "time_and_materials",
      sourceType: "time_entry",
      sourceStatus: "client_approved",
      clientCostApprovalRequired: false,
    }),
  )
  assert.doesNotThrow(() =>
    assertCostSourceCanEnterBillableLedger({
      billingModel: "cost_plus_gmp",
      sourceType: "time_entry",
      sourceStatus: "client_approved",
      clientCostApprovalRequired: true,
    }),
  )

  assert.throws(
    () =>
      assertCostSourceCanEnterBillableLedger({
        billingModel: "cost_plus_gmp",
        sourceType: "vendor_bill_line",
        sourceStatus: "pending",
      }),
    /Vendor bill must be approved/,
  )
  assert.throws(
    () =>
      assertCostSourceCanEnterBillableLedger({
        billingModel: "fixed_price",
        sourceType: "project_expense",
        sourceStatus: "approved",
      }),
    /Only cost-driven projects/,
  )
})

test("vendor bill billability defaults on for cost-driven projects and fixed-price allocations remain blocked", () => {
  const vendorBillSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../lib/services/vendor-bills.ts"),
    "utf8",
  )
  const costPlusSource = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../lib/services/cost-plus.ts"),
    "utf8",
  )

  assert.match(vendorBillSource, /billingModelByProject[\s\S]*line\.billable_to_customer !== false/)
  assert.match(costPlusSource, /metadata\?\.billable_to_customer === true/)
  assert.match(vendorBillSource, /voidBillableCostsForVendorBill[\s\S]*replaceBillLineCoding/)
  assert.match(vendorBillSource, /voidJobCostEntriesForVendorBill[\s\S]*replaceBillLineCoding/)
})

test("approved-cost invoices cannot be edited directly and release billing-period locks", () => {
  const invoiceSource = fs.readFileSync(path.join(__dirname, "../lib/services/invoices.ts"), "utf8")
  const billingPeriodSource = fs.readFileSync(path.join(__dirname, "../lib/services/billing-periods.ts"), "utf8")

  assert.match(invoiceSource, /Approved-cost invoices are controlled by the cost ledger/)
  assert.match(invoiceSource, /releaseInvoiceFromBillingPeriod/)
  assert.match(billingPeriodSource, /released_invoice_id/)
  assert.match(billingPeriodSource, /billing_period_id:\s*null/)
})

test("cost-plus ledger carries budget-line and GMP classification on billable costs", () => {
  const costPlusSource = fs.readFileSync(path.join(__dirname, "../lib/services/cost-plus.ts"), "utf8")
  const jobCostSource = fs.readFileSync(path.join(__dirname, "../lib/services/job-cost-actuals.ts"), "utf8")
  const migrationSource = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260707192900_cost_plus_integrity_hardening.sql"),
    "utf8",
  )

  assert.match(costPlusSource, /resolveGmpClassificationForCostSource/)
  assert.match(costPlusSource, /budget_line_id/)
  assert.match(jobCostSource, /gmp_classification/)
  assert.match(migrationSource, /add column if not exists budget_line_id/)
})

test("cost-plus guardrails cover locked costs, direct change orders, manual adjustments, and tie-outs", () => {
  const costPlusSource = fs.readFileSync(path.join(__dirname, "../lib/services/cost-plus.ts"), "utf8")
  const invoiceSource = fs.readFileSync(path.join(__dirname, "../lib/services/invoices.ts"), "utf8")
  const trustCenterSource = fs.readFileSync(path.join(__dirname, "../lib/services/trust-center.ts"), "utf8")
  const actionsSource = fs.readFileSync(path.join(__dirname, "../app/(app)/projects/[id]/financials/actions.ts"), "utf8")
  const reviewQueueSource = fs.readFileSync(path.join(__dirname, "../components/cost-inbox/review-queue-table.tsx"), "utf8")

  assert.match(costPlusSource, /currently locked by invoice creation/)
  assert.match(invoiceSource, /Do not invoice change orders directly/)
  assert.match(costPlusSource, /createManualBillableAdjustment/)
  assert.match(actionsSource, /createManualBillableAdjustmentAction/)
  assert.match(reviewQueueSource, /adjustmentDialogOpen/)
  assert.match(trustCenterSource, /incurred_billable_tieout/)
})

test("cost-plus trust center has a real route for incurred versus billable tie-out", () => {
  const trustCenterTypes = fs.readFileSync(path.join(__dirname, "../lib/financials/trust-center-types.ts"), "utf8")
  const trustCenterPage = fs.readFileSync(
    path.join(__dirname, "../app/(app)/projects/[id]/financials/trust-center/page.tsx"),
    "utf8",
  )
  const projectNav = fs.readFileSync(path.join(__dirname, "../components/layout/project-nav-items.ts"), "utf8")

  assert.match(trustCenterTypes, /incurred_billable_tieout/)
  assert.doesNotMatch(trustCenterPage, /redirect\(/)
  assert.match(trustCenterPage, /TrustCenterTab/)
  assert.match(projectNav, /trust-center/)
})

test("markup and retainage policies are explicit in cost-plus billing", () => {
  const costPlusSource = fs.readFileSync(path.join(__dirname, "../lib/services/cost-plus.ts"), "utf8")
  const projectSetupSource = fs.readFileSync(path.join(__dirname, "../lib/services/project-financial-setup.ts"), "utf8")
  const migrationSource = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260707192900_cost_plus_integrity_hardening.sql"),
    "utf8",
  )

  assert.match(costPlusSource, /contractRule[\s\S]*rawContractMarkup[\s\S]*defaultCostCodeMarkup/)
  assert.match(costPlusSource, /applyRetainageToInvoiceDraft\([\s\S]*retainageAppliesToFee = false/)
  assert.match(costPlusSource, /!retainageAppliesToFee && isInvoiceDraftFeeLine/)
  assert.match(projectSetupSource, /retainageAppliesToFee: z\.boolean\(\)\.default\(false\)/)
  assert.match(migrationSource, /retainage_applies_to_fee boolean not null default false/)
})

test("approved-cost invoice idempotency key is stable, sorted, and sensitive to invoice facts", () => {
  const preview = {
    lines: [],
    totals: {
      cost_cents: 12000,
      markup_cents: 2400,
      billable_cents: 14400,
    },
  }
  const base = {
    orgId: "org-1",
    projectId: "project-1",
    invoiceNumber: "INV-100",
    costIds: ["cost-2", "cost-1"],
    preview,
    reservationId: "reservation-1",
  }

  const first = buildApprovedCostInvoiceIdempotencyKey(base)
  const sortedDifferently = buildApprovedCostInvoiceIdempotencyKey({ ...base, costIds: ["cost-1", "cost-2"] })
  const changedTotal = buildApprovedCostInvoiceIdempotencyKey({
    ...base,
    preview: { ...preview, totals: { ...preview.totals, billable_cents: 14500 } },
  })
  const changedReservation = buildApprovedCostInvoiceIdempotencyKey({ ...base, reservationId: "reservation-2" })

  assert.equal(first, sortedDifferently)
  assert.notEqual(first, changedTotal)
  assert.notEqual(first, changedReservation)
  assert.match(first, /^approved_cost_invoice:[a-f0-9]{48}$/)
})

test("approved-cost invoice creation remains routed through the atomic RPC", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/approved-cost-invoicing.ts"), "utf8")

  assert.match(source, /rpc\("create_invoice_from_billable_costs_atomic"/)
  assert.match(source, /p_idempotency_key:\s*idempotencyKey/)
  assert.match(source, /Approved-cost invoice includes duplicate costs/)
})

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
  ])

  assert.deepEqual(actuals, [
    {
      cost_code_id: "03-100",
      budget_line_id: null,
      actual_cents: 18900,
      billable_actual_cents: 12500,
      non_billable_actual_cents: 6400,
      entry_count: 3,
    },
  ])
})

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
  ])

  assert.deepEqual(actuals, [
    {
      cost_code_id: "04-200",
      budget_line_id: null,
      actual_cents: 5000,
      billable_actual_cents: 5000,
      non_billable_actual_cents: 0,
      entry_count: 2,
    },
  ])
})

test("owner portal open-book detail respects open_book=false", () => {
  assert.equal(shouldExposeOpenBookCostDetail(false), false)
  assert.equal(shouldExposeOpenBookCostDetail(true), true)
  assert.equal(shouldExposeOpenBookCostDetail(null), true)
  assert.equal(shouldExposeOpenBookCostDetail(undefined), true)
})

test("closed billing periods block invoice creation and in-place edits", () => {
  for (const status of ["open", "reviewing", "reopened"]) {
    assert.doesNotThrow(() => assertBillingPeriodStatusAllowsInvoice({ name: "May 2026", status }))
    assert.doesNotThrow(() => assertBillingPeriodStatusAllowsEdit({ name: "May 2026", status }, "Vendor bill"))
  }

  for (const status of ["closed", "invoiced"]) {
    assert.throws(
      () => assertBillingPeriodStatusAllowsInvoice({ name: "May 2026", status }),
      /reopen it before creating another approved-cost invoice/,
    )
    assert.throws(
      () => assertBillingPeriodStatusAllowsEdit({ name: "May 2026", status }, "Vendor bill"),
      /handle it as a late-cost adjustment/,
    )
  }
})

test("receivables mutations remain routed through atomic database functions", () => {
  const paymentSource = fs.readFileSync(path.join(__dirname, "../lib/services/payments.ts"), "utf8")
  const projectActions = fs.readFileSync(path.join(__dirname, "../app/(app)/projects/[id]/actions.ts"), "utf8")
  const lateFeeJob = fs.readFileSync(path.join(__dirname, "../app/api/jobs/late-fees/route.ts"), "utf8")
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260607120000_receivables_hardening_and_autopilot.sql"),
    "utf8",
  )

  assert.match(paymentSource, /rpc\("apply_invoice_payment_atomic"/)
  assert.match(paymentSource, /rpc\("record_payment_reversal_atomic"/)
  assert.match(projectActions, /rpc\("release_project_retainage_atomic"/)
  assert.match(projectActions, /p_reservation_id: next\.reservation_id \?\? null/)
  assert.match(lateFeeJob, /rpc\("apply_invoice_late_fee_atomic"/)
  assert.match(migration, /for update/)
  assert.match(migration, /invoices_sync_retainage_release_status/)
})

test("commercial pay applications preserve base contract sums and reject unsafe posting", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/pay-applications.ts"), "utf8")
  const correction = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260711191000_pay_application_void_corrections.sql"),
    "utf8",
  )

  assert.match(source, /snapshot\?\.base_total_cents/)
  assert.ok(source.indexOf("if (overbilledLines.length > 0 && !parsed.allow_overbilling)") < source.indexOf("for (const update of pendingUpdates)"))
  assert.match(source, /overbilling_confirmed/)
  assert.match(source, /contains overbilled lines that have not been explicitly confirmed/)
  assert.match(correction, /metadata ->> 'type'.*= 'retainage_release'/)
  assert.match(correction, /retainage_released_cents = retainage_released_cents - v_release_take/)
  assert.match(correction, /order by line_number desc/)
  assert.match(correction, /set search_path = ''/)
  assert.match(correction, /permission_key = 'payapp\.write'/)
  assert.match(correction, /m\.user_id = \(select auth\.uid\(\)\)/)
  assert.match(correction, /revoke all on function public\.void_pay_application\(uuid, uuid\) from public, anon, authenticated/)
})

test("commercial claims use executed OCO numbering and reconcile pay-app receivables", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260711194000_commercial_claims_completion.sql"),
    "utf8",
  )
  const changeOrders = fs.readFileSync(path.join(__dirname, "../lib/services/change-orders.ts"), "utf8")
  const payApps = fs.readFileSync(path.join(__dirname, "../lib/services/pay-applications.ts"), "utf8")

  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('oco:'/)
  assert.match(migration, /create unique index if not exists change_orders_project_executed_number_key/)
  assert.match(migration, /where executed_change_order_number is not null/)
  assert.match(migration, /trg_reconcile_pay_application_invoice_status/)
  assert.match(migration, /set status = 'paid', paid_at = coalesce\(paid_at, now\(\)\)/)
  assert.doesNotMatch(migration, /(?:new|old|i)\.paid_at/)
  assert.match(changeOrders, /executed_change_order_number/)
  assert.match(changeOrders, /`PCO-\$\{String\(changeOrder\.co_number\)/)
  assert.match(payApps, /permission: "invoice\.approve"/)
  assert.match(payApps, /update\(\{ status: "approved", approved_at: approvedAt \}\)/)
})

test("change-order content edits cannot perform lifecycle transitions", () => {
  const service = fs.readFileSync(path.join(__dirname, "../lib/services/change-orders.ts"), "utf8")
  const correction = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260711191000_pay_application_void_corrections.sql"),
    "utf8",
  )

  assert.match(service, /lifecycle: existing\.lifecycle \?\? "draft"/)
  assert.match(service, /lifecycle: "draft"/)
  assert.doesNotMatch(service, /lifecycle: existing\.lifecycle === "proposed" \? "proposed" : input\.lifecycle/)
  assert.match(service, /rpc\("void_approved_change_order_atomic"/)
  assert.match(correction, /create or replace function public\.void_approved_change_order_atomic/)
  assert.match(correction, /permission_key = 'change_order\.approve'/)
  assert.match(correction, /update public\.budget_revisions/)
  assert.match(correction, /delete from public\.prime_sov_lines/)
  assert.match(correction, /update public\.contracts/)
  assert.match(correction, /update public\.draw_schedules/)
  assert.match(correction, /revoke all on function public\.void_approved_change_order_atomic/)
})

test("financial jobs and public payment links keep their authorization boundaries", () => {
  for (const route of ["reminders", "late-fees", "payments"]) {
    const source = fs.readFileSync(path.join(__dirname, `../app/api/jobs/${route}/route.ts`), "utf8")
    assert.match(source, /isAuthorizedCronRequest/)
    assert.match(source, /status:\s*401/)
  }

  const payLinkAction = fs.readFileSync(path.join(__dirname, "../app/p/pay/[token]/actions.ts"), "utf8")
  const paymentService = fs.readFileSync(path.join(__dirname, "../lib/services/payments.ts"), "utf8")
  assert.match(payLinkAction, /createPayLinkPaymentIntent\(token\)/)
  assert.doesNotMatch(payLinkAction, /createPaymentIntent\(/)
  assert.match(paymentService, /data\.client_visible === false \|\| data\.status === "void"/)
})

test("sent and synchronized invoices are immutable through the standard editor", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/invoices.ts"), "utf8")

  assert.match(source, /existing\.sent_at \|\| existing\.qbo_id/)
  assert.match(source, /Issued or accounting-synced invoices are immutable/)
  assert.match(source, /client_visible", true/)
  assert.match(source, /neq\("status", "void"\)/)
})

test("Arc Autopilot is opt-in and prepares review runs without posting invoices", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/billing-autopilot.ts"), "utf8")

  assert.match(source, /flagKey:\s*FLAG_KEY/)
  assert.match(source, /defaultEnabled:\s*false/)
  assert.match(source, /Nothing is posted or sent automatically|status:\s*"prepared"/)
  assert.doesNotMatch(source, /createInvoice\(/)
})

test("draw billing creates a linked review draft instead of issuing immediately", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/draws.ts"), "utf8")

  assert.match(source, /status:\s*"saved"/)
  assert.match(source, /client_visible:\s*false/)
  assert.match(source, /source_type:\s*"draw"/)
  assert.match(source, /source_draw_id:\s*draw\.id/)
})

test("invoice revisions preserve the original and create a linked replacement draft", () => {
  const service = fs.readFileSync(path.join(__dirname, "../lib/services/invoices.ts"), "utf8")
  const client = fs.readFileSync(path.join(__dirname, "../components/invoices/invoices-client.tsx"), "utf8")

  assert.match(service, /export async function reviseInvoice/)
  assert.match(service, /await voidInvoice/)
  assert.match(service, /revision_of_invoice_id/)
  assert.match(service, /replaced_by_invoice_id/)
  assert.match(client, /Revise and reissue/)
})

test("retainage is derived from the active contract and shown before invoice issuance", () => {
  const invoiceService = fs.readFileSync(path.join(__dirname, "../lib/services/invoices.ts"), "utf8")
  const composer = fs.readFileSync(path.join(__dirname, "../components/invoices/invoice-composer-sheet.tsx"), "utf8")
  const receivables = fs.readFileSync(path.join(__dirname, "../components/financials/receivables-tab.tsx"), "utf8")
  const retainageTracker = fs.readFileSync(path.join(__dirname, "../components/projects/retainage-tracker.tsx"), "utf8")

  assert.match(invoiceService, /sourceType !== "manual" && sourceType !== "draw" && sourceType !== "change_order"/)
  assert.match(invoiceService, /Failed to record invoice retainage/)
  assert.match(composer, /billing_contract\?\.retainage_percent/)
  assert.match(composer, /Retainage held/)
  assert.match(receivables, /billing_contract: contract/)
  assert.match(receivables, /projects=\{\[invoiceProject\]\}/)
  assert.doesNotMatch(retainageTracker, /updateProjectSettingsAction/)
  assert.doesNotMatch(retainageTracker, /Total Project Value/)
})

test("contract value uses base plus approved changes exactly once", () => {
  const projectService = fs.readFileSync(path.join(__dirname, "../lib/services/projects.ts"), "utf8")
  const overview = fs.readFileSync(
    path.join(__dirname, "../components/projects/overview/project-overview-stats.tsx"),
    "utf8",
  )
  const contractCard = fs.readFileSync(
    path.join(__dirname, "../components/projects/contract-summary-card.tsx"),
    "utf8",
  )
  const drawManager = fs.readFileSync(
    path.join(__dirname, "../components/projects/draw-schedule-manager.tsx"),
    "utf8",
  )

  assert.match(projectService, /revisedTotalCents = baseTotalCents == null \? null : baseTotalCents \+ approvedChangeOrdersCents/)
  assert.match(overview, /const totalContractCents = contractTotalCents/)
  assert.match(contractCard, /const revisedTotal = contractTotal/)
  assert.match(drawManager, /return contract\?\.total_cents \?\? 0/)
  assert.doesNotMatch(drawManager, /contract\?\.total_cents \?\? 0\) \+ /)
})

test("Autopilot treats completed linked milestones as billing evidence", () => {
  const source = fs.readFileSync(path.join(__dirname, "../lib/services/billing-autopilot.ts"), "utf8")

  assert.match(source, /from\("schedule_items"\)/)
  assert.match(source, /milestoneComplete/)
  assert.match(source, /Number\(milestone\.progress \?\? 0\) >= 100/)
  assert.match(source, /Review the draw before preparing its invoice/)
})

test("fixed-price pay-app packages carry GC compliance and required full-tier waivers", () => {
  const packageService = fs.readFileSync(
    path.join(__dirname, "../lib/services/owner-billing-packages.ts"),
    "utf8",
  )
  const actions = fs.readFileSync(
    path.join(__dirname, "../app/(app)/projects/[id]/financials/actions.ts"),
    "utf8",
  )
  const payAppUi = fs.readFileSync(
    path.join(__dirname, "../components/financials/pay-applications-tab.tsx"),
    "utf8",
  )

  assert.match(packageService, /source_pay_application_id/)
  assert.match(packageService, /sourcePayApplication\?\.period_end/)
  assert.match(packageService, /eq\("subject", "org"\)/)
  assert.match(packageService, /require_subtier_waivers/)
  assert.match(packageService, /role:.*"gc_compliance".*"lien_waiver"/)
  assert.match(actions, /generatePayApplicationPackageAction/)
  assert.match(actions, /generateSovPayApplicationPdf/)
  assert.match(actions, /generateInvoiceBackupPackage/)
  assert.match(payAppUi, /Attach our bonds, insurance, and licenses/)
  assert.match(payAppUi, /Full-tier lien waivers are included automatically/)
})
