require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")
const Module = require("node:module")
const fs = require("node:fs")
const { PGlite } = require("@electric-sql/pglite")
const { database } = require("./helpers/report-database")
const { allocatedSettlementEvidenceSchema, paymentProjectionSourceKeys } = require("../lib/services/books/settlement-evidence")
const { draftFromFact, selectFactsToRetire } = require("../lib/services/books/fact-drafts")
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const allocations = side => [
  { allocation_id: id(10), invoice_id: side === "invoice" ? id(20) : null, bill_id: side === "bill" ? id(20) : null, project_id: id(30), amount_cents: 101 },
  { allocation_id: id(11), invoice_id: side === "invoice" ? id(21) : null, bill_id: side === "bill" ? id(21) : null, project_id: id(31), amount_cents: 100 },
]
const common = { sourceId: id(1), accountingDate: "2026-09-30", sourceVersion: 1, projectionVersion: 1, policyVersion: 1 }

test("blocked live payment evidence protects every owned posting type from retirement", () => {
  const live = new Set(paymentProjectionSourceKeys(id(1)))
  const facts = [...live].map(key => ({ sourceType: key.split(":")[0], sourceId: id(1), factKind: "recognized", sourceVersion: 1 }))
  assert.deepEqual(selectFactsToRetire(facts, live), [])
  assert.equal(selectFactsToRetire(facts, new Set()).length, 4)
  assert.equal(selectFactsToRetire([...facts, { ...facts[0], sourceId: id(2) }], live).length, 1)
})

test("allocated receipt and payable replay balance every job and preserve fees without duplicating control balances", () => {
  for (const side of ["invoice", "bill"]) {
    for (let fee = 0; fee < 201; fee++) {
      const proof = allocatedSettlementEvidenceSchema.parse({ version: 2, kind: "allocated", payment_id: id(1), payment_amount_cents: 201, allocations: allocations(side) })
      const draft = draftFromFact({ ...common, sourceType: side === "invoice" ? "invoice_payment" : "bill_payment", payload: { amount_cents: 201, gross_cents: 204, fee_cents: side === "invoice" ? fee : 0, discount_cents: side === "bill" ? fee : 0, project_id: id(99), settlement_evidence: proof, project_dimensions: { [id(30)]: { division_id: id(40) }, [id(31)]: { division_id: id(41) } } } })
      const control = side === "invoice" ? "1100" : "2000"
      const controlLines = draft.lines.filter(row => row.accountCode === control)
      assert.deepEqual(controlLines.map(row => row.debitCents || row.creditCents), [101, 100])
      for (const [index, projectId] of [id(30), id(31)].entries()) {
        const rows = draft.lines.filter(row => row.projectId === projectId)
        assert.equal(rows.reduce((sum, row) => sum + row.debitCents - row.creditCents, 0), 0)
        assert.ok(rows.every(row => row.dimensions.payment_allocation_id === id(10 + index)))
        assert.ok(rows.every(row => row.dimensions[side === "invoice" ? "invoice_id" : "bill_id"] === id(20 + index)))
        assert.ok(rows.every(row => row.dimensions.division_id === id(40 + index)))
      }
      assert.equal(draft.lines.some(row => row.projectId === id(99)), false)
      const cash = draft.lines.filter(row => row.accountCode === (side === "invoice" ? "1010" : "1000"))
      assert.equal(cash.reduce((sum,row) => sum + row.debitCents + row.creditCents,0), (side === "invoice" ? 204 : 201) - fee)
    }
  }
  assert.throws(() => allocatedSettlementEvidenceSchema.parse({ version: 2, kind: "allocated", payment_id: id(1), payment_amount_cents: 200, allocations: allocations("invoice") }), /equal the payment/)
  const mixed = allocations("invoice"); mixed[1] = allocations("bill")[1]
  assert.throws(() => allocatedSettlementEvidenceSchema.parse({ version: 2, kind: "allocated", payment_id: id(1), payment_amount_cents: 201, allocations: mixed }), /cannot mix/)
  const repeatedIdentity = allocations("invoice"); repeatedIdentity[1].allocation_id = repeatedIdentity[0].allocation_id
  assert.throws(() => allocatedSettlementEvidenceSchema.parse({ version:2,kind:"allocated",payment_id:id(1),payment_amount_cents:201,allocations:repeatedIdentity }), /Duplicate settlement allocation identity/)
})

test("real journal RPC accepts allocated postings and preserves balanced job dimensions", async t => {
  const { createBooksLedgerDb } = require("./helpers/books-ledger-db")
  const { CONSTRUCTION_CHART_TEMPLATE } = require("../lib/services/books/chart-of-accounts")
  const db = await createBooksLedgerDb(); t.after(() => db.close())
  const org = id(2)
  await db.exec(`insert into orgs values('${org}'); insert into projects(id,org_id) values('${id(30)}','${org}'),('${id(31)}','${org}');
    insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${id(50)}','${org}','2026-09-01','2026-09-30',2026,9)`)
  const chart = new Map()
  for (const [index, template] of CONSTRUCTION_CHART_TEMPLATE.entries()) {
    const accountId = id(100 + index); chart.set(template.code,accountId)
    await db.query("insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance,cash_flow_category) values($1,$2,$3,$4,$5,$6,$7,$8)",[accountId,org,template.code,template.name,template.accountType,template.subtype,template.normalBalance,template.cashFlowCategory])
  }
  for (const [index, side] of ["invoice","bill"].entries()) {
    const proof = allocatedSettlementEvidenceSchema.parse({ version:2,kind:"allocated",payment_id:id(1),payment_amount_cents:201,allocations:allocations(side) })
    const draft = draftFromFact({ ...common,sourceType:side === "invoice" ? "invoice_payment" : "bill_payment", payload:{amount_cents:201,gross_cents:204,fee_cents:side === "invoice" ? 17 : 0,discount_cents:side === "bill" ? 7 : 0,settlement_evidence:proof} })
    await db.query("select post_books_journal_entry($1,$2,$3)",[org,JSON.stringify({entry_date:common.accountingDate,entry_kind:"operational",memo:"Allocated settlement",posting_key:`allocation-${index}`,source_type:draft.sourceType,source_id:id(1),policy_version:1}),JSON.stringify(draft.lines.map((row,lineIndex)=>({line_no:lineIndex+1,account_id:chart.get(row.accountCode),project_id:row.projectId,debit_cents:row.debitCents,credit_cents:row.creditCents,dimensions:row.dimensions})))])
  }
  const balances=(await db.query("select project_id,sum(debit_cents-credit_cents)::int balance from journal_lines group by project_id")).rows
  assert.equal(balances.length,2);assert.ok(balances.every(row=>row.balance===0))
  assert.ok((await db.query("select dimensions from journal_lines")).rows.every(row=>row.dimensions.payment_allocation_id))
})

test("allocation capture exhausts pages, validates scoped documents and rejects project/deposit/amount mismatches", async () => {
  const payment = id(1), org = id(2), project = id(3)
  const invoices = Array.from({ length: 1001 }, (_, index) => ({ id: id(10000 + index), org_id: org, project_id: project, metadata: {} }))
  const rows = invoices.map((invoice, index) => ({ id: id(20000 + index), org_id: org, payment_id: payment, invoice_id: invoice.id, bill_id: null, project_id: project, amount_cents: 1 }))
  const vendorBills = []
  const db = database({ payment_allocations: rows, invoices, vendor_bills: vendorBills })
  const original = Module._load
  let load
  try {
    Module._load = function(name, ...args) {
      if (name === "server-only") return {}
      if (name === "@/lib/supabase/server") return { createServiceSupabaseClient: () => db }
      return original.call(this, name, ...args)
    }
    load = require("../lib/services/books/settlement-allocation-loader").loadPaymentAllocationEvidence
  } finally { Module._load = original }
  const result = await load(org, [{ id: payment, amount_cents: 1001 }])
  assert.equal(result.errors.size, 0)
  assert.equal(result.evidence.get(payment).allocations.length, 1001)
  assert.match((await load(org, [{ id: payment, amount_cents: 1000 }])).errors.get(payment), /equal the payment/)
  rows[0].project_id = id(99)
  assert.match((await load(org, [{ id: payment, amount_cents: 1001 }])).errors.get(payment), /project does not match/)
  rows[0].project_id = project; invoices[0].metadata = { invoice_kind: "earnest_deposit" }
  assert.match((await load(org, [{ id: payment, amount_cents: 1001 }])).errors.get(payment), /deposit workflow/)
  invoices[0].metadata = {}; invoices[0].org_id = id(99)
  assert.match((await load(org, [{ id: payment, amount_cents: 1001 }])).errors.get(payment), /outside this organization/)

  // Payables use the bill projection, which deliberately has no invoice metadata.
  vendorBills.push({ id: id(40), org_id: org, project_id: project })
  rows.splice(0, rows.length, { id: id(41), org_id: org, payment_id: payment, invoice_id: null, bill_id: id(40), project_id: project, amount_cents: 201 })
  const payable = await load(org, [{ id: payment, amount_cents: 201, bill_id: id(40) }])
  assert.equal(payable.errors.size, 0)
  assert.deepEqual(payable.evidence.get(payment).allocations, [{ allocation_id: id(41), invoice_id: null, bill_id: id(40), project_id: project, amount_cents: 201 }])
  vendorBills[0].org_id = id(99)
  assert.match((await load(org, [{ id: payment, amount_cents: 201 }])).errors.get(payment), /outside this organization/)
})

test("actual allocation triggers monotonically revise old and new parent payments", async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`create role anon; create role authenticated;
    create table payments(id uuid primary key,org_id uuid,updated_at timestamptz default now());
    create table payment_allocations(id uuid primary key,org_id uuid,payment_id uuid,amount_cents bigint);
    create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end;$$;
    create trigger payments_set_updated_at before update on payments for each row execute function public.set_updated_at();`)
  const sql = fs.readFileSync("supabase/migrations/20261003023206_books_source_revision_invalidation.sql", "utf8")
  const start = sql.indexOf("create or replace function public.books_advance_source_revision(")
  const end = sql.indexOf("$$;", start) + 3
  assert.ok(start >= 0)
  await db.exec(sql.slice(start, end))
  await db.exec(fs.readFileSync("supabase/migrations/20261003122336_books_payment_allocation_revisions.sql", "utf8"))
  assert.ok((await db.query("select proconfig from pg_proc where oid='books_touch_payment_allocation_source()'::regprocedure")).rows[0].proconfig.includes("search_path=pg_catalog, public"))
  await db.exec(`insert into payments values('${id(1)}','${id(3)}','2099-01-01'),('${id(2)}','${id(3)}','2099-01-01')`)
  const revision = async payment => (await db.query("select updated_at::text revision from payments where id=$1", [payment])).rows[0].revision
  let before = await revision(id(1))
  await db.exec(`insert into payment_allocations values('${id(4)}','${id(3)}','${id(1)}',100)`)
  let after = await revision(id(1)); assert.ok(after > before); before = after
  await db.exec(`update payment_allocations set amount_cents=200 where id='${id(4)}'`)
  after = await revision(id(1)); assert.ok(after > before); before = after
  const secondBefore = await revision(id(2))
  await db.exec(`update payment_allocations set payment_id='${id(2)}' where id='${id(4)}'`)
  assert.ok(await revision(id(1)) > before); assert.ok(await revision(id(2)) > secondBefore)
  before = await revision(id(2))
  await db.exec(`delete from payment_allocations where id='${id(4)}'`)
  assert.ok(await revision(id(2)) > before)
})
