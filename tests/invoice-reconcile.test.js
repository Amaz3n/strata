require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  reconcileInvoice,
  toCents,
  RECONCILE_TOLERANCE_CENTS,
} = require("../lib/financials/invoice-reconcile")

// ---------------------------------------------------------------------------
// toCents — the unit conversion that used to be a guess
// ---------------------------------------------------------------------------

test("toCents converts printed decimal amounts to integer cents", () => {
  assert.equal(toCents(1234.56), 123456)
  assert.equal(toCents(42.75), 4275)
  assert.equal(toCents(0), 0)
  assert.equal(toCents(-150.25), -15025)
})

test("toCents reads a whole-dollar amount as dollars, not cents", () => {
  // The predecessor inferred the unit from whether a decimal point was present,
  // so an invoice total printed as "1234" was read as $12.34. Asking the model
  // for the printed decimal instead makes that error unrepresentable.
  assert.equal(toCents(1234), 123400)
  assert.equal(toCents(5), 500)
})

test("toCents rejects non-finite input rather than coercing it", () => {
  assert.equal(toCents(null), null)
  assert.equal(toCents(undefined), null)
  assert.equal(toCents(Number.NaN), null)
  assert.equal(toCents(Number.POSITIVE_INFINITY), null)
})

test("toCents rounds sub-cent precision instead of truncating", () => {
  assert.equal(toCents(10.005), 1001)
  assert.equal(toCents(10.004), 1000)
})

// ---------------------------------------------------------------------------
// reconcileInvoice — the gate that decides whether a read is trustworthy
// ---------------------------------------------------------------------------

const line = (amountCents, quantity = null, unitPriceCents = null) => ({
  amountCents,
  quantity,
  unitPriceCents,
})

test("a clean invoice whose lines sum to the total reconciles", () => {
  const result = reconcileInvoice({
    totalCents: 150000,
    subtotalCents: null,
    taxCents: null,
    lines: [line(100000), line(50000)],
  })
  assert.equal(result.ok, true)
  assert.equal(result.lineSumCents, 150000)
})

test("lines that do not sum to the total are rejected", () => {
  const result = reconcileInvoice({
    totalCents: 150000,
    subtotalCents: null,
    taxCents: null,
    lines: [line(100000), line(20000)],
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /1200\.00/)
  assert.match(result.message, /1500\.00/)
})

test("pre-tax line totals are accepted, because vendors print both conventions", () => {
  // Lines sum to 1000.00, tax 80.00, total 1080.00 — legitimate and common.
  const result = reconcileInvoice({
    totalCents: 108000,
    subtotalCents: null,
    taxCents: 8000,
    lines: [line(60000), line(40000)],
  })
  assert.equal(result.ok, true)
})

test("tax-inclusive line totals are also accepted", () => {
  const result = reconcileInvoice({
    totalCents: 108000,
    subtotalCents: null,
    taxCents: 8000,
    lines: [line(68000), line(40000)],
  })
  assert.equal(result.ok, true)
})

test("a line whose quantity times unit price contradicts its amount is rejected", () => {
  const result = reconcileInvoice({
    totalCents: 50000,
    subtotalCents: null,
    taxCents: null,
    // 10 x $10.00 should be $100.00, not $500.00.
    lines: [line(50000, 10, 1000)],
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /Line 1/)
})

test("per-line arithmetic is skipped when the vendor did not print quantity or unit price", () => {
  const result = reconcileInvoice({
    totalCents: 50000,
    subtotalCents: null,
    taxCents: null,
    lines: [line(50000, null, 1000), line(0, 10, null)],
  })
  assert.equal(result.ok, true)
})

test("subtotal plus tax must equal the total", () => {
  const result = reconcileInvoice({
    totalCents: 108000,
    subtotalCents: 100000,
    taxCents: 5000,
    lines: [],
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /Subtotal plus tax/)
})

test("the subtotal check runs even when no lines were extracted", () => {
  // A receipt has no line detail; this is the only claim there is to check.
  const result = reconcileInvoice({
    totalCents: 11000,
    subtotalCents: 10000,
    taxCents: 800,
    lines: [],
  })
  assert.equal(result.ok, false)
})

test("nothing to check passes: no lines and no printed total", () => {
  assert.equal(
    reconcileInvoice({ totalCents: null, subtotalCents: null, taxCents: null, lines: [] }).ok,
    true,
  )
  assert.equal(
    reconcileInvoice({ totalCents: null, subtotalCents: null, taxCents: null, lines: [line(500)] }).ok,
    true,
  )
})

test("rounding drift within tolerance is accepted, beyond it is not", () => {
  const within = reconcileInvoice({
    totalCents: 100000,
    subtotalCents: null,
    taxCents: null,
    lines: [line(100000 - RECONCILE_TOLERANCE_CENTS)],
  })
  assert.equal(within.ok, true)

  const beyond = reconcileInvoice({
    totalCents: 100000,
    subtotalCents: null,
    taxCents: null,
    lines: [line(100000 - RECONCILE_TOLERANCE_CENTS - 1)],
  })
  assert.equal(beyond.ok, false)
})

test("credit lines reduce the sum rather than being treated as charges", () => {
  const result = reconcileInvoice({
    totalCents: 90000,
    subtotalCents: null,
    taxCents: null,
    lines: [line(100000), line(-10000)],
  })
  assert.equal(result.ok, true)
  assert.equal(result.lineSumCents, 90000)
})

test("a 14-line invoice reconciles end to end", () => {
  // The shape the engine is expected to handle routinely.
  const lines = Array.from({ length: 14 }, (_, index) => line((index + 1) * 1000, index + 1, 1000))
  const total = lines.reduce((sum, entry) => sum + entry.amountCents, 0)
  const result = reconcileInvoice({
    totalCents: total,
    subtotalCents: null,
    taxCents: null,
    lines,
  })
  assert.equal(result.ok, true)
  assert.equal(result.lineSumCents, 105000)
})

// ---------------------------------------------------------------------------
// reconcilePayApplication — G702 footing rules
// ---------------------------------------------------------------------------

const { reconcilePayApplication } = require("../lib/financials/invoice-reconcile")

const payApp = (overrides) => ({
  previousCompletedCents: 5000000,
  thisPeriodCents: 2000000,
  materialsStoredCents: 0,
  totalCompletedStoredCents: 7000000,
  retainageCents: 700000,
  totalEarnedLessRetainageCents: 6300000,
  lessPreviousCertificatesCents: 4500000,
  currentPaymentDueCents: 1800000,
  ...overrides,
})

test("a correctly footed pay application reconciles", () => {
  assert.equal(reconcilePayApplication(payApp()).ok, true)
})

test("previous plus this period plus stored must equal total completed", () => {
  const result = reconcilePayApplication(payApp({ totalCompletedStoredCents: 9000000 }))
  assert.equal(result.ok, false)
  assert.match(result.message, /total completed and stored/)
})

test("total completed less retainage must equal total earned", () => {
  const result = reconcilePayApplication(payApp({ totalEarnedLessRetainageCents: 7000000 }))
  assert.equal(result.ok, false)
  assert.match(result.message, /retainage/)
})

test("the amount actually due must equal earned less previous certificates", () => {
  // The number that gets paid. An inflated draw is exactly what this catches.
  const result = reconcilePayApplication(payApp({ currentPaymentDueCents: 2500000 }))
  assert.equal(result.ok, false)
  assert.match(result.message, /current payment due/)
})

test("materials stored are included in the completed-work footing", () => {
  assert.equal(
    reconcilePayApplication(
      payApp({ materialsStoredCents: 500000, totalCompletedStoredCents: 7500000, retainageCents: 750000, totalEarnedLessRetainageCents: 6750000, currentPaymentDueCents: 2250000 }),
    ).ok,
    true,
  )
})

test("partially printed pay applications skip the checks they cannot make", () => {
  assert.equal(
    reconcilePayApplication({
      previousCompletedCents: null,
      thisPeriodCents: null,
      materialsStoredCents: null,
      totalCompletedStoredCents: null,
      retainageCents: null,
      totalEarnedLessRetainageCents: null,
      lessPreviousCertificatesCents: null,
      currentPaymentDueCents: 1800000,
    }).ok,
    true,
  )
})

// ---------------------------------------------------------------------------
// detectDuplicateSuspicion — one implementation replacing three that disagreed
// ---------------------------------------------------------------------------

const { detectDuplicateSuspicion } = require("../lib/financials/payable-duplicates")

const existing = [
  { billNumber: "INV-1024", companyId: "vendor-a", totalCents: 250000, billDate: "2026-06-01" },
]

test("bill-number matching ignores case and separators", () => {
  // The create path matched case-insensitively and email ingest did not, so the
  // same invoice was one bill on one path and two on the other.
  for (const candidate of ["INV-1024", "inv-1024", "INV 1024", "inv1024", " Inv-1024 "]) {
    assert.equal(
      detectDuplicateSuspicion({
        billNumber: candidate,
        companyId: "vendor-a",
        totalCents: 250000,
        billDate: "2026-06-01",
        recentBills: existing,
      }).isSuspected,
      true,
      `expected ${candidate} to be flagged`,
    )
  }
})

test("the same number from a different vendor is not a duplicate", () => {
  assert.equal(
    detectDuplicateSuspicion({
      billNumber: "INV-1024",
      companyId: "vendor-b",
      totalCents: 250000,
      billDate: "2026-06-01",
      recentBills: existing,
    }).isSuspected,
    false,
  )
})

test("an unknown vendor on either side does not rule out a duplicate", () => {
  assert.equal(
    detectDuplicateSuspicion({
      billNumber: "INV-1024",
      companyId: null,
      totalCents: 250000,
      billDate: "2026-06-01",
      recentBills: existing,
    }).isSuspected,
    true,
  )
})

test("a missing bill number falls back to vendor plus amount plus date", () => {
  // The extractor legitimately returns null for documents that print no number,
  // which is exactly the case number-matching cannot see.
  const result = detectDuplicateSuspicion({
    billNumber: null,
    companyId: "vendor-a",
    totalCents: 250000,
    billDate: "2026-06-01",
    recentBills: existing,
  })
  assert.equal(result.isSuspected, true)
  assert.match(result.reason, /same amount/)
})

test("the fallback does not fire on a different amount or date", () => {
  assert.equal(
    detectDuplicateSuspicion({
      billNumber: null, companyId: "vendor-a", totalCents: 250001,
      billDate: "2026-06-01", recentBills: existing,
    }).isSuspected,
    false,
  )
  assert.equal(
    detectDuplicateSuspicion({
      billNumber: null, companyId: "vendor-a", totalCents: 250000,
      billDate: "2026-06-02", recentBills: existing,
    }).isSuspected,
    false,
  )
})

test("a genuinely new bill is not flagged", () => {
  assert.equal(
    detectDuplicateSuspicion({
      billNumber: "INV-2048", companyId: "vendor-a", totalCents: 999900,
      billDate: "2026-07-01", recentBills: existing,
    }).isSuspected,
    false,
  )
})
