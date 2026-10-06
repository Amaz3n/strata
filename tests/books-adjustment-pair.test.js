require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  Module = require("node:module");
const { createBooksLedgerDb } = require("./helpers/books-ledger-db");
const id = (n) => "88200000-0000-4000-8000-" + String(n).padStart(12, "0"),
  key = "adjustment:" + "a".repeat(64);
async function fixture(t) {
  const db = await createBooksLedgerDb();
  t.after(() => db.close());
  await db.exec(`create table memberships(org_id uuid,user_id uuid,status text);insert into orgs values('${id(1)}'),('${id(9)}');insert into app_users values('${id(2)}'),('${id(8)}');insert into memberships values('${id(1)}','${id(2)}','active'),('${id(9)}','${id(8)}','active');
 insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${id(3)}','${id(1)}','1000','Cash','asset','cash','debit'),('${id(4)}','${id(1)}','4000','Income','income','construction_revenue','credit');
 insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${id(5)}','${id(1)}','2026-09-01','2026-09-30',2026,9),('${id(6)}','${id(1)}','2026-10-01','2026-10-31',2026,10);`);
  await db.exec(
    fs.readFileSync(
      "supabase/migrations/20261004195905_books_atomic_adjustment_pair.sql",
      "utf8",
    ),
  );
  const lines = [
    {
      line_no: 1,
      account_id: id(3),
      debit_cents: 10000,
      credit_cents: 0,
      description: "Accrued balance",
      dimensions: { basis: "reviewed" },
    },
    {
      line_no: 2,
      account_id: id(4),
      debit_cents: 0,
      credit_cents: 10000,
      description: "Accrued balance",
      dimensions: { basis: "reviewed" },
    },
  ];
  const pair = async (overrides = {}) => {
    const args = {
      org: id(1),
      actor: id(2),
      date: "2026-09-10",
      memo: "Reviewed accrual",
      key,
      policy: 1,
      lines,
      reversing: "2026-10-01",
      ...overrides,
    };
    return (
      await db.query(
        "select post_books_adjustment_pair($1,$2,$3,$4,$5,$6,$7::jsonb,$8) result",
        [
          args.org,
          args.actor,
          args.date,
          args.memo,
          args.key,
          args.policy,
          JSON.stringify(args.lines),
          args.reversing,
        ],
      )
    ).rows[0].result;
  };
  const count = async () =>
    (await db.query("select count(*)::int n from journal_entries")).rows[0].n;
  return { db, lines, pair, count };
}
test("pair failure in the reversal period rolls back all new money, including an injected failure after the reversal is inserted", async (t) => {
  const f = await fixture(t);
  await f.db.exec(
    `update accounting_periods set status='closed',closed_at=now(),closed_by='${id(2)}',close_digest='reviewed' where id='${id(6)}'`,
  );
  await assert.rejects(f.pair(), /closed/);
  assert.equal(await f.count(), 0);
  await f.db.exec(
    `update accounting_periods set status='reopened' where id='${id(6)}';create function fail_second_leg() returns trigger language plpgsql as $$begin if new.entry_kind='reversal' then raise exception 'Injected second leg failure';end if;return new;end$$;create trigger test_second_leg after insert on journal_entries for each row execute function fail_second_leg();`,
  );
  await assert.rejects(f.pair(), /Injected second leg/);
  assert.equal(await f.count(), 0);
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_lines")).rows[0].n,
    0,
  );
});
test("pair posts both journals with correct lifecycle; exact retries survive closed periods and inactive accounts while changed schedule or money rejects", async (t) => {
  const f = await fixture(t),
    r = await f.pair();
  assert.equal(r.created, true);
  assert.equal(r.reversalCreated, true);
  assert.equal(await f.count(), 2);
  assert.equal(
    (await f.db.query("select status from journal_entries where id=$1", [r.id]))
      .rows[0].status,
    "reversed",
  );
  await f.db.exec(
    `update accounting_periods set status='closed',closed_at=now(),closed_by='${id(2)}',close_digest='reviewed';update gl_accounts set active=false;`,
  );
  const retry = await f.pair();
  assert.equal(retry.id, r.id);
  assert.equal(retry.reversalId, r.reversalId);
  assert.equal(retry.created, false);
  assert.equal(retry.reversalCreated, false);
  await assert.rejects(f.pair({ reversing: "2026-10-02" }), /retry differs/);
  await assert.rejects(
    f.pair({ reversing: null }),
    /changes its reversal schedule/,
  );
  await assert.rejects(
    f.pair({
      lines: f.lines.map((l) => ({ ...l, dimensions: { basis: "different" } })),
    }),
    /differs from retained/,
  );
  assert.equal(await f.count(), 2);
});
test("unscheduled adjustment cannot acquire a changed schedule on retry and new adjustment accounts/membership remain gated", async (t) => {
  const f = await fixture(t),
    r = await f.pair({ reversing: null });
  assert.equal(r.reversalId, null);
  await assert.rejects(f.pair(), /changes its reversal schedule/);
  await f.db.exec("update gl_accounts set active=false");
  assert.equal((await f.pair({ reversing: null })).id, r.id);
  await assert.rejects(
    f.pair({ key: "adjustment:" + "b".repeat(64) }),
    /accounts must be active/,
  );
  await assert.rejects(f.pair({ actor: id(8) }), /membership/);
  assert.equal(await f.count(), 1);
});
test("legacy partial pair recovery conserves original journal and creates only its exact missing scheduled reversal", async (t) => {
  const f = await fixture(t);
  const original = (
    await f.db.query(
      "select post_books_journal_entry($1,$2::jsonb,$3::jsonb) id",
      [
        id(1),
        JSON.stringify({
          entry_date: "2026-09-10",
          entry_kind: "adjusting",
          memo: "Reviewed accrual",
          posting_key: key,
          projection_version: 1,
          policy_version: 1,
          created_by: id(2),
        }),
        JSON.stringify(f.lines),
      ],
    )
  ).rows[0].id;
  await assert.rejects(
    f.pair({ memo: "Changed basis" }),
    /differs from retained/,
  );
  assert.equal(await f.count(), 1);
  const r = await f.pair();
  assert.equal(r.id, original);
  assert.equal(r.created, false);
  assert.equal(r.reversalCreated, true);
  assert.equal(r.legacyRecovered, true);
  assert.equal(await f.count(), 2);
  assert.equal((await f.pair()).reversalId, r.reversalId);
  assert.equal(await f.count(), 2);
  assert.equal(
    (
      await f.db.query("select source_type from journal_entries where id=$1", [
        original,
      ])
    ).rows[0].source_type,
    null,
  );
});
test("actual service gates before reads, posts through one RPC, preserves both events/audits, and rejects forged receipts", async (t) => {
  const f = await fixture(t),
    filename = require.resolve("../lib/services/books/bookkeeping"),
    original = Module._load;
  let api,
    denied = false,
    forged = false,
    tableReads = 0,
    events = [],
    audits = [],
    rpcs = [];
  const service = {
    from(table) {
      assert.equal(table, "gl_accounts");
      tableReads++;
      return {
        select() {
          return this;
        },
        eq(k, v) {
          assert.equal(k, "org_id");
          assert.equal(v, id(1));
          return this;
        },
        in: async () => ({
          data: (
            await f.db.query(
              "select id,code from gl_accounts where org_id=$1",
              [id(1)],
            )
          ).rows,
          error: null,
        }),
      };
    },
    rpc: async (name, args) => {
      rpcs.push(name);
      assert.equal(name, "post_books_adjustment_pair");
      try {
        let data = (
          await f.db.query(
            "select post_books_adjustment_pair($1,$2,$3,$4,$5,$6,$7::jsonb,$8) result",
            [
              args.p_org,
              args.p_actor,
              args.p_date,
              args.p_memo,
              args.p_key,
              args.p_policy,
              JSON.stringify(args.p_lines),
              args.p_reversing_on,
            ],
          )
        ).rows[0].result;
        if (forged) data = { ...data, orgId: id(9) };
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  try {
    Module._load = function (name, ...args) {
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "@/lib/services/context")
        return {
          requireOrgContext: async () => ({
            orgId: id(1),
            userId: id(2),
            supabase: service,
          }),
        };
      if (name === "@/lib/services/books/access")
        return {
          requireBooksAuthorization: async () => {
            if (denied) throw Error("Books denied");
          },
        };
      if (name === "@/lib/services/events")
        return { recordEvent: async (e) => events.push(e) };
      if (name === "@/lib/services/audit")
        return { recordAudit: async (e) => audits.push(e) };
      return original.call(this, name, ...args);
    };
    delete require.cache[filename];
    api = require(filename);
  } finally {
    Module._load = original;
  }
  const input = {
    entryDate: "2026-09-10",
    memo: "Reviewed accrual",
    reversingOn: "2026-10-01",
    lines: f.lines.map((l, i) => ({
      accountCode: i ? "4000" : "1000",
      debitCents: l.debit_cents,
      creditCents: l.credit_cents,
      description: l.description,
      dimensions: l.dimensions,
    })),
  };
  denied = true;
  await assert.rejects(api.createAdjustingJournal(input), /Books denied/);
  assert.equal(tableReads, 0);
  denied = false;
  const r = await api.createAdjustingJournal(input);
  assert.equal(rpcs.length, 1);
  assert.equal(events.length, 2);
  assert.equal(audits.length, 2);
  assert.deepEqual(
    events.map((e) => e.entityId).sort(),
    [r.id, r.reversalId].sort(),
  );
  await f.db.exec("update gl_accounts set active=false");
  assert.equal((await api.createAdjustingJournal(input)).id, r.id);
  assert.equal(events.length, 2);
  forged = true;
  await assert.rejects(api.createAdjustingJournal(input));
  assert.equal(events.length, 2);
  assert.equal(await f.count(), 2);
  const permission = (
    await f.db.query(
      "select has_function_privilege('authenticated','post_books_adjustment_pair(uuid,uuid,date,text,text,integer,jsonb,date)','execute') allowed",
    )
  ).rows[0].allowed;
  assert.equal(permission, false);
});
