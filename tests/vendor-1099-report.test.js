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
      if(name === "@/lib/services/permissions") return {requirePermission:async()=>{}}
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
