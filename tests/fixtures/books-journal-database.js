const fs = require("node:fs");
const { createBooksLedgerDb } = require("../helpers/books-ledger-db");
const id = (n) => "88500000-0000-4000-8000-" + String(n).padStart(12, "0");
async function fixture(t) {
  const db = await createBooksLedgerDb();
  t.after(() => db.close());
  const old = fs.readFileSync(
      "supabase/migrations/20260812150201_books_sole_ledger_operations.sql",
      "utf8",
    ),
    start = old.indexOf("create table public.books_journal_proposals (");
  await db.exec(old.slice(start, old.indexOf("\n);", start) + 4));
  await db.exec(`create table memberships(org_id uuid,user_id uuid,status text);create table books_settings(org_id uuid primary key,active_policy_version integer);insert into orgs values('${id(1)}'),('${id(9)}');insert into app_users values('${id(2)}'),('${id(7)}'),('${id(8)}');insert into memberships values('${id(1)}','${id(2)}','active'),('${id(1)}','${id(7)}','active'),('${id(9)}','${id(8)}','active');insert into books_settings values('${id(1)}',3);
 insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${id(3)}','${id(1)}','1000','Cash','asset','cash','debit'),('${id(4)}','${id(1)}','4000','Income','income','construction_revenue','credit');insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${id(5)}','${id(1)}','2026-10-01','2026-10-31',2026,10);create trigger books_journal_proposals_guard before delete on books_journal_proposals for each row execute function books_reject_mutation();`);
  for (const p of [
    "20261004201613_books_journal_proposal_review_receipts.sql",
    "20261004203909_books_journal_preparation_intents.sql",
  ])
    await db.exec(fs.readFileSync("supabase/migrations/" + p, "utf8"));
  const lines = [
    {
      line_no: 1,
      account_code: "1000",
      project_id: null,
      company_id: null,
      description: "Original accrual",
      debit_cents: 12500,
      credit_cents: 0,
      dimensions: { basis: "Original" },
    },
    {
      line_no: 2,
      account_code: "4000",
      project_id: null,
      company_id: null,
      description: "Original accrual",
      debit_cents: 0,
      credit_cents: 12500,
      dimensions: { basis: "Original" },
    },
  ];
  const prepare = async (overrides = {}) => {
    const p = {
      org: id(1),
      actor: id(2),
      intent: id(10),
      date: "2026-10-01",
      memo: "Original accrual",
      reversing: null,
      lines,
      ...overrides,
    };
    return (
      await db.query(
        "select prepare_books_journal_proposal_atomic($1,$2,$3,$4,$5,$6,$7::jsonb) result",
        [
          p.org,
          p.actor,
          p.intent,
          p.date,
          p.memo,
          p.reversing,
          JSON.stringify(p.lines),
        ],
      )
    ).rows[0].result;
  };
  const review = async (proposal) =>
    (
      await db.query(
        "select review_books_journal_proposal_atomic($1,$2,$3,'approve','Checked evidence') result",
        [id(1), proposal, id(7)],
      )
    ).rows[0].result;
  return { db, lines, prepare, review };
}
module.exports = { fixture, id };
