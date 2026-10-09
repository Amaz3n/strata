const { migrationSql } = require("./support/migration-sql")
const test = require("node:test"),
  assert = require("node:assert/strict");
const { createBooksLedgerDb } = require("./helpers/books-ledger-db");
const migration = migrationSql("20261004193127_books_core_ledger_owner_relationships"),
  id = (n) => "88400000-0000-4000-8000-" + String(n).padStart(12, "0");
async function fixture(t, upgrade = true) {
  const db = await createBooksLedgerDb({ coreOwnerRelationships: false });
  t.after(() => db.close());
  await db.exec(`insert into orgs values('${id(1)}'),('${id(2)}');insert into app_users values('${id(3)}');
 insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${id(10)}','${id(1)}','1000','Cash','asset','cash','debit'),('${id(11)}','${id(1)}','4000','Sales','income','construction_revenue','credit'),('${id(12)}','${id(2)}','1000','Foreign cash','asset','cash','debit');
 insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${id(20)}','${id(1)}','2026-09-01','2026-09-30',2026,9),('${id(21)}','${id(2)}','2026-09-01','2026-09-30',2026,9);`);
  const fact = (n, org = id(1), extra = {}) =>
    db.query(
      "insert into accounting_facts(id,org_id,source_type,source_id,source_version,fact_kind,occurred_at,accounting_date,payload,payload_hash,policy_version,idempotency_key,supersedes_fact_id,reversal_of_fact_id) values($1::uuid,$2,'invoice',$1::uuid,1,'invoice',now(),'2026-09-10','{}',repeat('a',64),1,$1::text,$3,$4)",
      [id(n), org, extra.supersedes ?? null, extra.reversal ?? null],
    );
  await fact(30);
  await fact(31, id(2));
  const entry = (n, org = id(1), extra = {}) =>
    db.query(
      "insert into journal_entries(id,org_id,entry_date,entry_kind,memo,posting_key,policy_version,fact_id,reversal_of_entry_id) values($1::uuid,$2,'2026-09-10','operational','Original sale',$1::text,1,$3,$4)",
      [id(n), org, extra.fact ?? null, extra.reversal ?? null],
    );
  await entry(40, id(1), { fact: id(30) });
  await entry(41, id(2), { fact: id(31) });
  if (upgrade) await db.exec(migration);
  return { db, fact, entry };
}
test("core owner constraints block foreign fact/lineage/account parent and reversal identities", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.entry(42, id(1), { fact: id(31) }),
    (e) =>
      e.code === "23503" && e.constraint === "journal_entries_fact_owner_fk",
  );
  await assert.rejects(
    f.entry(43, id(1), { reversal: id(41) }),
    (e) =>
      e.code === "23503" &&
      e.constraint === "journal_entries_reversal_owner_fk",
  );
  await assert.rejects(
    f.fact(32, id(1), { supersedes: id(31) }),
    (e) =>
      e.code === "23503" &&
      e.constraint === "accounting_facts_supersedes_owner_fk",
  );
  await assert.rejects(
    f.fact(33, id(1), { reversal: id(31) }),
    (e) =>
      e.code === "23503" &&
      e.constraint === "accounting_facts_reversal_owner_fk",
  );
  await assert.rejects(
    f.db.query("update gl_accounts set parent_id=$1 where id=$2", [
      id(12),
      id(10),
    ]),
    (e) => e.code === "23503" && e.constraint === "gl_accounts_parent_owner_fk",
  );
  await f.fact(34, id(1), { supersedes: id(30), reversal: id(30) });
  await f.entry(44, id(1), { fact: id(34), reversal: id(40) });
  await f.db.query("update gl_accounts set parent_id=$1 where id=$2", [
    id(10),
    id(11),
  ]);
});
test("valid populated upgrade preserves posted money and actual atomic posting rejects a foreign fact without partial lines", async (t) => {
  const f = await fixture(t, false);
  await f.db.query(
    "insert into journal_lines(org_id,entry_id,line_no,account_id,debit_cents,credit_cents) values($1,$2,1,$3,15000,0),($1,$2,2,$4,0,15000)",
    [id(1), id(40), id(10), id(11)],
  );
  await f.db.query(
    "update journal_entries set status='posted',posted_at=now() where id=$1",
    [id(40)],
  );
  const before = (
    await f.db.query(
      "select jsonb_build_object('accounts',(select jsonb_agg(a order by id) from gl_accounts a),'periods',(select jsonb_agg(p order by id) from accounting_periods p),'facts',(select jsonb_agg(f order by id) from accounting_facts f),'entries',(select jsonb_agg(e order by id) from journal_entries e),'lines',(select jsonb_agg(l order by id) from journal_lines l)) proof",
    )
  ).rows[0].proof;
  await f.db.exec(migration);
  const after = (
    await f.db.query(
      "select jsonb_build_object('accounts',(select jsonb_agg(a order by id) from gl_accounts a),'periods',(select jsonb_agg(p order by id) from accounting_periods p),'facts',(select jsonb_agg(f order by id) from accounting_facts f),'entries',(select jsonb_agg(e order by id) from journal_entries e),'lines',(select jsonb_agg(l order by id) from journal_lines l)) proof",
    )
  ).rows[0].proof;
  assert.deepEqual(after, before);
  const lines = [
    { line_no: 1, account_id: id(10), debit_cents: 20000, credit_cents: 0 },
    { line_no: 2, account_id: id(11), debit_cents: 0, credit_cents: 20000 },
  ];
  const draft = {
    entry_date: "2026-09-12",
    entry_kind: "operational",
    memo: "Invoice",
    posting_key: "new-sale",
    policy_version: 1,
    fact_id: id(31),
    created_by: id(3),
  };
  await assert.rejects(
    f.db.query("select post_books_journal_entry($1,$2::jsonb,$3::jsonb)", [
      id(1),
      JSON.stringify(draft),
      JSON.stringify(lines),
    ]),
    (e) => e.code === "23503",
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from journal_entries where posting_key='new-sale'",
      )
    ).rows[0].n,
    0,
  );
  draft.fact_id = id(30);
  const result = (
    await f.db.query(
      "select post_books_journal_entry($1,$2::jsonb,$3::jsonb) id",
      [id(1), JSON.stringify(draft), JSON.stringify(lines)],
    )
  ).rows[0].id;
  assert.equal(
    (
      await f.db.query("select status from journal_entries where id=$1", [
        result,
      ])
    ).rows[0].status,
    "posted",
  );
});
test("existing corrupt cross-organization links abort the entire upgrade without relabeling historical evidence", async (t) => {
  const f = await fixture(t, false);
  await f.entry(45, id(1), { fact: id(31) });
  await assert.rejects(f.db.exec(migration), (e) => e.code === "23503");
  await f.db.exec("rollback");
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from pg_constraint where conname like '%_owner_identity_key' or conname like '%_owner_fk'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await f.db.query(
        "select org_id,fact_id from journal_entries where id=$1",
        [id(45)],
      )
    ).rows[0].fact_id,
    id(31),
  );
});
