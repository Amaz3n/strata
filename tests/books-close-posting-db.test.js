const test = require("node:test")
const assert = require("node:assert/strict")
const { createBooksLedgerDb } = require("./helpers/books-ledger-db")
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

test("real posting RPC permits close-owned year-end entries and preserves the posting freeze", async t => {
  const db = await createBooksLedgerDb()
  t.after(() => db.close())
  const org = id(1), actor = id(2), period = id(3), cash = id(4), income = id(5), retained = id(6)
  await db.exec(`
    insert into orgs values('${org}'); insert into app_users values('${actor}');
    insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values
      ('${cash}','${org}','1000','Cash','asset','cash','debit'),
      ('${income}','${org}','4000','Revenue','income','construction_revenue','credit'),
      ('${retained}','${org}','3100','Retained earnings','equity','retained_earnings','credit');
    insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period)
      values('${period}','${org}','2026-12-01','2026-12-31',2026,12);
  `)
  const post = (key, source, kind, lines, overrides = {}) => db.query("select post_books_journal_entry($1,$2::jsonb,$3::jsonb) as id", [org,
    JSON.stringify({ entry_date: "2026-12-31", entry_kind: kind, memo: key, posting_key: key, policy_version: 1, source_type: source, source_id: period, created_by: actor, ...overrides }),
    JSON.stringify(lines.map(([account_id, debit_cents, credit_cents], index) => ({ account_id, debit_cents, credit_cents, line_no: index + 1 }))),
  ])
  await post("sale", "invoice", "operational", [[cash,10000,0],[income,0,10000]])
  await db.query("select begin_books_period_close($1,$2)", [org, period])
  await assert.rejects(post("late-sale", "invoice", "operational", [[cash,100,0],[income,0,100]]), /reviewing/)
  await assert.rejects(post("spoof", "year_end_close", "operational", [[income,10000,0],[retained,0,10000]]), /reviewing/)
  await assert.rejects(post("wrong-period", "year_end_close", "closing", [[income,10000,0],[retained,0,10000]], { source_id: id(99) }), /reviewing/)
  await assert.rejects(post("wrong-date", "year_end_close", "closing", [[income,10000,0],[retained,0,10000]], { entry_date: "2026-12-30" }), /reviewing/)
  await assert.rejects(post("unbalanced", "year_end_close", "closing", [[income,10000,0],[retained,0,9999]]), /not balanced/)
  await post("year-end", "year_end_close", "closing", [[income,10000,0],[retained,0,10000]])
  assert.equal(Number((await db.query("select sum(credit_cents-debit_cents) amount from journal_lines where account_id=$1", [income])).rows[0].amount), 0)
  assert.equal(Number((await db.query("select sum(credit_cents-debit_cents) amount from journal_lines where account_id=$1", [retained])).rows[0].amount), 10000)
  assert.equal((await db.query("select count(*)::int n from journal_entries")).rows[0].n, 2)
  await db.query("update accounting_periods set status='closed',closed_at=now(),closed_by=$1,close_digest='verified' where id=$2", [actor, period])
  await assert.rejects(post("closed-poc", "revenue_recognition", "poc", [[cash,100,0],[income,0,100]]), /closed/)
  await db.query("update accounting_periods set status='reopened' where id=$1", [period])
  await post("adjusted-sale", "invoice", "operational", [[cash,2500,0],[income,0,2500]])
  await db.query("select begin_books_period_close($1,$2)", [org, period])
  await post("reclose", "year_end_close", "closing", [[income,2500,0],[retained,0,2500]])
  assert.equal(Number((await db.query("select sum(credit_cents-debit_cents) amount from journal_lines where account_id=$1", [retained])).rows[0].amount), 12500)
})
