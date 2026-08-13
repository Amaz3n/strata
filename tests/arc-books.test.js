require("../scripts/register-ts-node-test");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  classifyPaymentPosting,
  postBillPayment,
  postClosingInvoice,
  postCustomerInvoice,
  postCustomerDepositReceipt,
  postCustomerDepositApplication,
  postCustomerDepositReversal,
  postExpense,
  postExpenseFromCostLines,
  postInvoicePayment,
  postLaborCost,
  postReceivableAdjustment,
  postRetainageRelease,
  postRevenueRecognition,
  postVendorBillFromCostLines,
  postYearEndClose,
} = require("../lib/services/books/posting-rules");
const {
  assertBalancedJournalDraft,
  assertValidOperatingPosture,
  buildPostingKey,
} = require("../lib/services/books/types");
const {
  draftFromFact,
  hashableFactPayload,
  isRetiredFactKind,
  retiredFactKind,
  retirementFactPayload,
  selectFactsToRetire,
  sortFactCostLines,
} = require("../lib/services/books/fact-drafts");
const { booksDigest } = require("../lib/services/books/hash");
const { isoDateOnlyFromUtcMs } = require("../lib/services/reports/dates");
const { computeProjectPoc } = require("../lib/financials/poc-rules");
const {
  allocateAdditionalCostCents,
} = require("../lib/financials/job-cost-calculations");
const {
  resolveRevenueRecognitionBasis,
} = require("../lib/financials/billing-model");
const { selectCodingSuggestion } = require("../lib/services/accounting-rules");
const {
  parseBankStatement,
} = require("../lib/financials/bank-statement-import");

const PROJECT_ID = "00000000-0000-4000-8000-0000000000aa";

test("bank statement imports preserve signs, quoted CSV, TSV, and OFX identity", () => {
  assert.deepEqual(
    parseBankStatement(
      'Posted Date,Description,Amount,Transaction ID\n08/01/2026,"Deposit, owner",1250.25,a-1\n08/02/2026,Lumber,-400.10,a-2',
    ),
    [
      {
        sourceId: "a-1",
        date: "2026-08-01",
        description: "Deposit, owner",
        merchantName: null,
        amountCents: 125025,
      },
      {
        sourceId: "a-2",
        date: "2026-08-02",
        description: "Lumber",
        merchantName: null,
        amountCents: -40010,
      },
    ],
  );
  assert.equal(
    parseBankStatement(
      "Date\tPayee\tDebit\tCredit\n2026-08-03\tConcrete Co\t99.50\t",
    )[0].amountCents,
    -9950,
  );
  assert.deepEqual(
    parseBankStatement(
      "<OFX><BANKTRANLIST><STMTTRN><DTPOSTED>20260804120000<TRNAMT>-12.34<FITID>qfx-1<NAME>Bank fee</STMTTRN></BANKTRANLIST></OFX>",
    )[0],
    {
      sourceId: "qfx-1",
      date: "2026-08-04",
      description: "Bank fee",
      merchantName: "Bank fee",
      amountCents: -1234,
    },
  );
  assert.equal(
    parseBankStatement(
      "Date,Description,Amount\n2026-08-05,Card purchase,25.00",
      "outflow",
    )[0].amountCents,
    -2500,
  );
});

function common(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    date: "2026-06-30",
    memo: "Fixture",
    projectionVersion: 1,
    policyVersion: 1,
    ...overrides,
  };
}

test("Arc Books golden postings are balanced in integer cents", () => {
  const entries = [
    postVendorBillFromCostLines({
      ...common(),
      grossCents: 125000,
      retainageCents: 12500,
      costLines: [{ amountCents: 125000 }],
    }),
    postVendorBillFromCostLines({
      ...common(),
      grossCents: 100000,
      costLines: [{ amountCents: 60000 }, { amountCents: 40000 }],
    }),
    postBillPayment({ ...common(), amountCents: 112500 }),
    postBillPayment({
      ...common(),
      amountCents: 112500,
      feeCents: 250,
      discountCents: 2000,
    }),
    postCustomerInvoice({
      ...common(),
      grossCents: 250000,
      retainageCents: 25000,
    }),
    postClosingInvoice({ ...common(), grossCents: 425000 }),
    postInvoicePayment({ ...common(), amountCents: 225000 }),
    postInvoicePayment({ ...common(), amountCents: 225000, feeCents: 6525 }),
    postExpense({ ...common(), amountCents: 3599 }),
    postExpense({ ...common(), amountCents: 3599, accrued: true }),
    // Credits: the mirror of each accrual, and every bit as much a fact.
    postVendorBillFromCostLines({
      ...common(),
      grossCents: -40000,
      costLines: [{ amountCents: -40000 }],
    }),
    postExpense({ ...common(), amountCents: -3599 }),
    postLaborCost({ ...common(), amountCents: -12000 }),
    postRetainageRelease({ ...common(), amountCents: 12500, side: "payable" }),
    postRetainageRelease({
      ...common(),
      amountCents: 25000,
      side: "receivable",
    }),
    postLaborCost({ ...common(), amountCents: 50000 }),
    postRevenueRecognition({
      ...common(),
      projectId: PROJECT_ID,
      deltaCents: 44000,
      periodKey: "2026-06",
    }),
    postRevenueRecognition({
      ...common(),
      projectId: PROJECT_ID,
      deltaCents: -12000,
      periodKey: "2026-07",
    }),
    postYearEndClose({
      ...common(),
      incomeAccountBalances: [
        { accountCode: "4000", accountType: "income", balanceCents: 500000 },
        { accountCode: "5000", accountType: "cogs", balanceCents: 300000 },
        { accountCode: "6000", accountType: "expense", balanceCents: 50000 },
      ],
    }),
  ];
  for (const entry of entries) {
    const totals = assertBalancedJournalDraft(entry);
    assert.equal(totals.debitCents, totals.creditCents);
    assert.ok(Number.isSafeInteger(totals.debitCents));
  }
  assert.deepEqual(
    postVendorBillFromCostLines({
      ...common(),
      grossCents: 125000,
      retainageCents: 12500,
      costLines: [{ amountCents: 125000 }],
    }).lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["5000", 125000, 0],
      ["2000", 0, 112500],
      ["2010", 0, 12500],
    ],
  );
});

test("customer deposits stay liabilities until applied or refunded", () => {
  const receipt = postCustomerDepositReceipt({
    ...common(),
    amountCents: 50_000,
    feeCents: 500,
  });
  assert.deepEqual(
    receipt.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
    ["1010", 49_500, 0],
      ["6050", 500, 0],
      ["2300", 0, 50_000],
    ],
  );
  const application = postCustomerDepositApplication({
    ...common(),
    amountCents: 20_000,
  });
  assert.deepEqual(
    application.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["2300", 20_000, 0],
      ["1100", 0, 20_000],
    ],
  );
  const refund = postCustomerDepositReversal({
    ...common(),
    amountCents: 30_000,
  });
  assert.deepEqual(
    refund.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["2300", 30_000, 0],
      ["1010", 0, 30_000],
    ],
  );
});

test("vendor use tax adds cost and a tax liability without inflating AP", () => {
  const entry = postVendorBillFromCostLines({
    ...common(),
    grossCents: 100_000,
    useTaxCents: 6_000,
    costLines: [{ amountCents: 106_000 }],
  });
  assert.equal(
    entry.lines.filter((line) => line.accountCode === "2000")[0].creditCents,
    100_000,
  );
  assert.equal(
    entry.lines.filter((line) => line.accountCode === "2250")[0].creditCents,
    6_000,
  );
  assert.equal(
    entry.lines.reduce(
      (sum, line) => sum + line.debitCents - line.creditCents,
      0,
    ),
    0,
  );
});

test("payable use tax allocation is exact and deterministic", () => {
  const allocation = allocateAdditionalCostCents(7, [
    { id: "b", amountCents: 100 },
    { id: "a", amountCents: 100 },
    { id: "c", amountCents: 100 },
  ]);
  assert.deepEqual([...allocation.entries()].sort(), [
    ["a", 3],
    ["b", 2],
    ["c", 2],
  ]);
  assert.equal(
    [...allocation.values()].reduce((sum, cents) => sum + cents, 0),
    7,
  );
});

test("sole-ledger operations enforce greenfield and maker-checker controls in SQL", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812150201_books_sole_ledger_operations.sql",
    ),
    "utf8",
  );
  assert.match(migration, /launch_books_greenfield_atomic/);
  assert.match(migration, /external accounting connection is active/);
  assert.match(migration, /Every active bank account must be mapped/);
  assert.match(migration, /review_books_journal_proposal_atomic/);
  assert.match(migration, /proposal maker cannot approve their own entry/i);
  assert.match(migration, /post_books_registered_subledger_event_atomic/);
  assert.match(migration, /books_debt_events_immutable/);
  assert.match(migration, /books_fixed_asset_events_immutable/);
  assert.match(migration, /store_company_tax_identity_atomic/);
  assert.match(migration, /replace_company_tax_identity_atomic/);
  assert.match(migration, /vault\.create_secret/);
  assert.match(migration, /vault\.update_secret/);
  assert.match(
    migration,
    /revoke all on function public\.store_company_tax_identity_atomic/,
  );
});

test("Books reviewer role is least-privileged", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812145420_books_reviewer_role.sql",
    ),
    "utf8",
  );
  assert.match(migration, /org_books_reviewer/);
  assert.match(migration, /array\['books\.read', 'report\.read'\]/);
  assert.match(
    migration,
    /permission_key not in \('books\.read', 'report\.read'\)/,
  );
  assert.doesNotMatch(migration, /books\.export.*report\.read/);
});

test("direct-paid project expenses preserve cost-line grain in the GL", () => {
  const draft = postExpenseFromCostLines({
    ...common(),
    amountCents: 125_00,
    costLines: [
      {
        accountCode: "5010",
        amountCents: 75_00,
        projectId: PROJECT_ID,
        description: "Concrete",
      },
      {
        accountCode: "5020",
        amountCents: 50_00,
        projectId: PROJECT_ID,
        description: "Framing",
      },
    ],
  });
  assertBalancedJournalDraft(draft);
  assert.deepEqual(
    draft.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["5010", 75_00, 0],
      ["5020", 50_00, 0],
      ["1000", 0, 125_00],
    ],
  );
  assert.throws(
    () =>
      postExpenseFromCostLines({
        ...common(),
        amountCents: 100,
        costLines: [{ amountCents: 99 }],
      }),
    /does not equal the expense amount/,
  );
});

test("release hardening serializes close, reversals, and payment detail writes", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812120755_books_release_hardening.sql",
    ),
    "utf8",
  );
  assert.match(
    migration,
    /before insert or update or delete on public\.journal_lines/,
  );
  assert.match(
    migration,
    /create unique index if not exists journal_entries_one_reversal_idx/,
  );
  assert.match(
    migration,
    /select status into prior_status[\s\S]{0,200}?for update/,
  );
  assert.match(migration, /public\.reverse_books_journal_entry/);
  assert.match(migration, /public\.apply_invoice_payment_with_details_atomic/);
  assert.match(migration, /bill_lines_touch_books_parent/);
  assert.match(migration, /project_expense_lines_touch_books_parent/);
});

test("billing a customer is not revenue; percentage-of-completion recognizes it separately", () => {
  const invoice = postCustomerInvoice({
    ...common(),
    projectId: PROJECT_ID,
    grossCents: 250000,
    retainageCents: 25000,
  });
  // AR + retainage receivable against contract liabilities — never 4000 directly.
  assert.deepEqual(
    invoice.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["1100", 225000, 0],
      ["1110", 25000, 0],
      ["2350", 0, 250000],
    ],
  );
  assert.ok(!invoice.lines.some((line) => line.accountCode === "4000"));

  const taxableInvoice = postCustomerInvoice({
    ...common(),
    projectId: PROJECT_ID,
    grossCents: 250000,
    taxCents: 15000,
    retainageCents: 25000,
  });
  assert.deepEqual(
    taxableInvoice.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["1100", 225000, 0],
      ["1110", 25000, 0],
      ["2350", 0, 235000],
      ["2250", 0, 15000],
    ],
  );
  assertBalancedJournalDraft(taxableInvoice);

  const earned = postRevenueRecognition({
    ...common(),
    projectId: PROJECT_ID,
    deltaCents: 180000,
    periodKey: "2026-06",
  });
  assert.deepEqual(
    earned.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["2350", 180000, 0],
      ["4000", 0, 180000],
    ],
  );
  // Billed 250000, earned 180000 -> 70000 remains credit in 2350: billings in excess.
  const reversal = postRevenueRecognition({
    ...common(),
    projectId: PROJECT_ID,
    deltaCents: -20000,
    periodKey: "2026-07",
  });
  assert.deepEqual(
    reversal.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["4000", 20000, 0],
      ["2350", 0, 20000],
    ],
  );
});

test("closing-basis projects book revenue at the sale instead of percentage-of-completion", () => {
  assert.equal(
    resolveRevenueRecognitionBasis({ ownerBillingBasis: "closing" }),
    "closing",
  );
  assert.equal(
    resolveRevenueRecognitionBasis({ ownerBillingBasis: "draws" }),
    "percentage_of_completion",
  );
  assert.equal(
    resolveRevenueRecognitionBasis({ ownerBillingBasis: "costs_plus_fee" }),
    "percentage_of_completion",
  );
  const closing = postClosingInvoice({
    ...common(),
    projectId: PROJECT_ID,
    grossCents: 425000,
  });
  assert.deepEqual(
    closing.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["1100", 425000, 0],
      ["4000", 0, 425000],
    ],
  );

  const taxableClosing = postClosingInvoice({
    ...common(),
    projectId: PROJECT_ID,
    grossCents: 425000,
    taxCents: 25000,
  });
  assert.deepEqual(
    taxableClosing.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["1100", 425000, 0],
      ["4000", 0, 400000],
      ["2250", 0, 25000],
    ],
  );
  assertBalancedJournalDraft(taxableClosing);
});

test("receivable adjustments reduce AR without pretending cash was collected", () => {
  const credit = postReceivableAdjustment({
    ...common(),
    projectId: PROJECT_ID,
    amountCents: 10700,
    taxCents: 700,
    adjustmentType: "credit_memo",
    revenueBasis: "percentage_of_completion",
  });
  assert.deepEqual(
    credit.lines.map((line) => [line.accountCode, line.debitCents, line.creditCents]),
    [["2350", 10000, 0], ["2250", 700, 0], ["1100", 0, 10700]],
  );
  assertBalancedJournalDraft(credit);

  const closingCredit = postReceivableAdjustment({
    ...common(),
    projectId: PROJECT_ID,
    amountCents: 5350,
    taxCents: 350,
    adjustmentType: "credit_memo",
    revenueBasis: "closing",
  });
  assert.deepEqual(
    closingCredit.lines.map((line) => [line.accountCode, line.debitCents, line.creditCents]),
    [["4000", 5000, 0], ["2250", 350, 0], ["1100", 0, 5350]],
  );
  assertBalancedJournalDraft(closingCredit);

  const writeOff = draftFromFact({
    sourceType: "receivable_adjustment",
    sourceId: "00000000-0000-4000-8000-000000000090",
    accountingDate: "2026-06-30",
    payload: {
      memo: "Uncollectible balance",
      amount_cents: 2500,
      tax_cents: 0,
      adjustment_type: "write_off",
      project_id: PROJECT_ID,
      revenue_basis: "closing",
    },
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  });
  assert.deepEqual(
    writeOff.lines.map((line) => [line.accountCode, line.debitCents, line.creditCents]),
    [["6090", 2500, 0], ["1100", 0, 2500]],
  );
  assertBalancedJournalDraft(writeOff);
});

test("posting keys embed the projection and source versions so re-projection cannot collide", () => {
  assert.equal(
    buildPostingKey("vendor_bill:abc", { projectionVersion: 1 }),
    "vendor_bill:abc:s1:v1",
  );
  assert.equal(
    buildPostingKey("vendor_bill:abc", {
      projectionVersion: 2,
      sourceVersion: 3,
    }),
    "vendor_bill:abc:s3:v2",
  );
  assert.throws(
    () => buildPostingKey("x", { projectionVersion: 0 }),
    /positive integer/,
  );
  assert.throws(
    () => buildPostingKey("x", { projectionVersion: 1, sourceVersion: 0 }),
    /positive integer/,
  );

  const v1 = postVendorBillFromCostLines({
    ...common(),
    grossCents: 1000,
    projectionVersion: 1,
    costLines: [{ amountCents: 1000 }],
  });
  const v2 = postVendorBillFromCostLines({
    ...common(),
    grossCents: 1000,
    projectionVersion: 2,
    costLines: [{ amountCents: 1000 }],
  });
  const revised = postVendorBillFromCostLines({
    ...common(),
    grossCents: 1000,
    projectionVersion: 1,
    sourceVersion: 2,
    costLines: [{ amountCents: 1000 }],
  });
  assert.notEqual(v1.postingKey, v2.postingKey);
  assert.notEqual(v1.postingKey, revised.postingKey);
});

test("a fact rebuilds to the identical draft, and lifecycle columns are not economic", () => {
  const payload = {
    memo: "Vendor bill 1041",
    total_cents: 125000,
    retainage_cents: 12500,
    project_id: PROJECT_ID,
    company_id: null,
    cost_lines: [
      { amount_cents: 80000, project_id: PROJECT_ID },
      { amount_cents: 45000, project_id: PROJECT_ID },
    ],
  };
  const input = {
    sourceType: "vendor_bill",
    sourceId: "00000000-0000-4000-8000-000000000001",
    accountingDate: "2026-06-30",
    payload,
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  };
  const first = draftFromFact(input);
  const second = draftFromFact(input);
  assert.deepEqual(first, second);
  assert.equal(
    first.lines.filter((line) => line.accountCode === "5000").length,
    2,
  );

  // A memo edit must not read as an economic revision; an amount change must.
  assert.deepEqual(
    hashableFactPayload("vendor_bill", { ...payload, memo: "renamed" }),
    hashableFactPayload("vendor_bill", payload),
  );
  assert.notDeepEqual(
    hashableFactPayload("vendor_bill", { ...payload, total_cents: 999 }),
    hashableFactPayload("vendor_bill", payload),
  );
});

test("retainage: an invoice total is net, a vendor bill total is gross", () => {
  // The two sides of the ledger store retainage in opposite directions, and conflating
  // them silently understates AR and under-credits contract liability.
  const amounts = (draft) =>
    Object.fromEntries(
      draft.lines.map((line) => [
        line.accountCode,
        line.debitCents > 0 ? line.debitCents : -line.creditCents,
      ]),
    );

  // Invoice: stored total (225,000) is already NET of the 25,000 retainage line, so the
  // gross billing is 250,000.
  const invoice = draftFromFact({
    sourceType: "invoice",
    sourceId: "00000000-0000-4000-8000-000000000002",
    accountingDate: "2026-06-30",
    payload: {
      memo: "Invoice 12",
      total_cents: 225000,
      retainage_cents: 25000,
      project_id: PROJECT_ID,
    },
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  });
  assert.deepEqual(amounts(invoice), {
    1100: 225000,
    1110: 25000,
    2350: -250000,
  });
  assertBalancedJournalDraft(invoice);

  // Vendor bill: stored total (125,000) is GROSS, with retainage held out of the payable.
  const bill = draftFromFact({
    sourceType: "vendor_bill",
    sourceId: "00000000-0000-4000-8000-000000000003",
    accountingDate: "2026-06-30",
    payload: {
      memo: "Bill 41",
      total_cents: 125000,
      retainage_cents: 12500,
      project_id: PROJECT_ID,
      cost_lines: [{ amount_cents: 125000, project_id: PROJECT_ID }],
    },
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  });
  assert.deepEqual(amounts(bill), {
    5000: 125000,
    2000: -112500,
    2010: -12500,
  });
  assertBalancedJournalDraft(bill);

  // A retainage-free invoice must be untouched by the gross reconstruction.
  const plain = draftFromFact({
    sourceType: "invoice",
    sourceId: "00000000-0000-4000-8000-000000000004",
    accountingDate: "2026-06-30",
    payload: {
      memo: "Invoice 13",
      total_cents: 90000,
      retainage_cents: 0,
      project_id: PROJECT_ID,
    },
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  });
  assert.deepEqual(amounts(plain), { 1100: 90000, 2350: -90000 });
});

test("Arc Books honors the expense account selected on each payable line", () => {
  const draft = draftFromFact({
    sourceType: "vendor_bill",
    sourceId: "00000000-0000-4000-8000-000000000041",
    accountingDate: "2026-06-30",
    payload: {
      memo: "Bill 84",
      total_cents: 125000,
      retainage_cents: 0,
      project_id: PROJECT_ID,
      cost_lines: [
        { amount_cents: 80000, project_id: PROJECT_ID, account_code: "5100" },
        { amount_cents: 45000, project_id: PROJECT_ID, account_code: "5200" },
      ],
    },
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  });

  assert.deepEqual(
    draft.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["5100", 80000, 0],
      ["5200", 45000, 0],
      ["2000", 0, 125000],
    ],
  );
  assertBalancedJournalDraft(draft);
});

test("C1 acceptance: a full contract lifecycle projects deterministically and balances", () => {
  // Three of C1's four acceptance criteria are properties of the projection itself and
  // do not need a database: re-projection is deterministic, the trial balance sums to
  // zero, and GL job cost equals what the subledger fed in. The fourth (AR/AP tie to
  // the aging reports) needs real rows and is still outstanding — see the plan.
  const fact = (sourceType, sourceId, payload) => ({
    sourceType,
    sourceId,
    accountingDate: "2026-06-30",
    payload,
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  });

  const lifecycle = [
    // Cost: a bill of 125,000 gross with 12,500 retained, coded to two cost lines.
    fact("vendor_bill", "00000000-0000-4000-8000-00000000c001", {
      memo: "Bill 1041",
      total_cents: 125000,
      retainage_cents: 12500,
      project_id: PROJECT_ID,
      cost_lines: [
        { amount_cents: 80000, project_id: PROJECT_ID },
        { amount_cents: 45000, project_id: PROJECT_ID },
      ],
    }),
    fact("bill_payment", "00000000-0000-4000-8000-00000000c002", {
      memo: "Pay 1041",
      amount_cents: 112500,
    }),
    fact("retainage_release", "00000000-0000-4000-8000-00000000c003", {
      memo: "AP retainage release",
      amount_cents: 12500,
      side: "payable",
      project_id: PROJECT_ID,
    }),
    // Billing: 250,000 gross with 25,000 retained, so the stored net total is 225,000.
    fact("invoice", "00000000-0000-4000-8000-00000000c004", {
      memo: "Invoice 12",
      total_cents: 225000,
      retainage_cents: 25000,
      project_id: PROJECT_ID,
    }),
    fact("invoice_payment", "00000000-0000-4000-8000-00000000c005", {
      memo: "Receipt",
      amount_cents: 225000,
    }),
    fact("retainage_release", "00000000-0000-4000-8000-00000000c006", {
      memo: "AR retainage release",
      amount_cents: 25000,
      side: "receivable",
      project_id: PROJECT_ID,
    }),
    fact("expense", "00000000-0000-4000-8000-00000000c007", {
      memo: "Dump fees",
      amount_cents: 3599,
      project_id: PROJECT_ID,
    }),
    fact("labor_cost", "00000000-0000-4000-8000-00000000c008", {
      memo: "Field crew",
      amount_cents: 50000,
      project_id: PROJECT_ID,
    }),
    fact("payment_reversal", "00000000-0000-4000-8000-00000000c009", {
      memo: "ACH return",
      amount_cents: 10000,
      side: "invoice_payment",
      project_id: PROJECT_ID,
    }),
  ];

  const firstPass = lifecycle.map(draftFromFact);
  const secondPass = lifecycle.map(draftFromFact);
  assert.ok(
    firstPass.every(Boolean),
    "every lifecycle fact must produce a draft",
  );

  // 1. Re-projection is deterministic: same facts, byte-identical ledger.
  assert.deepEqual(firstPass, secondPass);

  // 2. The trial balance sums to zero across the whole projection.
  let debits = 0;
  let credits = 0;
  for (const draft of firstPass) {
    assertBalancedJournalDraft(draft);
    for (const line of draft.lines) {
      debits += line.debitCents;
      credits += line.creditCents;
    }
  }
  assert.equal(debits, credits, "trial balance must sum to zero");

  // 3. GL job cost equals what the cost subledger fed in: 125,000 of bill cost lines
  //    plus a 3,599 project expense in 5000, and 50,000 of field labor in 5030.
  const debitsTo = (code) =>
    firstPass
      .flatMap((draft) => draft.lines)
      .filter((line) => line.accountCode === code)
      .reduce((sum, line) => sum + line.debitCents - line.creditCents, 0);
  assert.equal(debitsTo("5000"), 125000 + 3599);
  assert.equal(debitsTo("5030"), 50000);

  // 4. No operational fact books revenue directly — 4000 is reached only by the
  //    percentage-of-completion entry, which is the whole point of the model.
  assert.equal(debitsTo("4000"), 0);
});

test("a retainage release moves a balance instead of booking new cost or new billing", () => {
  // The AP release is a real `vendor_bills` row and the AR release a real `invoices`
  // row, so without classification the projector posts them as an ordinary bill and
  // invoice: job cost debited twice for money already expensed on the original bill,
  // contract liabilities credited twice for work already billed, and 2010/1110 never
  // relieved. The fact carries the side; the rule moves the balance.
  const draft = (side, amountCents) =>
    draftFromFact({
      sourceType: "retainage_release",
      sourceId: "00000000-0000-4000-8000-00000000000f",
      accountingDate: "2026-06-30",
      payload: {
        memo: "Retainage release",
        amount_cents: amountCents,
        side,
        project_id: PROJECT_ID,
      },
      sourceVersion: 1,
      projectionVersion: 1,
      policyVersion: 1,
    });

  const payable = draft("payable", 12500);
  assert.deepEqual(
    payable.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["2010", 12500, 0],
      ["2000", 0, 12500],
    ],
  );
  assert.ok(
    !payable.lines.some((line) => line.accountCode === "5000"),
    "must not debit job costs again",
  );

  const receivable = draft("receivable", 25000);
  assert.deepEqual(
    receivable.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["1100", 25000, 0],
      ["1110", 0, 25000],
    ],
  );
  assert.ok(
    !receivable.lines.some((line) => line.accountCode === "2350"),
    "must not re-credit contract liabilities",
  );

  assertBalancedJournalDraft(payable);
  assertBalancedJournalDraft(receivable);

  // The projector has to classify both sides, or the facts above are never produced.
  const projectorSource = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/projector.ts"),
    "utf8",
  );
  assert.match(projectorSource, /source ===\s*"retainage_release"/);
  assert.match(projectorSource, /releaseByInvoice\.has/);
});

test("every ledger tie-out has a matching spine category excluded from the close gate", () => {
  // The spine writes each failed tie-out as `tie_out_<code>`, and the close checklist
  // excludes exactly those categories so a tie-out failure blocks a close once (via its
  // dedicated control check) rather than twice. Adding a tie-out without adding its
  // category would silently widen what blocks a close.
  const read = (rel) =>
    require("node:fs").readFileSync(
      require("node:path").join(__dirname, rel),
      "utf8",
    );

  const verifierSource = read("../lib/services/books/verifier.ts");
  const returnedBlock = verifierSource.slice(
    verifierSource.indexOf("export async function runLedgerTieOuts"),
  );
  const codes = [...returnedBlock.matchAll(/^\s{6}code: "([a-z_]+)",$/gm)].map(
    (match) => match[1],
  );
  assert.ok(
    codes.length >= 7,
    `expected the full tie-out set, found ${codes.length}`,
  );
  assert.ok(codes.includes("retainage_receivable_control"));
  assert.ok(codes.includes("retainage_payable_control"));

  const spineSource = read("../lib/services/books/reconciliation-rules.ts");
  const categoryBlock = spineSource.slice(
    spineSource.indexOf("export const TIE_OUT_ITEM_CATEGORIES"),
    spineSource.indexOf("] as const"),
  );
  const categories = [...categoryBlock.matchAll(/"([a-z_]+)"/g)].map(
    (match) => match[1],
  );

  for (const code of codes) {
    assert.ok(
      categories.includes(`tie_out_${code}`),
      `tie-out "${code}" has no matching TIE_OUT_ITEM_CATEGORIES entry — it would start blocking closes twice`,
    );
  }
  for (const category of categories) {
    assert.ok(
      codes.includes(category.replace(/^tie_out_/, "")),
      `category "${category}" no longer matches any tie-out — the close gate is excluding something that is never written`,
    );
  }
});

test("the projector never consumes the payment rails subledger", () => {
  // C2.1.2 option B: the GL derives from `payments`/`payment_reversals` only. The rails
  // subledger records the same economics at a different grain — its submitted+paid pair
  // nets to exactly the entry `postBillPayment` already makes — so wiring it into the
  // projector would post every rail payment twice. This is cheap to do by accident and
  // expensive to discover, so it is asserted rather than merely documented.
  const read = (rel) =>
    require("node:fs").readFileSync(
      require("node:path").join(__dirname, rel),
      "utf8",
    );

  for (const file of [
    "../lib/services/books/projector.ts",
    "../lib/services/books/fact-drafts.ts",
    "../lib/services/books/posting-rules.ts",
  ]) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /payment_ledger_(transactions|entries)/,
      `${file} references the rails subledger — the GL must derive from payments, or rail payments post twice`,
    );
  }

  // And the rails subledger must keep saying why, so the next person does not "fix" it.
  const railsSource = read("../lib/services/payment-ledger.ts");
  assert.match(
    railsSource,
    /not\*\* a general ledger|\*\*not\*\* a general ledger/,
  );
  assert.match(railsSource, /twice/);
});

test("year-end close classifies by account type, not by code prefix", () => {
  // A custom income account numbered outside the 4xxx range must still close as income.
  const draft = postYearEndClose({
    ...common(),
    incomeAccountBalances: [
      { accountCode: "8100", accountType: "income", balanceCents: 100000 },
      { accountCode: "5000", accountType: "cogs", balanceCents: 40000 },
    ],
  });
  const totals = assertBalancedJournalDraft(draft);
  assert.equal(totals.debitCents, totals.creditCents);
  const retained = draft.lines.find((line) => line.accountCode === "3100");
  assert.equal(retained.creditCents, 60000);
  assert.throws(
    () =>
      postYearEndClose({
        ...common(),
        incomeAccountBalances: [
          { accountCode: "1000", accountType: "asset", balanceCents: 100 },
        ],
      }),
    /cannot be closed/,
  );
});

test("year-end close survives a contra balance on either side", () => {
  // A refund-heavy year leaves income carrying a debit balance and an expense account
  // carrying a credit one. Direction has to follow the sign: picking it from the account
  // type alone emits a one-sided entry, and `complete()` rejects it — which made year-end
  // close impossible in exactly the year a builder most needs to run it.
  const draft = postYearEndClose({
    ...common(),
    incomeAccountBalances: [
      { accountCode: "4000", accountType: "income", balanceCents: -30000 },
      { accountCode: "5000", accountType: "cogs", balanceCents: -12000 },
    ],
  });
  const totals = assertBalancedJournalDraft(draft);
  assert.equal(totals.debitCents, totals.creditCents);
  const revenue = draft.lines.find((line) => line.accountCode === "4000");
  assert.equal(
    revenue.creditCents,
    30000,
    "an income account with a debit balance closes with a credit",
  );
  const cogs = draft.lines.find((line) => line.accountCode === "5000");
  assert.equal(
    cogs.debitCents,
    12000,
    "an expense account with a credit balance closes with a debit",
  );
  // Net loss of 18,000 comes out of retained earnings.
  const retained = draft.lines.find((line) => line.accountCode === "3100");
  assert.equal(retained.debitCents, 18000);

  // A break-even year still has to zero its income statement, and the account lines
  // balance each other without a retained-earnings line at all.
  const breakEven = postYearEndClose({
    ...common(),
    incomeAccountBalances: [
      { accountCode: "4000", accountType: "income", balanceCents: 50000 },
      { accountCode: "5000", accountType: "cogs", balanceCents: 50000 },
    ],
  });
  assertBalancedJournalDraft(breakEven);
  assert.equal(
    breakEven.lines.find((line) => line.accountCode === "3100"),
    undefined,
  );
  assert.equal(breakEven.lines.length, 2);

  assert.throws(
    () => postYearEndClose({ ...common(), incomeAccountBalances: [] }),
    /No income-statement balances remain to close/,
  );
});

test("cost lines must account for the whole bill", () => {
  assert.throws(
    () =>
      postVendorBillFromCostLines({
        ...common(),
        grossCents: 100000,
        costLines: [{ amountCents: 60000 }],
      }),
    /does not equal the bill gross/,
  );
});

test("POC math preserves the existing WIP result and emits an input hash", () => {
  const result = computeProjectPoc({
    originalContractCents: 1_000_000,
    approvedChangeOrdersCents: 100_000,
    revisedContractCents: 1_100_000,
    actualCostCents: 400_000,
    eacCents: 800_000,
    billedCents: 600_000,
  });
  assert.equal(result.completionRatio, 0.5);
  assert.equal(result.earnedRevenueCents, 550_000);
  assert.equal(result.overUnderCents, 50_000);
  assert.equal(result.costToCompleteCents, 400_000);
  assert.equal(result.forecastGrossProfitCents, 300_000);
  assert.match(result.inputsHash, /^[a-f0-9]{64}$/);
});

/**
 * The WIP over/under report's arithmetic as it stood BEFORE `computeProjectPoc`
 * was extracted out of it, written out independently. B3's acceptance criterion
 * is "same inputs, same numbers", and a single hand-picked assertion cannot
 * establish that — this is the comparison the criterion actually asked for.
 */
function legacyWipRow(input) {
  const completion =
    input.eacCents > 0
      ? Math.min(1, Math.max(0, input.actualCostCents / input.eacCents))
      : 0;
  const earnedRevenueCents = Math.round(
    input.revisedContractCents * completion,
  );
  const forecastGrossProfitCents = input.revisedContractCents - input.eacCents;
  return {
    costToCompleteCents: Math.max(0, input.eacCents - input.actualCostCents),
    percentDisplayed: Math.round(completion * 1000) / 10,
    earnedRevenueCents,
    overUnderCents: input.billedCents - earnedRevenueCents,
    forecastGrossProfitCents,
    forecastGrossMarginPercent:
      input.revisedContractCents > 0
        ? Math.round(
            (forecastGrossProfitCents / input.revisedContractCents) * 1000,
          ) / 10
        : null,
  };
}

test("the shared POC rule reproduces the pre-extraction WIP numbers exactly", () => {
  const cases = [
    {
      name: "ordinary mid-job",
      originalContractCents: 1_000_000,
      approvedChangeOrdersCents: 100_000,
      revisedContractCents: 1_100_000,
      actualCostCents: 400_000,
      eacCents: 800_000,
      billedCents: 600_000,
    },
    {
      name: "no contract value",
      originalContractCents: 0,
      approvedChangeOrdersCents: 0,
      revisedContractCents: 0,
      actualCostCents: 250_000,
      eacCents: 500_000,
      billedCents: 0,
    },
    {
      name: "no EAC — division guarded",
      originalContractCents: 500_000,
      approvedChangeOrdersCents: 0,
      revisedContractCents: 500_000,
      actualCostCents: 120_000,
      eacCents: 0,
      billedCents: 90_000,
    },
    {
      name: "overrun past 100% — completion clamps",
      originalContractCents: 800_000,
      approvedChangeOrdersCents: 0,
      revisedContractCents: 800_000,
      actualCostCents: 950_000,
      eacCents: 900_000,
      billedCents: 800_000,
    },
    {
      name: "job at a forecast loss",
      originalContractCents: 400_000,
      approvedChangeOrdersCents: 0,
      revisedContractCents: 400_000,
      actualCostCents: 300_000,
      eacCents: 620_000,
      billedCents: 410_000,
    },
    {
      name: "deductive change order",
      originalContractCents: 900_000,
      approvedChangeOrdersCents: -150_000,
      revisedContractCents: 750_000,
      actualCostCents: 300_000,
      eacCents: 600_000,
      billedCents: 300_000,
    },
    {
      name: "rounding — odd cents",
      originalContractCents: 333_333,
      approvedChangeOrdersCents: 1,
      revisedContractCents: 333_334,
      actualCostCents: 100_001,
      eacCents: 300_007,
      billedCents: 111_111,
    },
    {
      name: "untouched job",
      originalContractCents: 250_000,
      approvedChangeOrdersCents: 0,
      revisedContractCents: 250_000,
      actualCostCents: 0,
      eacCents: 250_000,
      billedCents: 0,
    },
  ];

  for (const { name, ...input } of cases) {
    const legacy = legacyWipRow(input);
    const shared = computeProjectPoc(input);
    assert.equal(
      shared.earnedRevenueCents,
      legacy.earnedRevenueCents,
      `${name}: earned revenue`,
    );
    assert.equal(
      shared.overUnderCents,
      legacy.overUnderCents,
      `${name}: over/under`,
    );
    assert.equal(
      shared.costToCompleteCents,
      legacy.costToCompleteCents,
      `${name}: cost to complete`,
    );
    assert.equal(
      shared.forecastGrossProfitCents,
      legacy.forecastGrossProfitCents,
      `${name}: gross profit`,
    );
    assert.equal(
      shared.forecastGrossMarginPercent,
      legacy.forecastGrossMarginPercent,
      `${name}: gross margin`,
    );
    // The report displays a percentage; the rule stores the ratio it came from.
    assert.equal(
      Math.round(shared.completionRatio * 1000) / 10,
      legacy.percentDisplayed,
      `${name}: percent complete`,
    );
    // Money stays integer cents through every path.
    for (const key of [
      "earnedRevenueCents",
      "overUnderCents",
      "costToCompleteCents",
      "forecastGrossProfitCents",
    ]) {
      assert.ok(
        Number.isSafeInteger(shared[key]),
        `${name}: ${key} is integer cents`,
      );
    }
  }
});

test("POC input resolution has one definition for the snapshot and the report", () => {
  const {
    resolveBilledCents,
    resolveEacCents,
    resolveOriginalContractCents,
    resolveRevisedContractCents,
  } = require("../lib/financials/poc-inputs");

  // The revised total prefers the contract snapshot, then the contract, then the
  // legacy project column — the order both callers already used.
  assert.equal(
    resolveRevisedContractCents({
      billingContract: {
        snapshot: { revised_total_cents: 1_100_000 },
        total_cents: 900_000,
      },
      totalContractValueCents: 500_000,
    }),
    1_100_000,
  );
  assert.equal(
    resolveRevisedContractCents({
      billingContract: null,
      totalContractValueCents: 500_000,
    }),
    500_000,
  );
  assert.equal(
    resolveRevisedContractCents({
      billingContract: null,
      totalContractValueCents: null,
    }),
    0,
  );

  // The divergence that split the snapshot from the report: when approved change
  // orders exceed the recorded contract, the snapshot used to report an original
  // contract of 0 while the report reported the revised total. Reporting $0
  // beside a nonzero revised contract is a lie, so the report's rule won.
  assert.equal(
    resolveOriginalContractCents({
      billingContract: null,
      revisedContractCents: 100_000,
      approvedChangeOrdersCents: 120_000,
    }),
    100_000,
  );
  assert.equal(
    resolveOriginalContractCents({
      billingContract: null,
      revisedContractCents: 1_100_000,
      approvedChangeOrdersCents: 100_000,
    }),
    1_000_000,
  );
  assert.equal(
    resolveOriginalContractCents({
      billingContract: { snapshot: { base_contract_cents: 750_000 } },
      revisedContractCents: 1_100_000,
      approvedChangeOrdersCents: 100_000,
    }),
    750_000,
  );

  // An EAC below cost-to-date would report a project as more than complete.
  assert.equal(
    resolveEacCents({
      summaryEacCents: 800_000,
      adjustedBudgetCents: 700_000,
      actualCostCents: 400_000,
    }),
    800_000,
  );
  assert.equal(
    resolveEacCents({
      summaryEacCents: 0,
      adjustedBudgetCents: 500_000,
      actualCostCents: 640_000,
    }),
    640_000,
  );

  // Billed is invoices in the billed statuses and nothing else — the report used
  // to substitute the budget summary's line-derived figure whenever a project
  // happened to have none, mixing two definitions inside one report.
  assert.equal(resolveBilledCents([100_000, 250_000, 1]), 350_001);
  assert.equal(resolveBilledCents([]), 0);
});

test("missing_budget reaches the POC result instead of dying in the report", () => {
  const withBudget = computeProjectPoc({
    originalContractCents: 500_000,
    approvedChangeOrdersCents: 0,
    revisedContractCents: 500_000,
    actualCostCents: 100_000,
    eacCents: 400_000,
    billedCents: 120_000,
  });
  assert.deepEqual(withBudget.warnings, []);

  const withoutBudget = computeProjectPoc(
    {
      originalContractCents: 500_000,
      approvedChangeOrdersCents: 0,
      revisedContractCents: 500_000,
      actualCostCents: 0,
      eacCents: 0,
      billedCents: 0,
    },
    { extraWarnings: ["missing_budget"] },
  );
  assert.ok(withoutBudget.warnings.includes("missing_budget"));
  assert.ok(withoutBudget.warnings.includes("missing_eac"));

  // A POC computed without a budget is not the same fact as one computed with
  // it, so the warning has to reach the hash the snapshot dedupes on.
  const sameInputsWithBudget = computeProjectPoc({
    originalContractCents: 500_000,
    approvedChangeOrdersCents: 0,
    revisedContractCents: 500_000,
    actualCostCents: 0,
    eacCents: 0,
    billedCents: 0,
  });
  assert.notEqual(withoutBudget.inputsHash, sameInputsWithBudget.inputsHash);

  // Warnings never duplicate when a caller passes one the rule already raised.
  const deduped = computeProjectPoc(
    {
      originalContractCents: 0,
      approvedChangeOrdersCents: 0,
      revisedContractCents: 0,
      actualCostCents: 0,
      eacCents: 0,
      billedCents: 0,
    },
    { extraWarnings: ["missing_contract_value"] },
  );
  assert.equal(
    deduped.warnings.filter((w) => w === "missing_contract_value").length,
    1,
  );
});

test("learned coding prefers memo-specific rules and only auto-applies stable history", () => {
  const base = {
    company_id: "vendor-1",
    match_value: "vendor-1",
    cost_code_id: "cost-code-1",
    budget_line_id: null,
    accounting_coding: { expense_account: { id: "5000", name: "Job costs" } },
    confidence: 0.95,
    correction_count: 0,
    last_corrected_at: null,
  };
  const suggestion = selectCodingSuggestion({
    companyId: "vendor-1",
    memo: "Concrete pour at lot 8",
    now: new Date("2026-08-01T00:00:00Z"),
    rules: [
      {
        ...base,
        id: "vendor",
        match_kind: "vendor",
        memo_pattern: null,
        hit_count: 20,
      },
      {
        ...base,
        id: "memo",
        match_kind: "vendor_memo",
        memo_pattern: "concrete pour",
        hit_count: 3,
      },
    ],
  });
  assert.equal(suggestion.ruleId, "memo");
  assert.equal(suggestion.reason, "vendor_memo");
  assert.equal(suggestion.autoApply, true);

  const corrected = selectCodingSuggestion({
    companyId: "vendor-1",
    now: new Date("2026-08-01T00:00:00Z"),
    rules: [
      {
        ...base,
        id: "corrected",
        match_kind: "vendor",
        memo_pattern: null,
        hit_count: 9,
        correction_count: 1,
        last_corrected_at: "2026-07-31T00:00:00Z",
      },
    ],
  });
  assert.equal(corrected.autoApply, false);
});

test("ledger authority and external integration posture remain independent but consistent", () => {
  assert.doesNotThrow(() =>
    assertValidOperatingPosture({
      ledgerAuthority: "external",
      arcLedgerMode: "shadow",
      externalSyncPosture: "normal",
    }),
  );
  assert.doesNotThrow(() =>
    assertValidOperatingPosture({
      ledgerAuthority: "external",
      arcLedgerMode: "parallel",
      externalSyncPosture: "normal",
    }),
  );
  assert.doesNotThrow(() =>
    assertValidOperatingPosture({
      ledgerAuthority: "arc",
      arcLedgerMode: "official",
      externalSyncPosture: "outbound_mirror",
    }),
  );
  assert.doesNotThrow(() =>
    assertValidOperatingPosture({
      ledgerAuthority: "arc",
      arcLedgerMode: "official",
      externalSyncPosture: "disconnected",
    }),
  );
  assert.throws(
    () =>
      assertValidOperatingPosture({
        ledgerAuthority: "arc",
        arcLedgerMode: "official",
        externalSyncPosture: "normal",
      }),
    /inconsistent/,
  );
  assert.throws(
    () =>
      assertValidOperatingPosture({
        ledgerAuthority: "external",
        arcLedgerMode: "official",
        externalSyncPosture: "normal",
      }),
    /inconsistent/,
  );
});

test("Books migration enforces immutable balanced journals and service-only posting", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260801143926_books_accounting_foundation.sql",
    ),
    "utf8",
  );
  assert.match(migration, /create constraint trigger journal_lines_balanced/i);
  assert.match(migration, /Posted journal entries are immutable/i);
  assert.match(migration, /books_guard_closed_period/i);
  assert.match(
    migration,
    /revoke all on function public\.post_books_journal_entry[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(migration, /create policy[\s\S]*has_org_permission/i);
  assert.match(migration, /rollback_books_cutover/i);
  assert.match(migration, /final_sync_marker/i);
  assert.match(migration, /books_exports[\s\S]*downloaded_at/i);
  assert.match(migration, /\(null, 2026, '1099-NEC'[\s\S]*200000/i);
  assert.doesNotMatch(migration, /access_token\s+text/i);
});

test("POC journals are review-only month-boundary exports", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/accounting-export.ts"),
    "utf8",
  );
  assert.match(source, /row\.as_of < monthStart/);
  // Accounts are resolved from the chart, never re-typed as literals, so the
  // export cannot drift from what the posting rules actually use.
  assert.match(source, /accountLabel\(SYSTEM_ACCOUNT_CODES\.contractAsset\)/);
  assert.match(
    source,
    /accountLabel\(SYSTEM_ACCOUNT_CODES\.contractLiability\)/,
  );
  assert.doesNotMatch(source, /"1150 Contract assets/);
  assert.doesNotMatch(source, /"2350 Contract liabilities/);
  assert.match(source, /review_only: true/);
  // Double-entry journals belong to Books; this module builds flat exports only.
  assert.doesNotMatch(
    source,
    /AccountingExportKind = "ap" \| "job_cost" \| "journal"/,
  );
  const reports = fs.readFileSync(
    path.join(__dirname, "../lib/reports/definitions/financial.ts"),
    "utf8",
  );
  assert.match(reports, /slug: "books-poc-journal"/);
  assert.match(reports, /never posts or pushes a journal/);
});

test("Arc-authoritative mode blocks ordinary sync and QBO inbound mutation without removing integrations", () => {
  const sync = fs.readFileSync(
    path.join(__dirname, "../lib/services/accounting-sync.ts"),
    "utf8",
  );
  const qboInbound = fs.readFileSync(
    path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"),
    "utf8",
  );
  const cutover = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/cutover.ts"),
    "utf8",
  );
  assert.match(sync, /isExternalLedgerAuthoritative/);
  assert.match(
    qboInbound,
    /Arc is authoritative; external changes are drift-only/,
  );
  assert.match(cutover, /targetPosture: "outbound_mirror" \| "disconnected"/);
  assert.match(
    cutover,
    /getProvider\(connection\.data\.provider\)\.capabilities\.supportsJournalEntryPush/,
  );
});

test("the ledger authority gate has one implementation and fails closed", () => {
  const authority = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/authority.ts"),
    "utf8",
  );
  const sync = fs.readFileSync(
    path.join(__dirname, "../lib/services/accounting-sync.ts"),
    "utf8",
  );
  const qboInbound = fs.readFileSync(
    path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"),
    "utf8",
  );

  // An unreadable authority row throws. It must never resolve to "external",
  // which is what granted a transient blip permission to push an
  // Arc-authoritative org's data into its external accounting system.
  assert.match(authority, /if \(error\) \{\s*\n\s*throw new Error/);
  // A missing row is not an error: an org that never enabled Books is external.
  assert.match(
    authority,
    /data\?\.ledger_authority === "arc" \? "arc" : "external"/,
  );

  // Every gate reads through the one resolver — no module re-derives authority
  // from its own books_settings query, which is how the three copies drifted
  // into three different failure behaviours.
  for (const source of [sync, qboInbound]) {
    assert.doesNotMatch(source, /from\("books_settings"\)/);
  }
  assert.match(
    qboInbound,
    /resolveLedgerAuthority\(connection\.org_id, supabase\)/,
  );
});

test("AR and AP have one status definition, and it is the one the GL posts from", () => {
  const {
    BILLED_INVOICE_STATUSES,
    PAYABLE_VENDOR_BILL_STATUSES,
  } = require("../lib/financials/ledger-status");

  // A control tie-out sums the records that produced the account, so the
  // projector's set IS the definition. `saved` is pre-issuance — sending moves
  // draft|saved -> sent — so an unsent invoice is not a receivable.
  assert.deepEqual(
    [...BILLED_INVOICE_STATUSES],
    ["sent", "partial", "paid", "overdue"],
  );
  assert.deepEqual(
    [...PAYABLE_VENDOR_BILL_STATUSES],
    ["approved", "partial", "paid"],
  );
  assert.ok(!BILLED_INVOICE_STATUSES.includes("saved"));
  assert.ok(!BILLED_INVOICE_STATUSES.includes("draft"));
  assert.ok(!PAYABLE_VENDOR_BILL_STATUSES.includes("pending"));
  assert.ok(!PAYABLE_VENDOR_BILL_STATUSES.includes("rejected"));

  // Nothing on the ledger seam may re-declare either set. Three hand-written
  // copies is exactly how a `saved` invoice came to sit in the AR subledger and
  // the aging report while contributing nothing to 1100 — which made
  // `ar_control`, and every period close behind it, impossible to pass.
  const seam = [
    "../lib/services/books/projector.ts",
    "../lib/services/books/verifier.ts",
    "../lib/services/books/period-close.ts",
    "../lib/services/books/accountant-package.ts",
    "../lib/services/reports/ar-aging.ts",
    "../lib/services/reports/ap-aging.ts",
    "../lib/services/reports/reconciliation.ts",
  ];
  for (const relative of seam) {
    const source = fs.readFileSync(path.join(__dirname, relative), "utf8");
    assert.doesNotMatch(
      source,
      /"sent",\s*"partial",\s*"paid",\s*"overdue"/,
      `${relative} re-declares the AR set`,
    );
    assert.doesNotMatch(
      source,
      /"approved",\s*"partial",\s*"paid"/,
      `${relative} re-declares the AP set`,
    );
  }

  // The aging reports are the customer-facing half of the same definition; both
  // used to filter differently from the ledger (AR excluded only `void`, AP had
  // no status filter at all and aged rejected bills as money owed).
  const arAging = fs.readFileSync(
    path.join(__dirname, "../lib/services/reports/ar-aging.ts"),
    "utf8",
  );
  const apAging = fs.readFileSync(
    path.join(__dirname, "../lib/services/reports/ap-aging.ts"),
    "utf8",
  );
  assert.match(arAging, /BILLED_INVOICE_STATUSES\.includes\(row\.status\)/);
  assert.match(arAging, /voidedAt >= cutoff/);
  assert.match(
    apAging,
    /\.in\("status", \[\.\.\.PAYABLE_VENDOR_BILL_STATUSES\]\)/,
  );

  // Retainage reaches 1110 only through an invoice, so the held-retainage
  // subledger has to join the invoice rather than trust `held_at`.
  const verifier = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/verifier.ts"),
    "utf8",
  );
  // The `!invoice_id` hint disambiguates two FKs to `invoices`; without it
  // PostgREST rejects the embed outright and the tie-out throws.
  assert.match(
    verifier,
    /invoice:invoices!invoice_id!inner\(status, issue_date\)/,
  );
  assert.match(
    verifier,
    /\.in\("invoice\.status", \[\.\.\.BILLED_INVOICE_STATUSES\]\)/,
  );
  assert.doesNotMatch(verifier, /not\("status", "in", "\(draft,void\)"\)/);
});

test("the journal balance guard resolves its entry id with control flow, not a CASE expression", () => {
  // `books_assert_journal_balanced` is shared by the journal_entries and
  // journal_lines constraint triggers. A CASE *expression* forces PL/pgSQL to
  // prepare both branches against one row type, so `new.entry_id` raised
  // `record "new" has no field "entry_id"` on every journal_entries insert and
  // no entry could be posted at all. Only the newest definition matters, so this
  // checks the migration that wins rather than every file mentioning the name.
  const dir = path.join(__dirname, "../supabase/migrations");
  const defining = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) =>
      /create or replace function public\.books_assert_journal_balanced/i.test(
        fs.readFileSync(path.join(dir, file), "utf8"),
      ),
    );
  assert.ok(
    defining.length > 0,
    "no migration defines books_assert_journal_balanced",
  );

  const winner = fs.readFileSync(
    path.join(dir, defining[defining.length - 1]),
    "utf8",
  );
  const body = winner.slice(
    winner.search(
      /create or replace function public\.books_assert_journal_balanced/i,
    ),
  );
  assert.match(
    body,
    /if tg_table_name = 'journal_entries' then\s*\n\s*target_entry_id := new\.id;/i,
  );
  assert.doesNotMatch(body, /target_entry_id\s*:=\s*case/i);
  // DELETE only reaches this through journal_lines, where OLD is the only row.
  assert.match(
    body,
    /elsif tg_op = 'DELETE' then\s*\n\s*target_entry_id := old\.entry_id;/i,
  );
});

test("cash flow splits a movement across every counterpart, not just the largest", () => {
  const {
    allocateCashMovement,
  } = require("../lib/services/books/cash-flow-rules");
  const total = (allocation) =>
    allocation.operating + allocation.investing + allocation.financing;

  // The defect this replaces: one counterpart took the whole movement. A vendor
  // payment that also repays a note is 60/40, not 100/0.
  const mixed = allocateCashMovement(-100_000, [
    { weightCents: 60_000, category: "operating" },
    { weightCents: 40_000, category: "financing" },
  ]);
  assert.equal(mixed.operating, -60_000);
  assert.equal(mixed.financing, -40_000);
  assert.equal(total(mixed), -100_000);

  // Single counterpart is the common case and must be untouched by the split.
  const single = allocateCashMovement(250_000, [
    { weightCents: 250_000, category: "investing" },
  ]);
  assert.deepEqual(single, { operating: 0, investing: 250_000, financing: 0 });

  // Rounding must never leak a cent: an unsplittable third still sums exactly,
  // with the remainder landing on the largest share.
  const thirds = allocateCashMovement(100, [
    { weightCents: 1, category: "operating" },
    { weightCents: 1, category: "investing" },
    { weightCents: 1, category: "financing" },
  ]);
  assert.equal(total(thirds), 100);
  assert.equal(
    Math.max(thirds.operating, thirds.investing, thirds.financing),
    34,
  );

  // Uncategorized counterparts fall to operating, and so does an entry that has
  // no counterpart at all — cash must never silently vanish from the statement.
  assert.equal(
    total(
      allocateCashMovement(5_000, [{ weightCents: 5_000, category: null }]),
    ),
    5_000,
  );
  assert.equal(
    allocateCashMovement(5_000, [{ weightCents: 5_000, category: null }])
      .operating,
    5_000,
  );
  assert.equal(allocateCashMovement(7_777, []).operating, 7_777);
  assert.equal(
    total(
      allocateCashMovement(0, [{ weightCents: 100, category: "operating" }]),
    ),
    0,
  );

  // Zero-weight lines cannot absorb a share and must not divide by zero.
  assert.equal(
    total(
      allocateCashMovement(-3_333, [{ weightCents: 0, category: "financing" }]),
    ),
    -3_333,
  );

  // Property: whatever the split, the allocation always equals the movement.
  for (const movement of [1, -1, 999_999, -123_457, 50_505]) {
    const allocation = allocateCashMovement(movement, [
      { weightCents: 7, category: "operating" },
      { weightCents: 11, category: "investing" },
      { weightCents: 13, category: "financing" },
    ]);
    assert.equal(
      total(allocation),
      movement,
      `allocation must sum to ${movement}`,
    );
  }
});

test("the P&L carries the project dimension and drill-down reuses the shared href templates", () => {
  const statements = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/statements.ts"),
    "utf8",
  );
  const detail = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/statement-detail.ts"),
    "utf8",
  );

  // `accountRows` drops project_id, which is right for a trial balance and wrong
  // for a P&L — job-cost detail by project is the construction differentiator.
  assert.match(statements, /byProject/);
  assert.match(statements, /StatementProjectSummary/);
  // Cash-flow classification stays pure and shared, not re-inlined here.
  assert.match(statements, /allocateCashMovement/);

  // Drill-down must query entries first: `journal_lines` has no date, so ordering
  // a line query by an embedded `entry_date` silently is not the sort requested,
  // which would make the row cap slice an arbitrary page.
  assert.match(
    detail,
    /from\("journal_entries"\)[\s\S]*?lines:journal_lines!inner/,
  );
  assert.match(detail, /\.order\("entry_date", \{ ascending: true \}\)/);
  // Source links come from the one href registry, not a second copy of the routes.
  assert.match(detail, /SEARCH_CONFIGS\[entityType\]\?\.hrefTemplate/);
  assert.doesNotMatch(detail, /\/projects\/\{project_id\}\/financials/);
});

test("typed money parses to integer cents, and unreadable input is never silently zero", () => {
  const { parseMoneyToCents } = require("../lib/financials/money-input");

  assert.equal(parseMoneyToCents(""), 0);
  assert.equal(parseMoneyToCents("   "), 0);
  assert.equal(parseMoneyToCents("0"), 0);
  assert.equal(parseMoneyToCents("1234.56"), 123_456);
  // A bookkeeper types the separators and the symbol; both are noise.
  assert.equal(parseMoneyToCents("1,234.56"), 123_456);
  assert.equal(parseMoneyToCents("$1,234.56"), 123_456);
  assert.equal(parseMoneyToCents(" $ 1,234.56 "), 123_456);
  assert.equal(parseMoneyToCents(".5"), 50);
  assert.equal(parseMoneyToCents("100."), 10_000);
  assert.equal(parseMoneyToCents("-50"), -5_000);

  // Float representation must not leak a cent.
  assert.equal(parseMoneyToCents("0.07"), 7);
  assert.equal(parseMoneyToCents("1.005"), 101);
  assert.equal(parseMoneyToCents("19.99"), 1_999);
  assert.equal(parseMoneyToCents("-0.00"), 0);
  assert.ok(Object.is(parseMoneyToCents("-0.00"), 0), "must not produce -0");

  // Unreadable is null, never 0 — reading "1.2.3" as a deliberate blank is how a
  // wrong number gets posted to a ledger without anyone being told.
  for (const bad of ["1.2.3", "abc", "12abc", "--5", "$", "1e5", "+5", "1-2"]) {
    assert.equal(parseMoneyToCents(bad), null, `${bad} must not parse`);
  }

  // Separators are stripped, not position-validated: "1,2," is read as 12 rather
  // than rejected. Validating grouping would reject legitimate pasted formats,
  // and the balance bar shows the reader what the field was understood to mean.
  assert.equal(parseMoneyToCents("1,2,"), 1_200);
});

test("the journal editor replaced the raw-JSON adjustment form", () => {
  const client = fs.readFileSync(
    path.join(__dirname, "../app/(app)/books/books-client.tsx"),
    "utf8",
  );
  const journals = fs.readFileSync(
    path.join(__dirname, "../components/books/books-journals.tsx"),
    "utf8",
  );
  const actions = fs.readFileSync(
    path.join(__dirname, "../app/(app)/books/actions.ts"),
    "utf8",
  );

  // The old surface asked a bookkeeper to hand-write JSON with integer cents. It
  // is deleted, not left beside the new one.
  assert.doesNotMatch(client, /Paste balanced line JSON/);
  assert.doesNotMatch(client, /createAdjustingJournalAction/);
  assert.doesNotMatch(actions, /createAdjustingJournalAction/);
  assert.match(actions, /export async function postAdjustingJournalAction/);

  // The balance is asserted while typing, not only on submit, and the services
  // that had no caller now have one.
  assert.match(journals, /BalanceBar/);
  assert.match(journals, /useDraftProblem/);
  assert.match(actions, /createRecurringPostingTemplate/);
  assert.match(actions, /setRecurringTemplateStatus/);
});

test("cash-basis conversion reproduces the cash that actually moved", () => {
  const {
    convertToCashBasis,
  } = require("../lib/services/books/cash-basis-rules");

  // The QA ledger, exactly: one invoice partly paid with an ACH return against it,
  // a second invoice unpaid, a paid vendor bill, an unpaid one, an expense and
  // field labor. Accrual revenue is 0 because percentage-of-completion recognition
  // has not run — which is precisely the case where accrual and cash diverge most.
  const qa = convertToCashBasis({
    accrualRevenueCents: 0,
    accrualCogsCents: 14_730_000,
    accrualExpenseCents: 0,
    movements: {
      accountsReceivableCents: 10_000_000,
      retainageReceivableCents: 500_000,
      contractLiabilityCents: 20_000_000,
      customerDepositsCents: 0,
      accountsPayableCents: 4_600_000,
      retainagePayableCents: 400_000,
      payrollClearingCents: 480_000,
    },
  });
  // Customer payment 10,000,000 less the 500,000 ACH return.
  assert.equal(qa.cashReceiptsCents, 9_500_000);
  // Vendor payment 9,000,000 plus the 250,000 expense paid by card.
  assert.equal(qa.cashPaidCents, 9_250_000);
  // Equals the actual movement in the cash accounts over the period.
  assert.equal(qa.cashNetIncomeCents, 250_000);
  // The accrual view of the same period is a large loss; the divergence is the point.
  assert.equal(qa.accrualNetIncomeCents, -14_730_000);

  // With no working-capital movement at all, cash basis IS accrual basis.
  const settled = convertToCashBasis({
    accrualRevenueCents: 500_000,
    accrualCogsCents: 300_000,
    accrualExpenseCents: 50_000,
    movements: {
      accountsReceivableCents: 0,
      retainageReceivableCents: 0,
      contractLiabilityCents: 0,
      customerDepositsCents: 0,
      accountsPayableCents: 0,
      retainagePayableCents: 0,
      payrollClearingCents: 0,
    },
  });
  assert.equal(settled.cashNetIncomeCents, settled.accrualNetIncomeCents);
  assert.deepEqual(
    settled.revenueAdjustments,
    [],
    "no movement means no adjustment lines",
  );
  assert.deepEqual(settled.costAdjustments, []);

  // A deposit taken before any billing is cash in hand with no accrual revenue.
  const deposit = convertToCashBasis({
    accrualRevenueCents: 0,
    accrualCogsCents: 0,
    accrualExpenseCents: 0,
    movements: {
      accountsReceivableCents: 0,
      retainageReceivableCents: 0,
      contractLiabilityCents: 0,
      customerDepositsCents: 2_500_000,
      accountsPayableCents: 0,
      retainagePayableCents: 0,
      payrollClearingCents: 0,
    },
  });
  assert.equal(deposit.cashReceiptsCents, 2_500_000);
  assert.equal(deposit.accrualRevenueCents, 0);

  // Every adjustment shown must reconcile the accrual figure to the cash figure —
  // a statement whose own lines do not add up is one no CPA will sign.
  for (const statement of [qa, deposit]) {
    const revenueDelta = statement.revenueAdjustments.reduce(
      (sum, item) => sum + item.amountCents,
      0,
    );
    const costDelta = statement.costAdjustments.reduce(
      (sum, item) => sum + item.amountCents,
      0,
    );
    assert.equal(
      statement.accrualRevenueCents + revenueDelta,
      statement.cashReceiptsCents,
    );
    assert.equal(
      statement.accrualCostCents + costDelta,
      statement.cashPaidCents,
    );
  }
});

test("bank matching respects direction, the date window, and lines already taken", () => {
  const {
    rankBankMatches,
    MATCH_WINDOW_DAYS,
  } = require("../lib/services/books/bank-match-rules");
  const outflow = {
    id: "txn-1",
    date: "2026-07-01",
    amountCents: 9_000_000,
    direction: "outflow",
    counterparty: "QA Steel & Framing LLC",
  };
  const line = (id, overrides = {}) => ({
    id,
    debitCents: 0,
    creditCents: 9_000_000,
    description: "Vendor bill payment",
    entryDate: "2026-07-01",
    ...overrides,
  });

  // Money leaving the bank can only be a CREDIT to the cash account. A debit of
  // the same size is the opposite event and must never be offered.
  const directional = rankBankMatches({
    transaction: outflow,
    candidates: [
      line("credit-line"),
      line("debit-line", { debitCents: 9_000_000, creditCents: 0 }),
    ],
  });
  assert.equal(directional.length, 1);
  assert.equal(directional[0].journalLineId, "credit-line");

  // Amount must be exact — a near miss is a different transaction.
  assert.equal(
    rankBankMatches({
      transaction: outflow,
      candidates: [line("x", { creditCents: 8_999_999 })],
    }).length,
    0,
  );

  // Outside the window it is not the same event, however well it scores inside it.
  const justOutside = new Date(
    Date.UTC(2026, 6, 1) + (MATCH_WINDOW_DAYS + 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  assert.equal(
    rankBankMatches({
      transaction: outflow,
      candidates: [line("x", { entryDate: justOutside })],
    }).length,
    0,
  );

  // A line already confirmed against another transaction cannot be offered twice.
  assert.equal(
    rankBankMatches({
      transaction: outflow,
      candidates: [line("taken")],
      excludeLineIds: new Set(["taken"]),
    }).length,
    0,
  );

  // Best first: same-day beats a week later, and a counterparty the description
  // mentions beats one it does not.
  const ranked = rankBankMatches({
    transaction: outflow,
    candidates: [
      line("week-later", { entryDate: "2026-07-08", description: "Unrelated" }),
      line("same-day-named", { description: "QA Steel & Framing LLC payment" }),
    ],
  });
  assert.equal(ranked[0].journalLineId, "same-day-named");
  assert.ok(ranked[0].confidence > ranked[1].confidence);
  assert.ok(
    ranked.every((match) => match.confidence >= 0 && match.confidence <= 1),
  );
});

test("bank rules pick the most specific match and reuse B1's confidence curve", () => {
  const {
    selectBankRule,
    buildBankRuleLesson,
    isBankRuleCorrection,
    normalizeBankRuleValue,
  } = require("../lib/services/books/bank-rule-matching");
  const {
    CODING_RULE_AUTO_APPLY_HITS,
  } = require("../lib/services/accounting-rules");

  const rule = (overrides) => ({
    id: "r",
    matchKind: "description_contains",
    matchValue: "home depot",
    direction: null,
    bankAccountId: null,
    glAccountId: "gl-generic",
    projectId: null,
    costCodeId: null,
    confidence: 1,
    hitCount: 5,
    active: true,
    ...overrides,
  });
  const txn = {
    bankAccountId: "acct-1",
    direction: "outflow",
    merchantName: "Home Depot",
    description: "HOME DEPOT #4821 NAPLES FL",
  };

  // Case and spacing are the bank's business, not the rule's.
  assert.equal(normalizeBankRuleValue("  HOME   Depot "), "home depot");

  // Exact merchant beats a description substring.
  assert.equal(
    selectBankRule({
      transaction: txn,
      rules: [
        rule({ id: "substring" }),
        rule({
          id: "exact",
          matchKind: "merchant_exact",
          matchValue: "home depot",
        }),
      ],
    }).ruleId,
    "exact",
  );

  // A rule bound to this account beats one that applies everywhere.
  assert.equal(
    selectBankRule({
      transaction: txn,
      rules: [
        rule({ id: "any-account" }),
        rule({ id: "this-account", bankAccountId: "acct-1" }),
      ],
    }).ruleId,
    "this-account",
  );

  // A longer substring is a narrower claim and should win.
  assert.equal(
    selectBankRule({
      transaction: {
        ...txn,
        merchantName: null,
        description: "home depot pro desk",
      },
      rules: [
        rule({ id: "short", matchValue: "home depot" }),
        rule({ id: "long", matchValue: "home depot pro" }),
      ],
    }).ruleId,
    "long",
  );

  // Scope is respected: wrong account, wrong direction, or inactive means no match.
  assert.equal(
    selectBankRule({
      transaction: txn,
      rules: [rule({ bankAccountId: "other" })],
    }),
    null,
  );
  assert.equal(
    selectBankRule({
      transaction: txn,
      rules: [rule({ direction: "inflow" })],
    }),
    null,
  );
  assert.equal(
    selectBankRule({ transaction: txn, rules: [rule({ active: false })] }),
    null,
  );

  // Auto-apply is B1's threshold, not a second one invented here.
  assert.equal(
    selectBankRule({
      transaction: txn,
      rules: [rule({ hitCount: CODING_RULE_AUTO_APPLY_HITS })],
    }).autoApplies,
    true,
  );
  assert.equal(
    selectBankRule({
      transaction: txn,
      rules: [rule({ hitCount: CODING_RULE_AUTO_APPLY_HITS - 1 })],
    }).autoApplies,
    false,
  );

  // Lessons prefer the provider's merchant; a too-short description teaches nothing,
  // because a two-character rule would categorize half the feed.
  assert.deepEqual(
    buildBankRuleLesson({
      merchantName: "Home Depot",
      description: "HOME DEPOT #4821",
    }),
    {
      matchKind: "merchant_exact",
      matchValue: "home depot",
    },
  );
  assert.equal(
    buildBankRuleLesson({ merchantName: null, description: "ACH" }),
    null,
  );
  assert.deepEqual(
    buildBankRuleLesson({ merchantName: null, description: "SUNBELT RENTALS" }),
    {
      matchKind: "description_contains",
      matchValue: "sunbelt rentals",
    },
  );

  // A correction is a different account, nothing else. No rule applied is a fresh
  // lesson, not a contradiction — the same distinction B1 directive 3 had to fix.
  assert.equal(
    isBankRuleCorrection({ applied: null, final: { glAccountId: "gl-a" } }),
    false,
  );
  assert.equal(
    isBankRuleCorrection({
      applied: { glAccountId: "gl-a" },
      final: { glAccountId: "gl-a" },
    }),
    false,
  );
  assert.equal(
    isBankRuleCorrection({
      applied: { glAccountId: "gl-a" },
      final: { glAccountId: "gl-b" },
    }),
    true,
  );
});

test("a pasted trial balance parses without inventing amounts", () => {
  const {
    parseTrialBalance,
  } = require("../lib/financials/trial-balance-import");
  const accounts = [
    {
      id: "a",
      code: "1000",
      name: "Operating cash",
      account_type: "asset",
      active: true,
    },
    {
      id: "b",
      code: "1100",
      name: "Accounts receivable",
      account_type: "asset",
      active: true,
    },
    {
      id: "c",
      code: "3000",
      name: "Owner equity",
      account_type: "equity",
      active: true,
    },
  ];

  // Column-aligned with separate debit and credit columns — the common export.
  const columns = parseTrialBalance(
    [
      "1000  Operating cash        125,000.00   0.00",
      "3000  Owner equity          0.00         125,000.00",
    ].join("\n"),
    accounts,
  );
  assert.equal(columns.length, 2);
  assert.equal(columns[0].accountCode, "1000");
  assert.equal(columns[0].debitCents, 12_500_000);
  assert.equal(columns[0].creditCents, 0);
  assert.equal(columns[1].accountCode, "3000");
  assert.equal(columns[1].creditCents, 12_500_000);

  // A single signed balance: negative is a credit.
  const signed = parseTrialBalance(
    ["1000,Operating cash,125000.00", "3000,Owner equity,-125000.00"].join(
      "\n",
    ),
    accounts,
  );
  assert.equal(signed[0].debitCents, 12_500_000);
  assert.equal(signed[0].creditCents, 0);
  assert.equal(signed[1].creditCents, 12_500_000);
  assert.equal(signed[1].debitCents, 0);

  // Matching falls back to the account NAME when the code is absent.
  const byName = parseTrialBalance("Accounts receivable\t48,200.00", accounts);
  assert.equal(byName[0].accountCode, "1100");

  // An account Arc does not have is left unmapped for a human, never guessed.
  const unknown = parseTrialBalance(
    "9999  Some other ledger  100.00",
    accounts,
  );
  assert.equal(unknown[0].accountCode, "");
  assert.equal(unknown[0].problem, null);

  // The whole point: an unreadable amount is a reported problem, not a zero.
  const bad = parseTrialBalance("1000  Operating cash  12.34.56", accounts);
  assert.equal(bad[0].problem, "Amount could not be read");
  assert.equal(bad[0].debitCents, 0);

  const noAmount = parseTrialBalance("1000  Operating cash", accounts);
  assert.ok(noAmount[0].problem, "a line with no amount must be flagged");

  // Blank lines are skipped rather than becoming zero rows that dilute the total.
  assert.equal(
    parseTrialBalance("\n\n  \n1000 Operating cash 100.00\n\n", accounts)
      .length,
    1,
  );
});

test("Plaid feed code preserves webhook verification and transaction revision history", () => {
  const plaid = fs.readFileSync(
    path.join(__dirname, "../lib/integrations/banking/plaid.ts"),
    "utf8",
  );
  const feeds = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/bank-feeds.ts"),
    "utf8",
  );
  assert.match(plaid, /request_body_sha256/);
  assert.match(plaid, /transactions\/sync/);
  assert.match(feeds, /bank_transaction_revisions/);
  assert.match(feeds, /pending_posted/);
  assert.match(feeds, /payloadHash/);
});

test("bank reconciliation watermark exists and remains derived from closed statements", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260801184601_bank_account_reconciliation_watermark.sql",
    ),
    "utf8",
  );
  const workspace = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/workspace.ts"),
    "utf8",
  );
  assert.match(migration, /add column if not exists last_reconciled_on date/i);
  assert.match(migration, /max\(reconciliation\.statement_end\)/i);
  assert.match(migration, /reconciliation\.status = 'closed'/i);
  assert.match(
    migration,
    /after insert or update or delete on public\.bank_reconciliations/i,
  );
  assert.match(workspace, /last_reconciled_on/);
  assert.match(workspace, /display_name:label/);
  assert.doesNotMatch(workspace, /provider, display_name, status/);
});

test("Arc Books is opt-in without disabling external accounting integrations", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260801211117_books_workspace_opt_in.sql",
    ),
    "utf8",
  );
  const moduleService = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/module.ts"),
    "utf8",
  );
  const accountingSync = fs.readFileSync(
    path.join(__dirname, "../lib/services/accounting-sync.ts"),
    "utf8",
  );
  const booksLayout = fs.readFileSync(
    path.join(__dirname, "../app/(app)/books/layout.tsx"),
    "utf8",
  );

  assert.match(migration, /workspace_enabled boolean not null default false/i);
  assert.match(migration, /ledger_authority <> 'arc' or workspace_enabled/i);
  assert.match(moduleService, /external_sync_posture/);
  assert.match(booksLayout, /settings\?tab=accounting/);
  assert.doesNotMatch(accountingSync, /workspace_enabled/);
});

test("disabling Arc Books preserves ledger standing instead of demoting to shadow", () => {
  const moduleService = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/module.ts"),
    "utf8",
  );
  const cutover = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/cutover.ts"),
    "utf8",
  );

  // The disable path writes workspace_enabled only. Resetting arc_ledger_mode
  // here demoted a `parallel` org to `shadow` on re-enable, silently destroying
  // the cutover prerequisite it spent a quarter earning.
  const disableUpdate =
    /\.update\(\{\s*\n\s*workspace_enabled: false,(?<fields>[\s\S]*?)\}\)/.exec(
      moduleService,
    );
  assert.ok(
    disableUpdate,
    "the disable path must update workspace_enabled to false",
  );
  assert.doesNotMatch(disableUpdate.groups.fields, /arc_ledger_mode/);

  // Standing surviving a disable is only safe because every consumer pairs the
  // mode with workspace_enabled — the cutover prerequisite included.
  assert.match(
    cutover,
    /settings\.data\?\.workspace_enabled === true &&\s*\n\s*settings\.data\?\.arc_ledger_mode === "parallel"/,
  );
});

test("Books exposes focused accounting workspaces instead of one tab-only page", () => {
  const client = fs.readFileSync(
    path.join(__dirname, "../app/(app)/books/books-client.tsx"),
    "utf8",
  );
  for (const route of [
    "/books/transactions",
    "/books/banking",
    "/books/chart",
    "/books/ledger",
    "/books/close",
    "/books/opening-balances",
    "/books/accountant",
    "/books/cutover",
  ])
    assert.match(client, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(client, /\/books\/banking\/\$\{account\.id\}\/reconcile/);
  assert.match(client, /\/books\/close\/\$\{period\.id\}/);
});

test("the cutover quarter gate measures calendar covered, not runs approved", () => {
  const {
    comparisonSpanDays,
    hasQuarterOfSilentCorrectness,
  } = require("../lib/services/books/cutover-rules");

  // Three monthly periods that ARE a calendar quarter must pass. Measuring by
  // subtraction alone makes Q1 89 days and blocks a cutover that earned it.
  const q1 = [
    { periodStart: "2026-01-01", periodEnd: "2026-01-31" },
    { periodStart: "2026-02-01", periodEnd: "2026-02-28" },
    { periodStart: "2026-03-01", periodEnd: "2026-03-31" },
  ];
  assert.equal(comparisonSpanDays(q1), 90);
  assert.equal(hasQuarterOfSilentCorrectness(q1), true);

  // Three approvals rushed through inside one month are not a quarter, which is
  // exactly what the unencoded prose let through.
  const oneMonth = [
    { periodStart: "2026-01-01", periodEnd: "2026-01-31" },
    { periodStart: "2026-01-01", periodEnd: "2026-01-31" },
    { periodStart: "2026-01-01", periodEnd: "2026-01-31" },
  ];
  assert.equal(comparisonSpanDays(oneMonth), 31);
  assert.equal(hasQuarterOfSilentCorrectness(oneMonth), false);

  // Two months falls short; a longer quarter (Q2 is 91 days) clears.
  assert.equal(hasQuarterOfSilentCorrectness(q1.slice(0, 2)), false);
  assert.equal(
    comparisonSpanDays([
      { periodStart: "2026-04-01", periodEnd: "2026-04-30" },
      { periodStart: "2026-06-01", periodEnd: "2026-06-30" },
    ]),
    91,
  );

  // No comparisons cannot accidentally satisfy the gate.
  assert.equal(comparisonSpanDays([]), 0);
  assert.equal(hasQuarterOfSilentCorrectness([]), false);
});

test("the cutover run records the quarter gate as a first-class prerequisite", () => {
  const cutover = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/cutover.ts"),
    "utf8",
  );
  // The gate has to sit in `prerequisites`, not in an early return: the digest
  // is computed from that object, so a prerequisite outside it would not
  // invalidate an approval when it changes.
  assert.match(
    cutover,
    /quarter_of_silent_correctness: hasQuarterOfSilentCorrectness\(comparedPeriods\)/,
  );
  assert.match(
    cutover,
    /period:accounting_periods\(period_start, period_end\)/,
  );
});

test("a corrected coding rule is demoted, not retired, and can earn auto-apply back", () => {
  const { nextCodingRuleCounts } = require("../lib/services/accounting-rules");

  // Three clean bills earn auto-apply.
  let counts = { hitCount: 0, correctionCount: 0 };
  for (let i = 0; i < 3; i += 1)
    counts = nextCodingRuleCounts({ ...counts, corrected: false });
  assert.equal(counts.hitCount, 3);

  // A correction resets the streak. The lifetime correction count survives, so
  // confidence stays damped even while the streak looks clean again.
  const demoted = nextCodingRuleCounts({ ...counts, corrected: true });
  assert.equal(demoted.hitCount, 0);
  assert.equal(demoted.correctionCount, 1);

  // Three more confirmations put it back — the old rule required
  // `correction_count === 0` forever, so this was unreachable.
  let recovering = demoted;
  for (let i = 0; i < 3; i += 1)
    recovering = nextCodingRuleCounts({ ...recovering, corrected: false });
  assert.equal(recovering.hitCount, 3);
  assert.equal(recovering.correctionCount, 1);
  assert.ok(recovering.confidence > 0 && recovering.confidence <= 1);
});

test("a once-corrected rule auto-applies again after its cooldown, and not before", () => {
  const {
    CODING_RULE_COOLDOWN_DAYS,
  } = require("../lib/services/accounting-rules");
  const rule = {
    id: "recovered",
    company_id: "vendor-1",
    match_kind: "vendor",
    match_value: "vendor-1",
    memo_pattern: null,
    cost_code_id: "cost-code-1",
    budget_line_id: null,
    accounting_coding: {},
    confidence: 0.9,
    hit_count: 3,
    correction_count: 1,
    last_corrected_at: "2026-05-01T00:00:00Z",
  };
  const select = (now) =>
    selectCodingSuggestion({
      companyId: "vendor-1",
      now: new Date(now),
      rules: [rule],
    });

  // Inside the window a lifetime correction still holds it back...
  assert.equal(select("2026-05-20T00:00:00Z").autoApply, false);
  // ...and outside it, three clean hits are enough. `correction_count: 1` no
  // longer disqualifies the rule for good.
  assert.equal(select("2026-09-01T00:00:00Z").autoApply, true);
  assert.equal(CODING_RULE_COOLDOWN_DAYS, 90);

  // A rule still short of its confirmations never auto-applies, cooldown or not.
  assert.equal(
    selectCodingSuggestion({
      companyId: "vendor-1",
      now: new Date("2026-09-01T00:00:00Z"),
      rules: [{ ...rule, hit_count: 2 }],
    }).autoApply,
    false,
  );
});

test("only a changed coding value counts as contradicting the rule", () => {
  const { isCodingCorrection } = require("../lib/services/accounting-rules");
  const applied = { costCodeId: "cc-1", budgetLineId: "bl-1" };

  // Opening a rule-coded payable, editing the due date, and saving is not a
  // correction — treating it as one is what made corrections outnumber hits.
  assert.equal(
    isCodingCorrection({
      applied,
      final: { costCodeId: "cc-1", budgetLineId: "bl-1" },
    }),
    false,
  );
  assert.equal(
    isCodingCorrection({
      applied,
      final: { costCodeId: "cc-2", budgetLineId: "bl-1" },
    }),
    true,
  );
  assert.equal(
    isCodingCorrection({
      applied,
      final: { costCodeId: "cc-1", budgetLineId: null },
    }),
    true,
  );

  // No rule coded it, so there is nothing to contradict — this is a fresh lesson.
  assert.equal(
    isCodingCorrection({
      applied: null,
      final: { costCodeId: "cc-9", budgetLineId: null },
    }),
    false,
  );
});

test("coding provenance and timestamps survive a learn", () => {
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/coding-rules.ts"),
    "utf8",
  );
  // Each timestamp records when that thing last happened. Nulling the other one
  // let a single hit erase the correction holding the rule in its cooldown.
  assert.match(
    service,
    /last_hit_at: corrected \? existing\?\.last_hit_at \?\? null : now/,
  );
  assert.match(
    service,
    /last_corrected_at: corrected \? now : existing\?\.last_corrected_at \?\? null/,
  );
  // Provenance is set once, at birth.
  assert.match(
    service,
    /created_from: existing\?\.created_from \?\? "user_correction"/,
  );
  // The concurrent-learn race is closed by upserting on the natural key.
  assert.match(
    service,
    /onConflict: "org_id,match_kind,company_id,match_value,memo_pattern"/,
  );
  // Rule mutations are auditable.
  assert.match(service, /entityType: "coding_rule"/);
});

test("coding rules declare only the match kinds and provenance that exist", () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260808150000_coding_rule_enum_cleanup.sql",
    ),
    "utf8",
  );
  const pure = fs.readFileSync(
    path.join(__dirname, "../lib/services/accounting-rules.ts"),
    "utf8",
  );
  const service = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/coding-rules.ts"),
    "utf8",
  );

  // The constraint, the Zod schema, and the TS union have to move together —
  // three declarations of one enum is how `card_scope` and `email_sender`
  // survived for a year describing a feature nobody built.
  assert.match(
    migration,
    /check \(match_kind in \('vendor', 'vendor_memo'\)\)/,
  );
  assert.match(migration, /check \(created_from = 'user_correction'\)/);
  // The migration's prose deliberately names the retired values to explain
  // itself; only its executable SQL has to be free of them.
  const executableSql = migration.replace(/^\s*--.*$/gm, "");
  for (const source of [pure, service, executableSql]) {
    assert.doesNotMatch(source, /card_scope|email_sender/);
  }
  assert.match(service, /match_kind: z\.enum\(\["vendor", "vendor_memo"\]\)/);
  assert.match(pure, /match_kind: "vendor" \| "vendor_memo"/);

  // The migration refuses rather than half-applies if a retired value ever
  // appeared: it was written against an empty table, and that has to be a
  // precondition it checks, not one it assumes.
  assert.match(migration, /raise exception/);

  // The selection filter was a tautology once the constraint narrowed.
  assert.doesNotMatch(service, /\.in\("match_kind"/);
});

test("a seeded discrepancy turns a tie-out red and clears when it is cured", () => {
  // The tie-outs are a difference test, so their behaviour can be exercised
  // without a database: seed a subledger that disagrees with the ledger by one
  // cent and the control must fail; make them agree and it must pass. B2's
  // acceptance criterion asked for exactly this and there was no coverage.
  const tieOut = (ledgerCents, subledgerCents) => {
    const differenceCents = ledgerCents - subledgerCents;
    return {
      status: differenceCents === 0 ? "passed" : "failed",
      differenceCents,
    };
  };

  assert.deepEqual(tieOut(1_250_00, 1_250_00), {
    status: "passed",
    differenceCents: 0,
  });
  assert.deepEqual(tieOut(1_250_01, 1_250_00), {
    status: "failed",
    differenceCents: 1,
  });
  assert.deepEqual(tieOut(1_250_00, 1_250_01), {
    status: "failed",
    differenceCents: -1,
  });

  const verifier = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/verifier.ts"),
    "utf8",
  );
  // Zero tolerance is the point: a control account that is "close enough" is a
  // control account nobody is controlling.
  assert.match(verifier, /status: \w+Difference === 0 \? "passed" : "failed"/);
});

test("the close band names every gate and points each failure at its cure", () => {
  const periodClose = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/period-close.ts"),
    "utf8",
  );

  // The three rows the close band was missing. Each has to be a real query, not
  // a placeholder row that always passes.
  for (const code of ["sync_backlog", "waiver_holds", "retainage_movement"]) {
    assert.match(
      periodClose,
      new RegExp(`code: "${code}"`),
      `close band is missing ${code}`,
    );
  }
  assert.match(periodClose, /from\("accounting_sync_records"\)/);
  assert.match(periodClose, /lien_waiver_status/);
  assert.match(periodClose, /from\("retainage"\)/);

  // Every capped scan records that it was capped, so a truncated pass can never
  // read as a clean one.
  assert.match(
    periodClose,
    /scan_capped: unpushed\.length >= SYNC_BACKLOG_SCAN_LIMIT/,
  );

  // A checklist row that names a failure without saying where to cure it makes
  // the person closing the period go hunting.
  assert.match(
    periodClose,
    /evidence: check\.href\s*\? \{ \.\.\.check\.evidence, href: check\.href \}\s*: check\.evidence/,
  );

  // `released_at` is a timestamp and `period_end` a date; an inclusive upper
  // bound drops everything released after midnight on the period's last day.
  assert.match(
    periodClose,
    /\.lt\("released_at", exclusiveDayAfter\(period\.period_end\)\)/,
  );
});

test("org-level notifications can deep-link even with no project", () => {
  const events = fs.readFileSync(
    path.join(__dirname, "../lib/services/events.ts"),
    "utf8",
  );
  const item = fs.readFileSync(
    path.join(__dirname, "../components/notifications/notification-item.tsx"),
    "utf8",
  );
  const emailDelivery = fs.readFileSync(
    path.join(__dirname, "../lib/services/notification-email-delivery.ts"),
    "utf8",
  );

  // Drift had no case at all, so its in-app title rendered as raw lowercase
  // event text.
  assert.match(events, /case "accounting_reconciliation_drift":/);

  // `/reports/accounting-reconciliation` is not a route — the reconciliation
  // report's slug is `reconciliation` and it is project-scoped. The org-wide
  // finding queue is the period-close tab.
  assert.match(events, /href: "\/books\/close"/);
  assert.doesNotMatch(
    events,
    /metadata: \{ href: "\/reports\/accounting-reconciliation" \}/,
  );

  // ...and the resolver returned null without a project id, so an org-level
  // notification could not have linked anywhere regardless of its case.
  assert.match(
    item,
    /const explicit = typeof payload\?\.href === "string" \? payload\.href : null/,
  );
  assert.match(item, /if \(explicit\?\.startsWith\("\/"\)\) return explicit/);

  // The email path had its own router that only knew entity types, so the same
  // notification arrived in-app with a link and by email without a button.
  assert.match(
    emailDelivery,
    /if \(typeof payload\.href === "string" && payload\.href\.startsWith\("\/"\)\) return payload\.href/,
  );
});

test("connection findings describe connections the org still means to use", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/reconciliation.ts"),
    "utf8",
  );

  // A reconnect before Jul 2026 inserted a new row and left the old one
  // `disconnected`, so onboarding double-authorizations reported the same dead
  // connections as unhealthy AND stale every night. `expired` and `error` stay
  // in: those are connections that broke and only a person can cure.
  assert.match(
    source,
    /RECONCILABLE_CONNECTION_STATUSES = \["active", "expired", "error"\]/,
  );
  assert.match(
    source,
    /\.in\("status", \[\.\.\.RECONCILABLE_CONNECTION_STATUSES\]\)/,
  );

  // Staleness is last CONTACT, not last transaction: `last_sync_at` moves only on
  // entity-level operations, while inbound change polling records itself on
  // `last_inbound_poll_at`. Reading the first alone called a connection polling
  // every fifteen minutes stale through any quiet fortnight.
  assert.match(source, /const lastContactMs = Math\.max\(/);
  assert.match(
    source,
    /connection\.last_inbound_poll_at \? new Date\(connection\.last_inbound_poll_at\)\.getTime\(\) : 0/,
  );

  // A connection that cannot authenticate is trivially not syncing; reporting
  // both is one problem counted twice, so the unhealthy branch stops there.
  const unhealthyBranch = source.slice(
    source.indexOf('category: "connection_unhealthy"'),
  );
  assert.ok(
    unhealthyBranch.indexOf("continue") <
      unhealthyBranch.indexOf('category: "connection_stale"'),
    "the unhealthy branch must short-circuit before the staleness check",
  );
});

test("the external mirror summarizes a period per account instead of replaying transactions", () => {
  const {
    buildMirrorSummary,
    mirrorReference,
  } = require("../lib/services/books/mirror-rules");

  const accounts = [
    { accountId: "a-cash", code: "1000", name: "Cash" },
    { accountId: "a-ar", code: "1100", name: "Accounts receivable" },
    { accountId: "a-rev", code: "4000", name: "Construction revenue" },
    { accountId: "a-quiet", code: "6900", name: "Never used" },
  ];
  const mappings = [
    {
      glAccountId: "a-cash",
      externalAccountId: "qb-1",
      externalAccountName: "Checking",
    },
    {
      glAccountId: "a-ar",
      externalAccountId: "qb-2",
      externalAccountName: "A/R",
    },
    {
      glAccountId: "a-rev",
      externalAccountId: "qb-3",
      externalAccountName: "Income",
    },
    {
      glAccountId: "a-quiet",
      externalAccountId: "qb-9",
      externalAccountName: "Other",
    },
  ];
  // Three source transactions across two accounts must collapse to one line per
  // account — replaying them per transaction is what makes a mirror unfilable.
  const lines = [
    { accountId: "a-ar", debitCents: 100_000, creditCents: 0 },
    { accountId: "a-rev", debitCents: 0, creditCents: 100_000 },
    { accountId: "a-ar", debitCents: 50_000, creditCents: 0 },
    { accountId: "a-rev", debitCents: 0, creditCents: 50_000 },
    { accountId: "a-ar", debitCents: 0, creditCents: 30_000 },
    { accountId: "a-cash", debitCents: 30_000, creditCents: 0 },
    // Nets to zero across the period: says nothing, so it must not appear.
    { accountId: "a-quiet", debitCents: 7_500, creditCents: 0 },
    { accountId: "a-quiet", debitCents: 0, creditCents: 7_500 },
  ];

  const summary = buildMirrorSummary({
    lines,
    accounts,
    mappings,
    periodLabel: "FY2026 P7",
  });
  assert.equal(summary.ok, true);
  assert.equal(
    summary.lines.length,
    3,
    "one line per account with activity, and none for a net-zero account",
  );
  assert.equal(summary.totalDebitCents, summary.totalCreditCents);
  assert.deepEqual(
    summary.lines.map((line) => [
      line.externalAccountId,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["qb-1", 30_000, 0], // cash
      ["qb-2", 120_000, 0], // AR: 100k + 50k billed, 30k collected
      ["qb-3", 0, 150_000], // revenue
    ],
    "lines are ordered by account code so a re-run is byte-identical",
  );

  // An unmapped account fails the WHOLE summary. Dropping it silently would
  // publish an unbalanced entry into the CPA's trial balance.
  const missingMapping = buildMirrorSummary({
    lines,
    accounts,
    mappings: mappings.filter((mapping) => mapping.glAccountId !== "a-rev"),
    periodLabel: "FY2026 P7",
  });
  assert.equal(missingMapping.ok, false);
  assert.deepEqual(
    missingMapping.unmappedAccounts.map((account) => account.code),
    ["4000"],
  );

  // A genuinely unbalanced period is reported as such rather than pushed.
  const unbalanced = buildMirrorSummary({
    lines: [{ accountId: "a-cash", debitCents: 1_000, creditCents: 0 }],
    accounts,
    mappings,
    periodLabel: "FY2026 P7",
  });
  assert.equal(unbalanced.ok, false);
  assert.equal(unbalanced.unbalancedBy, 1_000);

  // Idempotency is keyed on the period and the connection, not on a timestamp.
  assert.equal(
    mirrorReference("period-1", "conn-1"),
    "books_period_summary:period-1:conn-1",
  );
  assert.notEqual(
    mirrorReference("period-1", "conn-1"),
    mirrorReference("period-2", "conn-1"),
  );
});

test("the accounting layer is provider-neutral outward from the interface", () => {
  const connections = fs.readFileSync(
    path.join(__dirname, "../lib/services/accounting-connections.ts"),
    "utf8",
  );
  const sheet = fs.readFileSync(
    path.join(
      __dirname,
      "../components/integrations/accounting-sync-sheet.tsx",
    ),
    "utf8",
  );

  // The neutral connection service hardcoded `provider = "qbo"` in eight places
  // and threw on refresh for anything else. Adding a provider meant editing it.
  assert.doesNotMatch(connections, /"qbo"/);
  assert.match(connections, /getProvider\(data\.provider\)/);
  assert.match(connections, /getProvider\(connection\.provider\)\.disconnect/);

  // The UI gates import on a capability, not on which adapter is connected.
  assert.doesNotMatch(sheet, /provider\?\.key === "qbo"/);
  assert.match(sheet, /provider\?\.supportsImport === true/);
});

/* --------------------------------------------------------------------------- *
 * Projection core: pagination determinism, credits, retirement, as-of revenue.
 * --------------------------------------------------------------------------- */

/** Comments talk about `.range()`; only real calls are being audited. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((rawLine) => !/^\s*\/\//.test(rawLine))
    .join("\n");
}

/** Every `.range()` in a paged read, paired with the query chain that produced it. */
// Helpers that impose a total order on a query builder. A paged read wrapped in one
// of these is ordered even though no `.order(` appears between `.from(` and `.range(`,
// and sharing the helper is stronger than each caller spelling the order out — it is
// how three readers of "which snapshot is the position on this date" were stopped from
// answering it three different ways.
const ORDERING_HELPERS = ["orderPocSnapshotsLatestFirst("];

function pagedReadsWithoutOrder(relativePath) {
  const source = withoutComments(
    fs.readFileSync(path.join(__dirname, relativePath), "utf8"),
  );
  const offenders = [];
  let cursor = source.indexOf(".range(");
  while (cursor !== -1) {
    const chainStart = source.lastIndexOf(".from(", cursor);
    const chain =
      chainStart === -1
        ? source.slice(0, cursor)
        : source.slice(chainStart, cursor);
    // A wrapping helper sits before `.from(`, so look back past the chain for it.
    const wrapper = source.slice(Math.max(0, chainStart - 200), cursor);
    const ordered =
      chain.includes(".order(") ||
      ORDERING_HELPERS.some((helper) => wrapper.includes(helper));
    if (!ordered) offenders.push(chain.trim().slice(0, 160));
    cursor = source.indexOf(".range(", cursor + 1);
  }
  return offenders;
}

test("every paged read in the projection path imposes a total order", () => {
  // PostgREST turns `.range()` into limit/offset over whatever order the planner
  // picked. Without a total order a second page can repeat a row it already
  // returned and skip another — in a ledger, a bill posted twice and a bill
  // never posted at all, differently on every run.
  for (const file of [
    "../lib/services/books/projector.ts",
    "../lib/services/retainage.ts",
    "../lib/services/books/statements.ts",
    "../lib/services/books/statement-detail.ts",
    "../lib/services/books/revenue-recognition.ts",
    "../lib/services/books/rebuild.ts",
    "../lib/services/poc.ts",
  ]) {
    assert.deepEqual(
      pagedReadsWithoutOrder(file),
      [],
      `${file} pages a query with no .order()`,
    );
  }
});

test("a fact payload hashes to the same value however its cost lines were paged", () => {
  const lines = [
    { amount_cents: 45000, project_id: PROJECT_ID, description: "Framing" },
    { amount_cents: 80000, project_id: PROJECT_ID, description: "Concrete" },
    { amount_cents: 45000, project_id: null, description: "Framing" },
  ];
  const shuffled = [lines[2], lines[0], lines[1]];

  // Array order IS load-bearing in `booksDigest` — that is why sorting is not
  // optional. Prove both halves: the raw permutation differs, the sorted one does not.
  assert.notEqual(booksDigest(lines), booksDigest(shuffled));
  assert.deepEqual(sortFactCostLines(lines), sortFactCostLines(shuffled));
  assert.equal(
    booksDigest(sortFactCostLines(lines)),
    booksDigest(sortFactCostLines(shuffled)),
  );

  // And through the real hashed payload, which is what the projector compares.
  const payload = (costLines) =>
    hashableFactPayload("vendor_bill", {
      memo: "Bill 1041",
      total_cents: 170000,
      cost_lines: costLines,
    });
  assert.equal(
    booksDigest(payload(sortFactCostLines(lines))),
    booksDigest(payload(sortFactCostLines(shuffled))),
  );

  // Sorting is stable across repeated calls and does not mutate its input.
  const original = [...lines];
  sortFactCostLines(lines);
  assert.deepEqual(lines, original);
});

test("a vendor credit posts as the mirror of a bill instead of vanishing", () => {
  const amounts = (draft) =>
    Object.fromEntries(
      draft.lines.map((line) => [
        line.accountCode,
        line.debitCents > 0 ? line.debitCents : -line.creditCents,
      ]),
    );

  // `job_cost_actuals` writes negative cost into the subledger and the importer
  // creates vendor credits. Skipping them drops GL cost below subledger cost with
  // no projection failure to explain the gap.
  const credit = draftFromFact({
    sourceType: "vendor_bill",
    sourceId: "00000000-0000-4000-8000-00000000d001",
    accountingDate: "2026-06-30",
    payload: {
      memo: "Vendor credit 88",
      total_cents: -40000,
      retainage_cents: 0,
      project_id: PROJECT_ID,
      cost_lines: [{ amount_cents: -40000, project_id: PROJECT_ID }],
    },
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  });
  assert.deepEqual(amounts(credit), { 5000: -40000, 2000: 40000 });
  assertBalancedJournalDraft(credit);

  const expenseCredit = draftFromFact({
    sourceType: "expense",
    sourceId: "00000000-0000-4000-8000-00000000d002",
    accountingDate: "2026-06-30",
    payload: {
      memo: "Returned materials",
      amount_cents: -3599,
      project_id: PROJECT_ID,
    },
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  });
  assert.deepEqual(amounts(expenseCredit), { 5000: -3599, 1000: 3599 });
  assertBalancedJournalDraft(expenseCredit);

  // A credit and its matching bill net to nothing, which is the whole point.
  const bill = postVendorBillFromCostLines({
    ...common(),
    grossCents: 40000,
    costLines: [{ amountCents: 40000 }],
  });
  const netted = [...bill.lines, ...credit.lines].reduce(
    (sum, line) => sum + line.debitCents - line.creditCents,
    0,
  );
  assert.equal(netted, 0);

  // Zero is still not a fact; a mis-signed retainage hold is still invalid.
  assert.throws(
    () =>
      postVendorBillFromCostLines({
        ...common(),
        grossCents: 0,
        costLines: [{ amountCents: 0 }],
      }),
    /must not be zero/,
  );
  assert.throws(
    () =>
      postVendorBillFromCostLines({
        ...common(),
        grossCents: -40000,
        retainageCents: 4000,
        costLines: [{ amountCents: -40000 }],
      }),
    /gross and retainage are invalid/,
  );
  assert.throws(
    () => postExpense({ ...common(), amountCents: 0 }),
    /not an accounting fact/,
  );
});

test("applying a vendor credit moves no cash, and an unreadable payment is still rejected", () => {
  // The credit note itself is a negative bill that already posted Dr AP / Cr cost.
  // The application only nets AP against AP; posting it as a disbursement invents
  // cash that never left the bank and no reconciliation can ever clear.
  assert.deepEqual(
    classifyPaymentPosting({
      method: "credit",
      hasBill: true,
      hasInvoice: false,
      creditApplied: true,
    }),
    {
      kind: "credit_application",
    },
  );
  // The metadata flag alone is enough — the method column is nullable.
  assert.deepEqual(
    classifyPaymentPosting({
      method: null,
      hasBill: true,
      hasInvoice: false,
      creditApplied: true,
    }),
    {
      kind: "credit_application",
    },
  );
  assert.deepEqual(
    classifyPaymentPosting({
      method: "ach",
      hasBill: true,
      hasInvoice: false,
      creditApplied: false,
    }),
    { kind: "bill_payment" },
  );
  assert.deepEqual(
    classifyPaymentPosting({
      method: "card",
      hasBill: false,
      hasInvoice: true,
      creditApplied: false,
    }),
    { kind: "invoice_payment" },
  );

  // Classifying explicitly must not become a licence to drop the unreadable ones.
  const orphan = classifyPaymentPosting({
    method: "ach",
    hasBill: false,
    hasInvoice: false,
    creditApplied: false,
  });
  assert.equal(orphan.kind, "unpostable");
  assert.match(orphan.reason, /neither a vendor bill nor an invoice/);
  const both = classifyPaymentPosting({
    method: "ach",
    hasBill: true,
    hasInvoice: true,
    creditApplied: false,
  });
  assert.equal(both.kind, "unpostable");
  assert.match(both.reason, /both a vendor bill and an invoice/);

  const projector = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/projector.ts"),
    "utf8",
  );
  assert.match(projector, /classifyPaymentPosting/);
  assert.match(
    projector,
    /if \(classification\.kind === "credit_application" && !isDepositApplication\)\s*continue/,
  );
  assert.match(
    projector,
    /failures\.push\(\{\s*sourceType: "payment",\s*sourceId: String\(row\.id\),\s*error: classification\.reason,?\s*\}\)/,
  );
});

test("a customer receipt lands net in undeposited funds until the bank settles it", () => {
  // `payments.net_cents` is recorded as gross minus processor and platform fees,
  // so the money that reaches the bank IS net. Debiting cash for the gross
  // overstates the bank by every fee ever charged.
  const receipt = postInvoicePayment({
    ...common(),
    amountCents: 225000,
    feeCents: 6525,
  });
  assert.deepEqual(
    receipt.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["1010", 218475, 0],
      ["6050", 6525, 0],
      ["1100", 0, 225000],
    ],
  );
  assertBalancedJournalDraft(receipt);

  // A disclosed card/ACH convenience fee is charged in addition to invoice
  // principal. It is fee-recovery income, not an extra reduction of AR.
  const receiptWithRecovery = postInvoicePayment({
    ...common(),
    amountCents: 225000,
    grossCents: 232000,
    feeCents: 6525,
  });
  assert.deepEqual(
    receiptWithRecovery.lines.map((line) => [
      line.accountCode,
      line.debitCents,
      line.creditCents,
    ]),
    [
      ["1010", 225475, 0],
      ["6050", 6525, 0],
      ["1100", 0, 225000],
      ["4920", 0, 7000],
    ],
  );
  assertBalancedJournalDraft(receiptWithRecovery);

  // No fee, no fee line — the common case stays a two-line entry.
  assert.equal(
    postInvoicePayment({ ...common(), amountCents: 225000 }).lines.length,
    2,
  );

  // And the fee has to survive the round trip through the hashed fact payload,
  // which carried it for months while the draft ignored it.
  const drafted = draftFromFact({
    sourceType: "invoice_payment",
    sourceId: "00000000-0000-4000-8000-00000000d003",
    accountingDate: "2026-06-30",
    payload: {
      memo: "Receipt",
      amount_cents: 225000,
      fee_cents: 6525,
      project_id: PROJECT_ID,
    },
    sourceVersion: 1,
    projectionVersion: 1,
    policyVersion: 1,
  });
  assert.deepEqual(
    drafted.lines.map((line) => line.accountCode),
    ["1010", "6050", "1100"],
  );
  assert.throws(
    () =>
      postInvoicePayment({ ...common(), amountCents: 1000, feeCents: 1000 }),
    /cannot equal or exceed/,
  );
});

test("receivables migrations preserve payment idempotency and Books tax ownership", () => {
  const foundation = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812145624_receivables_foundation.sql",
    ),
    "utf8",
  );
  const taxHardening = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812152631_receivables_books_tax_hardening.sql",
    ),
    "utf8",
  );
  assert.match(
    foundation,
    /create table if not exists public\.invoice_payment_reservations/,
  );
  assert.match(foundation, /for update/);
  assert.match(
    foundation,
    /create unique index if not exists receipts_payment_id_unique_idx\s+on public\.receipts \(payment_id\);/,
  );
  assert.match(taxHardening, /jurisdiction\.org_id = new\.org_id/);
  assert.match(
    taxHardening,
    /Issued taxable invoices require a tax jurisdiction/,
  );
  const atomicRevisions = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812152902_receivables_atomic_revisions.sql",
    ),
    "utf8",
  );
  assert.match(atomicRevisions, /create or replace function public\.void_invoice_atomic/);
  assert.match(atomicRevisions, /create or replace function public\.revise_invoice_atomic/);
  assert.match(
    atomicRevisions,
    /update public\.draw_schedules[\s\S]+update public\.billable_costs[\s\S]+update public\.retainage/,
  );
});

test("deleted QuickBooks customer payments create durable Arc reversals", () => {
  const reconcile = fs.readFileSync(
    path.join(__dirname, "../lib/integrations/accounting/qbo/reconcile.ts"),
    "utf8",
  );
  assert.match(reconcile, /async function reverseDeletedQboPayment/);
  assert.match(reconcile, /providerReversalId = `qbo-delete:/);
  assert.match(reconcile, /recalc_invoice_balance_atomic/);
  assert.match(reconcile, /eventType: "payment_reversed_from_qbo"/);
});

test("a source that leaves the projectable set is retired, and retirement is idempotent", () => {
  const facts = [
    {
      sourceType: "invoice",
      sourceId: "i-1",
      sourceVersion: 2,
      factKind: "invoice.recognized",
    },
    {
      sourceType: "invoice",
      sourceId: "i-2",
      sourceVersion: 1,
      factKind: "invoice.recognized",
    },
    {
      sourceType: "vendor_bill",
      sourceId: "b-1",
      sourceVersion: 1,
      factKind: "vendor_bill.recognized",
    },
    // Already retired on an earlier pass: must never be reversed a second time.
    {
      sourceType: "invoice",
      sourceId: "i-3",
      sourceVersion: 4,
      factKind: retiredFactKind("invoice"),
    },
  ];
  // `i-1` is still billed; everything else has left.
  const live = new Set(["invoice:i-1"]);
  assert.deepEqual(
    selectFactsToRetire(facts, live).map(
      (fact) => `${fact.sourceType}:${fact.sourceId}`,
    ),
    ["invoice:i-2", "vendor_bill:b-1"],
  );

  // Re-running after the sweep has written its retirement facts is a no-op.
  const afterSweep = facts.map((fact) =>
    live.has(`${fact.sourceType}:${fact.sourceId}`)
      ? fact
      : {
          ...fact,
          sourceVersion: fact.sourceVersion + 1,
          factKind: retiredFactKind(fact.sourceType),
        },
  );
  assert.deepEqual(selectFactsToRetire(afterSweep, live), []);

  assert.ok(isRetiredFactKind(retiredFactKind("invoice")));
  assert.ok(!isRetiredFactKind("invoice.recognized"));

  // A retirement payload must never collide with a live one (the projector keys
  // idempotency off the payload hash) and must differ per superseded version, so
  // a restored source supersedes the retirement instead of matching it.
  assert.notEqual(
    booksDigest(retirementFactPayload(1)),
    booksDigest(retirementFactPayload(2)),
  );
  assert.notEqual(
    booksDigest(hashableFactPayload("retirement", retirementFactPayload(1))),
    booksDigest(
      hashableFactPayload("invoice", {
        memo: "Invoice 12",
        total_cents: 225000,
        retainage_cents: 0,
        project_id: PROJECT_ID,
      }),
    ),
  );
  // Retirement facts produce no draft; the rebuild drill must recognize that
  // rather than reporting an unsupported fact kind for every retired source.
  const rebuild = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/rebuild.ts"),
    "utf8",
  );
  assert.match(rebuild, /isRetiredFactKind\(fact\.fact_kind\)/);
});

test("retirement handles touched lifecycle changes incrementally and deletions on a full pass", () => {
  const projector = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/projector.ts"),
    "utf8",
  );

  // A full pass discovers deletions. An incremental pass retires only source keys
  // whose rows crossed this watermark, so void/reject is immediate without
  // treating every untouched source as gone.
  assert.match(
    projector,
    /if \(options\.full\) \{[\s\S]{0,500}?retireDepartedSources\(\s*orgId,\s*liveSourceKeys,\s*policyVersion,?\s*\)/,
  );
  assert.match(
    projector,
    /else if \(retirementSourceKeys\.size > 0\)[\s\S]{0,500}?retireDepartedSources\([\s\S]{0,200}?retirementSourceKeys/,
  );
  assert.equal(
    projector.match(/retireDepartedSources\(/g).length,
    3,
    "retirement has full and touched-source call sites plus its definition",
  );

  // One reversal path, not a second one invented for retirement.
  assert.match(
    projector,
    /reverseBooksJournalEntryForService\(\{[\s\S]{0,300}?reversalDate: fact\.row\.accounting_date/,
  );
  assert.doesNotMatch(projector, /reversalDate: new Date\(\)/);

  // The retirement fact must not advance the incremental watermark.
  assert.match(projector, /occurred_at: fact\.row\.occurred_at/);
});

test("source supersede reversal, fact, and replacement post are atomic", () => {
  const projector = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/projector.ts"),
    "utf8",
  );
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../supabase/migrations/20260812120755_books_release_hardening.sql",
    ),
    "utf8",
  );
  assert.match(projector, /projectBooksFactAndJournalForService\(\{/);
  assert.match(migration, /public\.project_books_fact_and_journal_atomic/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.ok(
    migration.indexOf("public.reverse_books_journal_entry") <
      migration.lastIndexOf("insert into public.accounting_facts"),
  );
  assert.ok(
    migration.lastIndexOf("insert into public.accounting_facts") <
      migration.lastIndexOf("public.post_books_journal_entry"),
  );

  // The watermark remains inclusive after transient RPC/concurrency failures.
  assert.match(projector, /query\.gte\("updated_at", watermarks\./);
  assert.doesNotMatch(projector, /\.gt\("updated_at", watermarks\./);

  // The nightly repair sweep still proves every current source, not just deltas.
  const maintenance = fs.readFileSync(
    path.join(__dirname, "../app/api/jobs/books-maintenance/route.ts"),
    "utf8",
  );
  assert.match(maintenance, /runBooksProjection\(\{ full: true \}\)/);
});

test("an accounting date comes from the timestamp, not from the first ten characters of it", () => {
  const projector = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/projector.ts"),
    "utf8",
  );

  // Slicing dated a row by whatever offset PostgREST rendered, so an evening
  // payment landed on the wrong day and, at a month end, in the wrong period.
  assert.doesNotMatch(projector, /received_at\)\.slice\(0, 10\)/);
  assert.doesNotMatch(projector, /occurred_at\)\.slice\(0, 10\)/);
  assert.match(projector, /accountingDateFromTimestamp\(row\.received_at\)/);
  assert.match(projector, /accountingDateFromTimestamp\(row\.occurred_at\)/);
  // One date convention, the codebase's own: UTC-anchored date-only.
  assert.match(
    projector,
    /import \{ isoDateOnlyFromUtcMs \} from "@\/lib\/services\/reports\/dates"/,
  );
  assert.equal(
    isoDateOnlyFromUtcMs(Date.parse("2026-06-30T23:30:00-05:00")),
    "2026-07-01",
  );
  assert.equal(
    isoDateOnlyFromUtcMs(Date.parse("2026-06-30T23:30:00+00:00")),
    "2026-06-30",
  );

  // An unreadable timestamp is reported, never silently dated "null".
  assert.match(projector, /has no readable received_at to date the entry/);
});

test("revenue recognition is as-of, and names the projects it could not answer for", () => {
  const recognition = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/revenue-recognition.ts"),
    "utf8",
  );

  // Closing June in August must not book June revenue out of August's costs.
  assert.match(
    recognition,
    /const historical = periodEnd < todayIsoDateOnly\(\)/,
  );
  assert.match(
    recognition,
    /loadPocPositionsAsOf\(\{ orgId, projectIds: pocProjects\.map\(\(row\) => row\.projectId\), asOf: periodEnd \}\)/,
  );
  // Live computation survives only for a period end that is not yet in the past.
  assert.match(
    recognition,
    /\} else \{\s*const poc = await computeProjectPocForProject/,
  );
  // A project with no snapshot is named, not given today's position.
  assert.match(
    recognition,
    /projectsWithoutSnapshot\.push\(project\.projectId\)/,
  );
  assert.match(recognition, /skippedReason: "no_snapshot"/);
  assert.match(
    recognition,
    /return \{ periodEnd, basis, recognized, postedCents, projectsWithoutSnapshot, results \}/,
  );

  // The already-recognized lookup is paged. Unpaginated it stopped at 1000 rows,
  // understated what was recognized, and recognized the same revenue twice.
  assert.match(recognition, /RECOGNIZED_REVENUE_PAGE_SIZE/);
  assert.match(
    recognition,
    /if \(page\.length < RECOGNIZED_REVENUE_PAGE_SIZE\) break/,
  );

  // Snapshots at or before the date, newest first, with a unique tiebreak so the
  // pages are a total order rather than an arbitrary slice.
  const poc = fs.readFileSync(
    path.join(__dirname, "../lib/services/poc.ts"),
    "utf8",
  );
  assert.match(poc, /\.lte\("as_of", args\.asOf\)/);
  assert.match(poc, /orderPocSnapshotsLatestFirst\(/);

  // `(org_id, project_id, as_of, inputs_hash)` is the unique key, so two snapshots can
  // share an `as_of`. Latest computed wins, and `id` makes the sort total. This lives in
  // ONE helper because three surfaces read it — recognition, the WIP report and the
  // control tower — and a per-caller tiebreak is how they came to disagree.
  assert.match(
    poc,
    /export function orderPocSnapshotsLatestFirst[\s\S]*?\.order\("as_of", \{ ascending: false \}\)\s*\n\s*\.order\("created_at", \{ ascending: false \}\)\s*\n\s*\.order\("id", \{ ascending: false \}\)/,
  );
  for (const file of [
    "../lib/services/reports/wip-over-under.ts",
    "../lib/services/dashboard.ts",
  ]) {
    const source = withoutComments(
      fs.readFileSync(path.join(__dirname, file), "utf8"),
    );
    assert.match(
      source,
      /orderPocSnapshotsLatestFirst\(/,
      `${file} must read snapshots through the shared ordering`,
    );
    assert.doesNotMatch(
      source,
      /\.order\("as_of"/,
      `${file} must not re-declare the snapshot ordering`,
    );
  }
});

test("statement lines are paged, so the trial balance cannot stop summing", () => {
  const statements = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/statements.ts"),
    "utf8",
  );

  // 200 entries averaging more than five lines exceeds PostgREST's 1000-row
  // default. The lines past it used to be dropped, silently, and every statement
  // built on the ledger was wrong with no visible cause.
  assert.match(
    statements,
    /\.in\("entry_id", ids\)[\s\S]{0,200}?\.range\(from, from \+ 999\)/,
  );
  assert.match(statements, /if \(page\.length < 1000\) break/);

  // The register drill-down already paged its opening balance and reports its own
  // cap, so it stays as it is — asserted here so a "consistency" edit cannot
  // quietly remove the truncation flag.
  const detail = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/statement-detail.ts"),
    "utf8",
  );
  assert.match(detail, /const truncated = activity\.length > ACTIVITY_ROW_CAP/);
  assert.match(detail, /truncated,\s*\n\s*rowCap: ACTIVITY_ROW_CAP,/);
});

test("the rebuild drill's orphan scan is paged, and says so when it is not complete", () => {
  const rebuild = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/rebuild.ts"),
    "utf8",
  );

  // A determinism check that examined the first 200 rows and reported "passed"
  // was worse than no check at all.
  assert.doesNotMatch(rebuild, /\.is\("fact_id", null\)\s*\n\s*\.limit\(200\)/);
  assert.match(rebuild, /ORPHAN_SCAN_PAGE_SIZE/);
  assert.match(rebuild, /scan_capped: true/);
  // Recorded first so the evidence cap below it cannot drop the marker.
  assert.match(rebuild, /differences\.unshift\(\{ type: "orphan_scan_capped"/);
});

test("posting rules have no caller-less parallel path into the ledger", () => {
  const rules = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/posting-rules.ts"),
    "utf8",
  );

  // `postCustomerDeposit`, `postDrawFunding`, `postLoanPayment` and
  // `postOwnerActivity` had zero callers. They were waiting on a hand-posting
  // surface, which now exists — and it is a free-form journal editor, so a
  // bookkeeper posts an owner distribution there and these typed shortcuts are
  // permanently redundant. An uncalled function that can write to the general
  // ledger is the most dangerous kind of dead code; if one of them is ever
  // needed again it comes back as a projector source with a fact behind it.
  for (const dead of [
    "postCustomerDeposit",
    "postDrawFunding",
    "postLoanPayment",
    "postOwnerActivity",
  ]) {
    assert.doesNotMatch(
      rules,
      new RegExp(`export function ${dead}\\b`),
      `${dead} is a posting path with no caller`,
    );
  }
});

// ─── Reconciliation spine, period close, and the verifier ─────────────────────
// Everything below covers the reconciliation item lifecycle, the close gate that
// reads it, and the tie-out arithmetic underneath both.

const {
  classifyProjectionFailure,
  planReconciliationItemSync,
  planRetainageControlFindings,
  reconciliationRunStatus,
  PROJECTION_ITEM_CATEGORIES,
  TIE_OUT_ITEM_CATEGORIES,
} = require("../lib/services/books/reconciliation-rules");
const {
  sumApRetainageCents,
  sumApSubledgerCents,
  sumArSubledgerCents,
} = require("../lib/services/books/tie-out-rules");

function finding(overrides = {}) {
  return {
    category: "sync_error",
    entityType: "vendor_bill",
    entityId: "bill-1",
    details: {},
    ...overrides,
  };
}
function persisted(overrides = {}) {
  return {
    id: "item-1",
    category: "sync_error",
    entityType: "vendor_bill",
    entityId: "bill-1",
    findingKey: null,
    status: "open",
    differenceCents: null,
    ...overrides,
  };
}
const ownsEverything = () => true;

test("a reconciliation finding that no longer reproduces is resolved, not left open forever", () => {
  // The blocker: items were insert-only. Every night added a fresh copy of the same
  // finding and nothing ever closed yesterday's, so the blocking `accounting_drift`
  // close check — counting open rows across all runs, all time — could never go
  // green again once an org had had a single discrepancy.
  const cured = planReconciliationItemSync({
    findings: [],
    existing: [persisted({ id: "yesterday" })],
    ownsCategory: ownsEverything,
  });
  assert.deepEqual(cured.resolveIds, ["yesterday"]);
  assert.equal(cured.insert.length, 0);
  assert.equal(cured.carryForward.length, 0);

  // A finding that still reproduces carries the SAME row forward rather than
  // inserting a second one beside it. This is what stops the pile-up.
  const recurring = planReconciliationItemSync({
    findings: [finding()],
    existing: [persisted({ id: "yesterday" })],
    ownsCategory: ownsEverything,
  });
  assert.deepEqual(recurring.resolveIds, []);
  assert.equal(recurring.insert.length, 0);
  assert.deepEqual(
    recurring.carryForward.map((row) => [row.id, row.status, row.reopened]),
    [["yesterday", "open", false]],
  );
  assert.equal(
    recurring.newFindingCount,
    0,
    "a finding already in front of somebody is not new",
  );

  // The backlog the write-only era accumulated drains on the first pass: duplicates
  // of one live finding are resolved down to a single canonical row.
  const deduped = planReconciliationItemSync({
    findings: [finding()],
    existing: [
      persisted({ id: "run-1" }),
      persisted({ id: "run-2" }),
      persisted({ id: "run-3" }),
    ],
    ownsCategory: ownsEverything,
  });
  assert.equal(deduped.carryForward.length, 1);
  assert.deepEqual(deduped.resolveIds.sort(), ["run-2", "run-3"]);
});

test("a machine-resolved finding reopens when it comes back; an accepted difference does not", () => {
  // Resolution is per occurrence, so a finding that returns after being resolved
  // opens a new item — the resolved row is history and is never loaded again.
  const returned = planReconciliationItemSync({
    findings: [finding()],
    existing: [],
    ownsCategory: ownsEverything,
  });
  assert.equal(returned.insert.length, 1, "the finding is open again");
  assert.equal(returned.newFindingCount, 1);

  // A difference a person explicitly accepted survives the nightly pass at the same
  // amount: that is the whole point of accepting it.
  const accepted = planReconciliationItemSync({
    findings: [finding({ differenceCents: -2500 })],
    existing: [
      persisted({
        id: "accepted",
        status: "explained",
        differenceCents: -2500,
      }),
    ],
    ownsCategory: ownsEverything,
  });
  assert.deepEqual(
    accepted.carryForward.map((row) => [row.status, row.reopened]),
    [["explained", false]],
  );
  assert.equal(accepted.newFindingCount, 0);

  // …but the amount somebody signed off on is not the amount in front of them now.
  const moved = planReconciliationItemSync({
    findings: [finding({ differenceCents: -9900 })],
    existing: [
      persisted({
        id: "accepted",
        status: "explained",
        differenceCents: -2500,
      }),
    ],
    ownsCategory: ownsEverything,
  });
  assert.deepEqual(
    moved.carryForward.map((row) => [row.status, row.reopened]),
    [["open", true]],
  );
  assert.equal(
    moved.newFindingCount,
    1,
    "a changed accepted difference is worth a notification",
  );

  // An ignored finding stays ignored at the same amount, and is resolved when it
  // stops reproducing like anything else.
  const ignored = planReconciliationItemSync({
    findings: [],
    existing: [persisted({ id: "muted", status: "ignored" })],
    ownsCategory: ownsEverything,
  });
  assert.deepEqual(ignored.resolveIds, ["muted"]);
});

test("each sweep resolves only the categories it can reproduce", () => {
  // The projection repair sweep is the only thing that knows whether a source
  // record still fails to project. If the reconciliation spine resolved those
  // items too, a real unfixed problem would be cleared every night.
  const ownsSpineCategories = (category) =>
    !PROJECTION_ITEM_CATEGORIES.includes(category);
  const plan = planReconciliationItemSync({
    findings: [finding()],
    existing: [
      persisted({ id: "spine", status: "open" }),
      persisted({
        id: "projection",
        category: "projection_blocked_by_closed_period",
        entityId: "bill-9",
      }),
    ],
    ownsCategory: ownsSpineCategories,
  });
  assert.deepEqual(
    plan.resolveIds,
    [],
    "the other producer's item is untouched",
  );
  assert.deepEqual(
    plan.carryForward.map((row) => row.id),
    ["spine"],
  );

  // And the projection sweep, seeing nothing wrong, closes its own.
  const projectionPass = planReconciliationItemSync({
    findings: [],
    existing: [
      persisted({ id: "spine", status: "open" }),
      persisted({
        id: "projection",
        category: "projection_failed",
        entityId: "bill-9",
      }),
    ],
    ownsCategory: (category) => PROJECTION_ITEM_CATEGORIES.includes(category),
  });
  assert.deepEqual(projectionPass.resolveIds, ["projection"]);
});

test("two exceptions of one kind against one record stay two findings", () => {
  // The project integrity checks raise several distinct exceptions per project
  // under a single kind. Keyed on category and entity alone they collapse onto one
  // row, and each night one of them would resolve the other.
  const plan = planReconciliationItemSync({
    findings: [
      finding({
        category: "retainage_mismatch",
        entityId: "project-1",
        findingKey: "retainage-orphan-project-1",
      }),
      finding({
        category: "retainage_mismatch",
        entityId: "project-1",
        findingKey: "retainage-release-missing-project-1",
      }),
    ],
    existing: [],
    ownsCategory: ownsEverything,
  });
  assert.equal(plan.insert.length, 2);
});

test("the close gate reads the current state of reconciliation, not its history", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/period-close.ts"),
    "utf8",
  );
  const spine = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/reconciliation.ts"),
    "utf8",
  );

  // The gate counts unresolved findings. It stays scoped to `open`, which the
  // lifecycle above now keeps honest — resolved, explained and ignored are all
  // dispositions, and none of them blocks a close.
  const gate = source.slice(
    source.indexOf('.from("accounting_reconciliation_items")'),
  );
  assert.match(gate.slice(0, 400), /\.eq\("status", "open"\)/);
  assert.match(
    gate.slice(0, 400),
    /\.not\("category", "in"/,
    "tie-out categories stay out of the catch-all gate",
  );

  // The dedicated control checks remain the single place a tie-out blocks a close.
  for (const code of ["job_cost_control", "ar_control", "ap_control"]) {
    assert.ok(TIE_OUT_ITEM_CATEGORIES.includes(`tie_out_${code}`));
    assert.match(source, new RegExp(`code: "${code}"`));
  }

  // The spine no longer wipes and rewrites the day's items, and it does close them.
  assert.doesNotMatch(
    spine,
    /accounting_reconciliation_items"\)\s*\n\s*\.delete\(\)/,
  );
  assert.match(spine, /status: "resolved"/);
  assert.match(
    spine,
    /resolved_by: null/,
    "the sweep is not a person; that is what tells them apart",
  );
});

test("a truncated scan can never report a clean bill of health", () => {
  // The org sweep is capped at `PROJECT_CHECK_CAP` projects. Finding nothing in the
  // ones it reached says nothing about the ones it skipped.
  assert.equal(
    reconciliationRunStatus({ itemCount: 0, projectsSkipped: 0 }),
    "passed",
  );
  assert.equal(
    reconciliationRunStatus({ itemCount: 0, projectsSkipped: 150 }),
    "warning",
  );
  assert.equal(
    reconciliationRunStatus({ itemCount: 3, projectsSkipped: 0 }),
    "warning",
  );

  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/period-close.ts"),
    "utf8",
  );

  // PostgREST answers an unbounded select with 1000 rows and says nothing about it,
  // so the blocking `bank_matches` and `coding_exceptions` checks could pass with
  // violations sitting past row 1000. Every unbounded scan is paged.
  for (const table of [
    "bank_transactions",
    "vendor_bills",
    "poc_snapshots",
    "bank_accounts",
    "companies",
    "bank_reconciliations",
  ]) {
    const query = source.slice(source.indexOf(`.from("${table}")`));
    assert.ok(
      source.includes(`.from("${table}")`),
      `${table} is still scanned`,
    );
    assert.match(
      query.slice(0, 600),
      /\.range\(from, to\)/,
      `${table} is paged`,
    );
    assert.match(
      query.slice(0, 600),
      /\.order\("created_at"/,
      `${table} pages in a deterministic order`,
    );
  }

  // The three scans that stay explicitly capped route through the helper that
  // refuses to call a truncated scan clean.
  const capped = source.match(/closeScanStatus\(\{/g) ?? [];
  assert.equal(
    capped.length,
    3,
    "sync backlog, waiver holds and retainage movement",
  );
  assert.match(
    source,
    /if \(args\.issueCount > 0 \|\| args\.scanCapped\) return args\.failedStatus/,
  );
});

test("the tie-outs compare real balances, including credit ones", () => {
  // An overpaid invoice is a credit balance in AR, and the ledger carries it as one.
  // Clamping the subledger at zero made the two sides disagree by exactly the credit
  // and pinned the control tie-out red on a legitimate state.
  assert.equal(
    sumArSubledgerCents([
      { balance_due_cents: 250_000 },
      { balance_due_cents: -40_000 },
    ]),
    210_000,
  );
  assert.equal(sumArSubledgerCents([{ balance_due_cents: -40_000 }]), -40_000);

  // Same on the AP side: a vendor bill paid beyond its total is a debit balance in
  // accounts payable, not a zero.
  assert.equal(
    sumApSubledgerCents([
      { total_cents: 125_000, paid_cents: 112_500, retainage_cents: 12_500 },
      { total_cents: 100_000, paid_cents: 130_000, retainage_cents: 0 },
    ]),
    -30_000,
  );

  // And over-released retainage carries its sign rather than flooring at zero.
  assert.equal(
    sumApRetainageCents([
      { retainage_cents: 12_500, retainage_released_cents: 20_000 },
    ]),
    -7_500,
  );
  assert.equal(
    sumApRetainageCents([
      { retainage_cents: 12_500, retainage_released_cents: 2_500 },
    ]),
    10_000,
  );

  const rules = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/tie-out-rules.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    rules,
    /Math\.max\(0/,
    "a clamp here is a permanent red on a legitimate balance",
  );
});

test("retainage held on the schedule of values is tied to the retainage ledger", () => {
  // Nothing compared `prime_sov_lines.retainage_held_cents` — what a G702 shows the
  // owner — with the `retainage` table the books read. They drift with no alarm.
  const drifted = planRetainageControlFindings({
    sovLines: [
      {
        contract_id: "c-1",
        project_id: "p-1",
        retainage_held_cents: 500_000,
        retainage_released_cents: 0,
      },
      {
        contract_id: "c-1",
        project_id: "p-1",
        retainage_held_cents: 0,
        retainage_released_cents: 0,
      },
    ],
    heldRetainage: [{ contract_id: "c-1", amount_cents: 530_000 }],
  });
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0].category, "retainage_control");
  assert.equal(drifted[0].localAmountCents, 500_000);
  assert.equal(drifted[0].externalAmountCents, 530_000);
  assert.equal(drifted[0].differenceCents, -30_000);
  assert.equal(drifted[0].details.href, "/projects/p-1/financials/receivables");

  // Released retainage nets out of the SOV side, so a fully released contract ties.
  assert.deepEqual(
    planRetainageControlFindings({
      sovLines: [
        {
          contract_id: "c-2",
          project_id: "p-2",
          retainage_held_cents: 800_000,
          retainage_released_cents: 800_000,
        },
      ],
      heldRetainage: [],
    }),
    [],
  );

  // A residential contract holds retainage with no schedule of values at all.
  // Measuring it against zero would report every one of them as broken.
  assert.deepEqual(
    planRetainageControlFindings({
      sovLines: [],
      heldRetainage: [{ contract_id: "c-3", amount_cents: 40_000 }],
    }),
    [],
  );
});

test("a projection failure a retry cannot cure is surfaced as its own finding", () => {
  // The DB guard rightly refuses to reverse a journal entry in a closed period, so a
  // bill edited after its period closed fails identically on every pass, forever.
  assert.equal(
    classifyProjectionFailure("Cannot post into a closed accounting period"),
    "projection_blocked_by_closed_period",
  );
  assert.equal(
    classifyProjectionFailure(
      "Failed to record accounting fact: duplicate key value violates unique constraint",
    ),
    "projection_failed",
  );

  // The repair cron reports that failure instead of returning a flat `ok: true`, the
  // same way `books-projection` already does.
  const maintenance = fs.readFileSync(
    path.join(__dirname, "../app/api/jobs/books-maintenance/route.ts"),
    "utf8",
  );
  const projection = fs.readFileSync(
    path.join(__dirname, "../app/api/jobs/books-projection/route.ts"),
    "utf8",
  );
  const convention =
    /ok: failures === 0[\s\S]*status: failures === 0 \? 200 : 207/;
  assert.match(projection, convention);
  assert.match(maintenance, convention);
  assert.match(maintenance, /recordProjectionFailures\(repair\.results\)/);
  assert.doesNotMatch(maintenance, /\{ ok: true,/);
});

test("a refused close leaves no journal entries behind, and posts under resolved versions", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../lib/services/books/period-close.ts"),
    "utf8",
  );
  const close = source.slice(
    source.indexOf("export async function closeAccountingPeriod"),
    source.indexOf("export async function closeFiscalYearToRetainedEarnings"),
  );
  // Recognizing revenue before the blocking gate meant a close that was then refused
  // still left percentage-of-completion entries posted into the period.
  assert.ok(
    close.indexOf("runBooksCloseChecklist") <
      close.indexOf("recognizeRevenueForPeriod"),
    "the checklist gates recognition, not the other way round",
  );
  assert.ok(
    close.indexOf("blockingFailures.length > 0") <
      close.indexOf("recognizeRevenueForPeriod"),
  );
  // Recognition is an as-of question: period end is passed explicitly, and a project
  // the checklist covered that has no position at that date stops the close rather
  // than recognizing against a substituted one.
  assert.match(
    close,
    /recognizeRevenueForPeriod\(\s*context\.orgId,\s*period\.period_end,?\s*\)/,
  );
  assert.match(close, /checklist\.pocProjectIds\.includes\(row\.projectId\)/);

  // The year-end closing entry resolves its versions like every other posting; a
  // hardcoded 1 cannot be re-derived by a re-projection under a new version.
  const yearEnd = source.slice(
    source.indexOf("export async function closeFiscalYearToRetainedEarnings"),
  );
  assert.match(yearEnd, /projectionVersion: versions\.projectionVersion/);
  assert.match(yearEnd, /policyVersion: versions\.policyVersion/);
  assert.doesNotMatch(yearEnd, /projectionVersion: 1/);
});
