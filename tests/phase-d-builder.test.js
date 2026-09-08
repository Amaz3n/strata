const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const read = (file) => fs.readFileSync(path.resolve(__dirname, "..", file), "utf8")

test("payment runs are one detail route plus a desk sheet and approval band", () => {
  assert.match(read("app/(app)/payables/payment-runs/page.tsx"), /redirect\("\/payables"\)/)
  assert.match(read("components/payables/payables-desk.tsx"), /PaymentRunsSheet/)
  assert.match(read("components/payables/payables-desk.tsx"), /AwaitingRunApprovalBand/)
  const detail = read("app/(app)/payables/payment-runs/[id]/page.tsx")
  for (const stage of ["Submitted","Builder debited","Funds available","Transfer to vendor","Vendor paid"]) assert.match(read("lib/payments/disbursement-stage.ts"), new RegExp(stage))
  assert.match(detail, /Frozen payable evidence/)
  assert.match(detail, /Open reconciliation exception/)
  assert.match(detail, /AccountingSyncBadge/)
})

test("bulk workflows retain selection and report every outcome", () => {
  const desk = read("components/payables/payables-desk.tsx")
  const bills = read("lib/services/vendor-bills.ts")
  assert.doesNotMatch(desk, /sessionStorage/)
  assert.match(desk, /\[basePath, communityId\]/)
  assert.match(desk, /selected across pages/)
  assert.match(desk, /Select all matching filter/)
  assert.match(desk, /"skip_failures"/)
  assert.match(bills, /submitVendorBillsForApproval/)
  assert.match(bills, /approve_vendor_bills_with_outcomes/)
  assert.match(read("components/payables/bulk-outcome-list.tsx"), /Retry the ones that failed/)
  assert.match(read("components/payables/pay-batch-dialog.tsx"), /Vendor not set up/)
  assert.match(read("components/payables/pay-batch-dialog.tsx"), /Split into two runs/)
  assert.match(read("components/payables/pay-batch-dialog.tsx"), /Math\.ceil\(lines\.length \/ 200\)/)
  assert.match(read("components/payables/pay-batch-dialog.tsx"), /lines\.slice\(index \* 200, \(index \+ 1\) \* 200\)/)
  assert.equal(Math.ceil(300 / 200), 2)
})

test("payment-run surfaces expose empty, loading, error, and theme-safe states", () => {
  const sheet = read("components/payables/payment-runs-sheet.tsx")
  assert.match(sheet, /Loading payment runs/)
  assert.match(sheet, /No payment runs yet/)
  assert.match(sheet, /role="alert"/)
  assert.doesNotMatch(sheet, /bg-white|text-black|bg-black|text-white/)

  const band = read("components/payables/awaiting-run-approval-band.tsx")
  assert.match(band, /if \(runs\.length === 0\) return null/)
  assert.doesNotMatch(band, /bg-white|text-black|bg-black|text-white/)

  assert.match(read("app/(app)/payables/loading.tsx"), /Skeleton/)
  assert.match(read("app/(app)/payables/payment-runs/[id]/loading.tsx"), /Skeleton/)
  assert.match(read("app/(app)/payables/payment-runs/[id]/error.tsx"), /role="alert"/)
  const detail = read("app/(app)/payables/payment-runs/[id]/page.tsx")
  assert.match(detail, /No payment items/)
  assert.doesNotMatch(detail, /bg-white|text-black|bg-black|text-white/)
})

test("payment-run deep links no longer target the retired list query", () => {
  for (const file of ["lib/services/search-config.ts","lib/services/ai-search/config.ts","lib/services/notification-email-delivery.ts"]) {
    const source = read(file)
    assert.match(source, /\/payables\/payment-runs\//)
    assert.doesNotMatch(source, /\/payables\?run=/)
  }
})
