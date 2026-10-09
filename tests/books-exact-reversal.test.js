const { migrationSql } = require("./support/migration-sql")
require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const { createBooksLedgerDb } = require("./helpers/books-ledger-db");
const migration = migrationSql("20261004194104_books_exact_reversal_posting"),
  id = (n) => "88300000-0000-4000-8000-" + String(n).padStart(12, "0");
async function fixture(t, upgrade = true) {
  const db = await createBooksLedgerDb({ exactReversals: upgrade });
  t.after(() => db.close());
  await db.exec(`insert into orgs values('${id(1)}');insert into app_users values('${id(2)}');insert into projects(id,org_id) values('${id(5)}','${id(1)}');
 insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${id(3)}','${id(1)}','1000','Cash','asset','cash','debit'),('${id(4)}','${id(1)}','4000','Revenue','income','construction_revenue','credit');
 insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${id(6)}','${id(1)}','2026-09-01','2026-09-30',2026,9),('${id(7)}','${id(1)}','2026-10-01','2026-10-31',2026,10);`);
  const lines = [
    {
      line_no: 1,
      account_id: id(3),
      project_id: id(5),
      debit_cents: 15000,
      credit_cents: 0,
      description: "Original cash",
      dimensions: { contract_id: id(9) },
    },
    {
      line_no: 2,
      account_id: id(4),
      project_id: id(5),
      debit_cents: 0,
      credit_cents: 15000,
      description: "Original income",
      dimensions: { contract_id: id(9) },
    },
  ];
  const post = async (entry, rows) =>
    (
      await db.query(
        "select post_books_journal_entry($1,$2::jsonb,$3::jsonb) id",
        [id(1), JSON.stringify(entry), JSON.stringify(rows)],
      )
    ).rows[0].id;
  const original = await post(
    {
      entry_date: "2026-09-10",
      entry_kind: "operational",
      memo: "Original sale",
      posting_key: "original",
      projection_version: 1,
      policy_version: 1,
      created_by: id(2),
    },
    lines,
  );
  const reversing = lines.map((row) => ({
    ...row,
    debit_cents: row.credit_cents,
    credit_cents: row.debit_cents,
  }));
  const entry = {
    entry_date: "2026-09-15",
    entry_kind: "reversal",
    memo: "Reviewed reversal",
    posting_key: "reverse-original",
    projection_version: 1,
    policy_version: 1,
    reversal_of_entry_id: original,
    created_by: id(2),
  };
  const reverse = async (e = entry, rows = reversing, parent = original) =>
    (
      await db.query(
        "select reverse_books_journal_entry($1,$2,$3::jsonb,$4::jsonb) result",
        [id(1), parent, JSON.stringify(e), JSON.stringify(rows)],
      )
    ).rows[0].result;
  const status = async () =>
    (
      await db.query("select status from journal_entries where id=$1", [
        original,
      ])
    ).rows[0].status;
  return { db, lines, post, original, reversing, entry, reverse, status };
}
test("balanced wrong amounts, account direction, dimensions, project or date cannot reverse money through either RPC", async (t) => {
  const f = await fixture(t);
  const cases = [
    f.reversing.map((r) => ({
      ...r,
      debit_cents: r.debit_cents ? 16000 : 0,
      credit_cents: r.credit_cents ? 16000 : 0,
    })),
    f.lines,
    f.reversing.map((r) => ({ ...r, dimensions: { contract_id: id(10) } })),
    f.reversing.map((r) => ({ ...r, project_id: null })),
  ];
  for (const rows of cases) {
    await assert.rejects(f.reverse(f.entry, rows), /exactly mirror/);
    await assert.rejects(f.post(f.entry, rows), /exactly mirror/);
    assert.equal(await f.status(), "posted");
  }
  await assert.rejects(
    f.reverse({ ...f.entry, entry_date: "2026-09-01" }),
    /date on or after/,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    1,
  );
});
test("scheduled generic posting completes the original lifecycle atomically and only exact committed intent retries succeed", async (t) => {
  const f = await fixture(t);
  await f.db.exec("update gl_accounts set active=false");
  const reversal = await f.post(f.entry, f.reversing);
  assert.equal(await f.status(), "reversed");
  assert.deepEqual(await f.reverse(), { id: reversal, created: false });
  for (const entry of [
    { ...f.entry, entry_date: "2026-09-16" },
    { ...f.entry, memo: "Different reason" },
    { ...f.entry, posting_key: "different-key" },
  ])
    await assert.rejects(f.reverse(entry), /retry differs/);
  await assert.rejects(
    f.reverse(
      f.entry,
      f.reversing.map((r) => ({ ...r, description: "Changed retained notes" })),
    ),
    /retry differs/,
  );
  await f.db.query(
    "update accounting_periods set status='closed',closed_at=now(),closed_by='88300000-0000-4000-8000-000000000002',close_digest='reviewed' where id=$1",
    [id(6)],
  );
  assert.deepEqual(await f.reverse(), { id: reversal, created: false });
});
test("reversing a reversal preserves original committed retries and cannot create a second child for an already reversed original", async (t) => {
  const f = await fixture(t),
    r = await f.reverse();
  const second = {
    ...f.entry,
    entry_date: "2026-10-10",
    posting_key: "reverse-reversal",
    reversal_of_entry_id: r.id,
  };
  const nested = await f.reverse(second, f.lines, r.id);
  assert.equal(nested.created, true);
  assert.deepEqual(await f.reverse(), { id: r.id, created: false });
  await assert.rejects(
    f.post({ ...f.entry, posting_key: "duplicate-child" }, f.reversing),
    /posted original|unique/,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    3,
  );
});
test("populated valid history upgrades intact while a balanced corrupt legacy reversal aborts the complete migration", async (t) => {
  const f = await fixture(t, false);
  await f.reverse();
  const before = (
    await f.db.query(
      "select jsonb_agg(to_jsonb(e) order by id) rows from journal_entries e",
    )
  ).rows[0].rows;
  await f.db.exec(migration);
  assert.deepEqual(
    (
      await f.db.query(
        "select jsonb_agg(to_jsonb(e) order by id) rows from journal_entries e",
      )
    ).rows[0].rows,
    before,
  );
  const bad = await fixture(t, false);
  await bad.reverse(
    bad.entry,
    bad.reversing.map((r) => ({
      ...r,
      debit_cents: r.debit_cents ? 16000 : 0,
      credit_cents: r.credit_cents ? 16000 : 0,
    })),
  );
  await assert.rejects(bad.db.exec(migration), /reviewed correction/);
  await bad.db.exec("rollback");
  assert.equal(
    (
      await bad.db.query(
        "select count(*)::int n from pg_proc where proname='books_guard_exact_reversal'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(await bad.status(), "reversed");
});
test("scheduled reversal service routes through checked reversal RPC and cannot mask a rejected retry with a posting-key lookup", async () => {
  const filename = require.resolve("../lib/services/books/ledger"),
    original = Module._load;
  let api,
    failed = false,
    created = true,
    events = 0,
    calls = [];
  const service = {
    from(table) {
      assert.equal(
        table,
        "gl_accounts",
        "reversal must not take generic posting-key shortcut",
      );
      return {
        select() {
          return this;
        },
        eq(key) {
          assert.notEqual(
            key,
            "active",
            "historical reversal must resolve original inactive accounts",
          );
          return this;
        },
        in: async () => ({
          data: [
            { id: id(3), code: "1000" },
            { id: id(4), code: "4000" },
          ],
          error: null,
        }),
      };
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      return failed
        ? { data: null, error: { message: "Reversal retry differs" } }
        : { data: { id: id(20), created }, error: null };
    },
  };
  try {
    Module._load = function (name, ...args) {
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "@/lib/services/events")
        return {
          recordEvent: async () => {
            events++;
          },
        };
      if (name === "@/lib/services/audit")
        return { recordAudit: async () => {} };
      return original.call(this, name, ...args);
    };
    delete require.cache[filename];
    api = require(filename);
  } finally {
    Module._load = original;
  }
  const draft = {
    entryDate: "2026-10-01",
    entryKind: "reversal",
    memo: "Scheduled reversal",
    postingKey: "scheduled",
    projectionVersion: 1,
    policyVersion: 1,
    reversalOfEntryId: id(10),
    lines: [
      { accountCode: "1000", debitCents: 0, creditCents: 100 },
      { accountCode: "4000", debitCents: 100, creditCents: 0 },
    ],
  };
  assert.deepEqual(await api.postBooksJournalEntryForService(draft, id(1)), {
    id: id(20),
    created: true,
  });
  assert.equal(calls[0].name, "reverse_books_journal_entry");
  assert.equal(calls[0].args.p_org_id, id(1));
  assert.equal(calls[0].args.p_original_entry_id, id(10));
  assert.equal(events, 1);
  created = false;
  await api.postBooksJournalEntryForService(draft, id(1));
  assert.equal(events, 1);
  failed = true;
  await assert.rejects(
    api.postBooksJournalEntryForService(draft, id(1)),
    /retry differs/,
  );
});
