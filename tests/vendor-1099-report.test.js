require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const { reportableVendorReversal } = require("../lib/services/reports/vendor-tax-payment-rules")

test("vendor reversals require settlement, accounting-year membership, and a reportable rail", () => {
  const reversal = { status: "succeeded", occurredAt: "2026-12-31T23:59:59Z", paymentMethod: "ach", amountCents: 10000 }
  assert.equal(reportableVendorReversal(reversal, 2026), 10000)
  assert.equal(reportableVendorReversal({ ...reversal, status: "pending" }, 2026), 0)
  assert.equal(reportableVendorReversal({ ...reversal, occurredAt: "2027-01-01T00:00:00Z" }, 2026), 0)
  for (const method of ["credit_card", "company_card", "card", "credit", null]) {
    assert.equal(reportableVendorReversal({ ...reversal, paymentMethod: method }, 2026), 0)
  }
})

// This fake enforces the report's filters/ranges, so dropping paging, date, status,
// or method handling changes observable report totals rather than a source regex.
function database(tables) {
  const value = (row, key) => key.split(".").reduce((v, part) => v?.[part], row)
  return { from(table) {
    let rows = [...(tables[table] ?? [])]
    const query = {
      select() { return query },
      eq(key, v) { rows = rows.filter(row => value(row, key) === v); return query },
      gt(key, v) { rows = rows.filter(row => value(row, key) > v); return query },
      gte(key, v) { rows = rows.filter(row => value(row, key) >= v); return query },
      lt(key, v) { rows = rows.filter(row => value(row, key) < v); return query },
      lte(key, v) { rows = rows.filter(row => value(row, key) <= v); return query },
      in(key, values) { rows = rows.filter(row => values.includes(value(row, key))); return query },
      not(key, op, v) { assert.equal(op, "is"); rows = rows.filter(row => value(row, key) != v); return query },
      or() { return query },
      order(key) { rows.sort((a,b) => String(value(a,key)).localeCompare(String(value(b,key)))); return query },
      range(from, to) { rows = rows.slice(from, to + 1); return query },
      then(resolve, reject) { return Promise.resolve({ data: rows.slice(0,1000), error: null }).then(resolve, reject) },
    }
    return query
  } }
}

test("1099 totals exhaust pages, deduplicate direct/allocation payments, and do not guess legacy cash", async () => {
  const vendor = { id: "vendor", org_id: "org", name: "Trade", is_1099_eligible: true, tax_exempt: false, w9_file_id: "w9" }
  const bill = { company_id: "vendor" }
  const paid = { received_at: "2026-06-01T12:00:00Z", status: "succeeded", method: "ach" }
  const allocations = Array.from({length:1201}, (_,n) => ({ id:String(n).padStart(5,"0"), org_id:"org", payment_id:`payment-${n}`, bill_id:`bill-${n}`, amount_cents:100, payment:paid, bill }))
  const db = database({
    tax_policy_versions: [{org_id:"org",tax_year:2026,form_type:"1099-NEC",jurisdiction:"US",threshold_cents:60000}],
    companies: [vendor, {...vendor,id:"legacy",name:"Legacy"}],
    payment_allocations: allocations,
    payments: [
      {id:"payment-0",org_id:"org",bill_id:"bill-0",amount_cents:100,bill,...paid},
      {id:"direct",org_id:"org",bill_id:"direct-bill",amount_cents:300,bill,...paid},
      {id:"card",org_id:"org",bill_id:"card-bill",amount_cents:10000,bill,...paid,method:"credit_card"},
      {id:"refunded",org_id:"org",bill_id:"refunded-bill",amount_cents:500,bill,...paid,status:"refunded"},
    ],
    vendor_bills: [{id:"legacy-bill",org_id:"org",company_id:"legacy",paid_cents:900000,paid_at:"2026-06-01T12:00:00Z"}],
    project_expenses: [],
    tax_identity_refs: [{id:"tin",org_id:"org",company_id:"vendor",vault_provider:"supabase_vault",verification_status:"verified",tin_last4:"1234"}],
    payment_reversals: [
      {id:"r1",org_id:"org",bill_id:"bill-0",amount_cents:100,status:"succeeded",occurred_at:"2026-09-01T12:00:00Z",created_at:"2027-01-01T12:00:00Z",payment:{method:"ach"},bill},
      {id:"r2",org_id:"org",bill_id:"card-bill",amount_cents:10000,status:"succeeded",occurred_at:"2026-09-01T12:00:00Z",payment:{method:"card"},bill},
      {id:"r3",org_id:"org",bill_id:"bill-1",amount_cents:100,status:"pending",occurred_at:"2026-09-01T12:00:00Z",payment:{method:"ach"},bill},
      {id:"r4",org_id:"org",bill_id:"bill-2",amount_cents:100,status:"succeeded",occurred_at:"2027-01-01T00:00:00Z",created_at:"2026-12-31T12:00:00Z",payment:{method:"ach"},bill},
      {id:"r5",org_id:"org",bill_id:"refunded-bill",amount_cents:500,status:"succeeded",occurred_at:"2026-09-01T12:00:00Z",payment:{method:"ach"},bill},
    ],
  })
  const original = Module._load
  let report
  try {
    Module._load = function(name, ...args) {
      if(name === "@/lib/services/context") return {requireOrgContext:async()=>({supabase:db,orgId:"org",userId:"user"})}
      if(name === "@/lib/services/permissions") return {requirePermission:async()=>{},requireAnyPermission:async()=>{}}
      if(name === "@/lib/supabase/server") return {createServiceSupabaseClient:()=>db}
      return original.call(this,name,...args)
    }
    report = require("../lib/services/reports/vendor-1099")
  } finally { Module._load = original }
  const result = await report.getVendor1099Report({year:2026})
  const trade = result.rows.find(row=>row.company_id === "vendor")
  assert.equal(trade.total_paid_cents, 120300)
  assert.equal(trade.reversed_cents, 600)
  assert.equal(trade.blocked_for_filing, false)
  const legacy = result.rows.find(row=>row.company_id === "legacy")
  assert.equal(legacy.total_paid_cents, 0)
  assert.equal(legacy.blocked_for_filing, true)
  assert.match(legacy.blocking_reasons.join(" "), /dated payment evidence/)
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
