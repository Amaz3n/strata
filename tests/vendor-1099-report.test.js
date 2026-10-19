"use strict"

/**
 * The 1099-NEC vendor report (lib/services/reports/vendor-1099.ts) and its
 * payment rules (lib/services/reports/vendor-tax-payment-rules.ts): only cash
 * actually paid to a vendor in the tax year, on a reportable rail, net of
 * settled returns — never guessed from a bill's lifetime paid balance.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, ORG } = require("./support/service")
const { supportPostgrestFilters } = require("./support/billing")
const { freshRequire } = require("./support/modules")

const { reportableVendorReversal } = require("@/lib/services/reports/vendor-tax-payment-rules")
const { getVendor1099Report } = freshRequire("lib/services/reports/vendor-1099.ts")

test("a vendor reversal counts only once settled, inside the tax year, on a reportable rail", () => {
  const reversal = { status: "succeeded", occurredAt: "2026-12-31T23:59:59Z", paymentMethod: "ach", amountCents: 10000 }
  assert.equal(reportableVendorReversal(reversal, 2026), 10000)
  assert.equal(reportableVendorReversal({ ...reversal, status: "pending" }, 2026), 0)
  assert.equal(reportableVendorReversal({ ...reversal, occurredAt: "2027-01-01T00:00:00Z" }, 2026), 0)
  for (const method of ["credit_card", "company_card", "card", "credit", null]) {
    assert.equal(reportableVendorReversal({ ...reversal, paymentMethod: method }, 2026), 0, String(method))
  }
})

function report(permissions = ["books.read"]) {
  const vendor = { org_id: ORG, is_1099_eligible: true, tax_exempt: false, w9_file_id: "w9" }
  const bill = { company_id: "vendor" }
  const paid = { received_at: "2026-06-01T12:00:00Z", status: "succeeded", method: "ach" }
  const payment = (overrides) => ({ org_id: ORG, amount_cents: 100, bill, ...paid, ...overrides })
  const reversal = (overrides) => ({
    org_id: ORG,
    amount_cents: 100,
    status: "succeeded",
    occurred_at: "2026-09-01T12:00:00Z",
    payment: { method: "ach" },
    bill,
    ...overrides,
  })

  return supportPostgrestFilters(
    createServiceHarness({
      permissions,
      // PostgREST's row cap: the report must page past it.
      maxRows: 1000,
      tables: {
        tax_policy_versions: [{ org_id: ORG, tax_year: 2026, form_type: "1099-NEC", jurisdiction: "US", threshold_cents: 60000 }],
        companies: [
          { ...vendor, id: "vendor", name: "Trade" },
          { ...vendor, id: "legacy", name: "Legacy" },
        ],
        // 1,201 allocated payments of $1 — more than one page.
        payment_allocations: Array.from({ length: 1201 }, (_, n) => ({
          id: String(n).padStart(5, "0"),
          org_id: ORG,
          payment_id: `payment-${n}`,
          bill_id: `bill-${n}`,
          amount_cents: 100,
          payment: paid,
          bill,
        })),
        payments: [
          payment({ id: "payment-0", bill_id: "bill-0" }), // also allocated: counted once
          payment({ id: "direct", bill_id: "direct-bill", amount_cents: 300 }),
          payment({ id: "card", bill_id: "card-bill", amount_cents: 10000, method: "credit_card" }),
          payment({ id: "refunded", bill_id: "refunded-bill", amount_cents: 500, status: "refunded" }),
        ],
        // Paid, but with no dated payment behind it.
        vendor_bills: [{ id: "legacy-bill", org_id: ORG, company_id: "legacy", paid_cents: 900000, paid_at: "2026-06-01T12:00:00Z" }],
        project_expenses: [],
        tax_identity_refs: [
          { id: "tin", org_id: ORG, company_id: "vendor", vault_provider: "supabase_vault", verification_status: "verified", tin_last4: "1234" },
        ],
        payment_reversals: [
          reversal({ id: "r1", bill_id: "bill-0" }),
          reversal({ id: "r2", bill_id: "card-bill", amount_cents: 10000, payment: { method: "card" } }),
          reversal({ id: "r3", bill_id: "bill-1", status: "pending" }),
          reversal({ id: "r4", bill_id: "bill-2", occurred_at: "2027-01-01T00:00:00Z" }),
          reversal({ id: "r5", bill_id: "refunded-bill", amount_cents: 500 }),
        ],
      },
    }),
  )
}

test("a vendor's 1099 total is every page of this year's reportable cash, counted once, net of settled returns", async () => {
  const service = report()
  const result = await service.run(() => getVendor1099Report({ year: 2026 }))
  const trade = result.rows.find((row) => row.company_id === "vendor")

  // 1,201 allocations ($1,201) + direct $3 + the later-refunded $5, less $1 + $5 of settled ACH returns.
  assert.equal(trade.total_paid_cents, 120300)
  assert.equal(trade.reversed_cents, 600)
  assert.equal(trade.meets_threshold, true)
  assert.equal(trade.blocked_for_filing, false)
})

test("a bill marked paid without dated payment evidence reports nothing and blocks filing", async () => {
  const service = report()
  const result = await service.run(() => getVendor1099Report({ year: 2026 }))
  const legacy = result.rows.find((row) => row.company_id === "legacy")

  assert.equal(legacy.total_paid_cents, 0)
  assert.equal(legacy.blocked_for_filing, true)
  assert.match(legacy.blocking_reasons.join(" "), /dated payment evidence/)
})

test("the report needs Books or tax filing access", async () => {
  const service = report([])
  await assert.rejects(service.run(() => getVendor1099Report({ year: 2026 })), /Missing permission: books\.read or books\.tax/)
  assert.equal(service.reads("payments").length, 0)
})

const { buildPackageSnapshot, buildFilingFile, validateFilingFile, FILING_COLUMNS } = require("../lib/services/books/vendor-1099-filing-rules")

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const address = { street1: "1 Main St", city: "Naples", state: "fl", postal_code: "34102" }
const row = (n, name, cents, extra = {}) => ({ company_id: id(n), vendor_name: name, tax_id_last4: "4321", tax_entity_type: "llc", w9_on_file: true, tax_identity_vaulted: true,
  tin_verification_status: "pending", total_paid_cents: cents, reversed_cents: 0, meets_threshold: cents >= 200000, blocked_for_filing: false, blocking_reasons: [], ...extra })
const payer = { legalEntityId: id(99), name: "Cedar Ridge Builders, LLC", tinLast4: "3334", address: { ...address, street1: "100 Builder Way" } }

test("a package files everyone at or over the threshold and is refused, with every reason, while anyone is blocked", () => {
  const rows = [row(1, "Framing, Inc.", 300000), row(2, "Pat Rivera", 250000, { tax_entity_type: "individual" }), row(3, "Painter", 150000)]
  const built = buildPackageSnapshot({ taxYear: 2026, thresholdCents: 200000, payer, rows, addresses: new Map([[id(1), address], [id(2), address]]) })
  assert.deepEqual(built.snapshot.payees.map((payee) => [payee.name, payee.tin_type, payee.amount_cents, payee.address.state]), [["Framing, Inc.", "EIN", 300000, "FL"], ["Pat Rivera", "SSN", 250000, "FL"]])
  const blocked = buildPackageSnapshot({ taxYear: 2026, thresholdCents: 200000, payer: { ...payer, tinLast4: null }, addresses: new Map([[id(1), address]]),
    rows: [row(1, "Framing, Inc.", 300000, { blocking_reasons: ["No W-9 on file"] }), row(2, "Pat Rivera", 250000)] })
  assert.deepEqual(blocked.problems, ["Cedar Ridge Builders, LLC: record the company's own taxpayer ID before filing", "Framing, Inc.: No W-9 on file", "Pat Rivera: add the vendor's street, city, state and ZIP"])
})

test("the filing file carries full IDs only when they still match the approved last four, and is checked against the approved totals", () => {
  const { snapshot } = buildPackageSnapshot({ taxYear: 2026, thresholdCents: 200000, payer, rows: [row(1, "Framing, Inc.", 300001), row(2, "Pat Rivera", 250000, { tax_entity_type: "individual" })], addresses: new Map([[id(1), address], [id(2), address]]) })
  const identities = { payer: "112223334", payees: { [id(1)]: "123454321", [id(2)]: "987654321" } }
  const file = buildFilingFile(snapshot, identities)
  assert.equal(file.split("\n")[0], FILING_COLUMNS.join(","))
  assert.match(file, /^112223334,"Cedar Ridge Builders, LLC",100 Builder Way,Naples,FL,34102,123454321,EIN,"Framing, Inc\.",1 Main St,Naples,FL,34102,3000\.01,2026,/m)
  assert.deepEqual(validateFilingFile(file, snapshot), { rows: 2, totalCents: 550001 })
  assert.throws(() => buildFilingFile(snapshot, { ...identities, payees: { ...identities.payees, [id(2)]: "987650000" } }), /Pat Rivera's taxpayer ID changed after this package was approved/)
  assert.throws(() => buildFilingFile(snapshot, { ...identities, payer: null }), /company's taxpayer ID changed/)
  assert.throws(() => validateFilingFile(file.replace("3000.01", "3000.02"), snapshot), /total does not match/)
  assert.throws(() => validateFilingFile(file.replace("123454321", "12345432"), snapshot), /nine digits/)
})

test("an approved package becomes one TaxBandits 1099-NEC submission with the same checked IDs and amounts", () => {
  const { taxBanditsNecRequest } = require("../lib/services/books/vendor-1099-filing-rules")
  const { snapshot } = buildPackageSnapshot({ taxYear: 2026, thresholdCents: 200000, payer, rows: [row(1, "Framing, Inc.", 300001), row(2, "Pat Rivera", 250000, { tax_entity_type: "individual" })], addresses: new Map([[id(1), address], [id(2), address]]) })
  const identities = { payer: "112223334", payees: { [id(1)]: "123454321", [id(2)]: "987654321" } }
  const request = taxBanditsNecRequest(snapshot, identities)
  assert.deepEqual(request.SubmissionManifest, { TaxYear: "2026", IRSFilingType: "IRIS", IsFederalFiling: true, IsStateFiling: false, IsPostal: false, IsOnlineAccess: false, IsScheduleFiling: false })
  assert.equal(request.ReturnHeader.Business.EINorSSN, "112223334")
  assert.deepEqual(request.ReturnData.map((record) => [record.SequenceId, record.Recipient.TINType, record.Recipient.TIN, record.Recipient.FirstPayeeNm ?? `${record.Recipient.FirstNm} ${record.Recipient.LastNm}`, record.NECFormData.B1NEC]),
    [[id(1), "EIN", "123454321", "Framing, Inc.", 3000.01], [id(2), "SSN", "987654321", "Pat Rivera", 2500]])
  assert.deepEqual(request.ReturnData[0].Recipient.USAddress, { Address1: "1 Main St", City: "Naples", State: "FL", ZipCd: "34102" })
  assert.throws(() => taxBanditsNecRequest(snapshot, { ...identities, payees: { ...identities.payees, [id(1)]: "123450000" } }), /Framing, Inc\.'s taxpayer ID changed/)
  assert.throws(() => taxBanditsNecRequest({ ...snapshot, payer: { ...snapshot.payer, name: "B".repeat(76) } }, identities), /longer than the 75 characters/)
})

test("the IRS outcome is recorded only once every return has one, and a rejection carries its reasons", () => {
  const { taxBanditsOutcome } = require("../lib/services/books/vendor-1099-filing-rules")
  assert.equal(taxBanditsOutcome([{ status: "ACCEPTED", errors: [] }, { status: "SENT TO AGENCY", errors: [] }]).outcome, "pending")
  assert.equal(taxBanditsOutcome([{ status: "ACCEPTED", errors: [] }, { status: "ACCEPTEDWITHERRORS", errors: [] }]).outcome, "accepted")
  assert.deepEqual(taxBanditsOutcome([{ status: "ACCEPTED", errors: [] }, { status: "REJECTED", errors: ["TIN Error"] }]), { outcome: "rejected", statuses: ["ACCEPTED", "REJECTED"], reasons: ["TIN Error"] })
  assert.equal(taxBanditsOutcome([]).outcome, "pending")
})

test("an individual's taxpayer ID must be a number the SSA issues", () => {
  const { ssnProblem, isSsnFiler } = require("../lib/services/books/vendor-1099-filing-rules")
  assert.equal(ssnProblem("487654324"), null)
  for (const tin of ["987654324", "666123456", "000123456"]) assert.match(ssnProblem(tin), /cannot start with 000, 666 or 9/)
  for (const tin of ["123004567", "123450000"]) assert.match(ssnProblem(tin), /00 in the middle or 0000 at the end/)
  assert.deepEqual(["individual", "sole_prop", "llc", null].map(isSsnFiler), [true, true, false, false])
})
