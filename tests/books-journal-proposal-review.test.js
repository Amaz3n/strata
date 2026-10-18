const { migrationSql } = require("./support/migration-sql")
require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const { createBooksLedgerDb } = require("./helpers/books-ledger-db");
const id = (n) => "88300000-0000-4000-8000-" + String(n).padStart(12, "0");
async function fixture(t) {
  const db = await createBooksLedgerDb();
  t.after(() => db.close());
  const old = fs.readFileSync(
    "supabase/migrations/20260812150201_books_sole_ledger_operations.sql",
    "utf8",
  );
  const start = old.indexOf("create table public.books_journal_proposals (");
  await db.exec(old.slice(start, old.indexOf("\n);", start) + 4));
  await db.exec(`create table memberships(org_id uuid,user_id uuid,status text);insert into orgs values('${id(1)}'),('${id(9)}');insert into app_users values('${id(2)}'),('${id(7)}'),('${id(8)}');insert into memberships values('${id(1)}','${id(2)}','active'),('${id(1)}','${id(7)}','active'),('${id(9)}','${id(8)}','active');
 insert into gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values('${id(3)}','${id(1)}','1000','Cash','asset','cash','debit'),('${id(4)}','${id(1)}','4000','Income','income','construction_revenue','credit');
 insert into accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period) values('${id(5)}','${id(1)}','2026-09-01','2026-09-30',2026,9),('${id(6)}','${id(1)}','2026-10-01','2026-10-31',2026,10);
 create trigger books_journal_proposals_guard before delete on books_journal_proposals for each row execute function books_reject_mutation();`);
  await db.exec(
    migrationSql("20261004201613_books_journal_proposal_review_receipts"),
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
  await db.query(
    "insert into books_journal_proposals(id,org_id,entry_date,memo,reversing_on,posting_key,policy_version,proposed_by,lines) values($1,$2,'2026-09-10','Reviewed accrual','2026-10-01',$3,1,$4,$5::jsonb)",
    [
      id(10),
      id(1),
      "adjustment:" + "c".repeat(64),
      id(2),
      JSON.stringify(lines),
    ],
  );
  const review = async (decision = "approve", note = "", actor = id(7)) =>
    (
      await db.query(
        "select review_books_journal_proposal_atomic($1,$2,$3,$4,$5) result",
        [id(1), id(10), actor, decision, note],
      )
    ).rows[0].result;
  return { db, review };
}
test("exact approval retry retains both journals after close and maker/account deactivation; changed reviews fail", async (t) => {
  const f = await fixture(t),
    r = await f.review("approve", "Checked support");
  assert.equal(r.created, true);
  assert.ok(r.reversal_entry_id);
  await f.db.exec(
    `update accounting_periods set status='closed',closed_at=now(),closed_by='${id(7)}',close_digest='reviewed';update gl_accounts set active=false;update memberships set status='inactive' where user_id='${id(2)}';`,
  );
  assert.deepEqual(await f.review("approve", "Checked support"), {
    ...r,
    created: false,
  });
  await assert.rejects(f.review("approve", "Changed support"), /retry differs/);
  await assert.rejects(f.review("reject", "Checked support"), /retry differs/);
  await assert.rejects(
    f.review("approve", "Checked support", id(8)),
    /membership/,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    2,
  );
});
test("all submitted fields are immutable and fabricated approval/rejection receipts fail", async (t) => {
  const f = await fixture(t);
  for (const change of [
    "reversing_on='2026-10-02'",
    "policy_version=2",
    "proposed_at=proposed_at+interval '1 second'",
    `id='${id(11)}'`,
  ])
    await assert.rejects(
      f.db.exec("update books_journal_proposals set " + change),
      /intent is immutable/,
    );
  await assert.rejects(
    f.db.exec(
      "update books_journal_proposals set status='posted',reviewed_at=now(),reviewed_by='" +
        id(7) +
        "',journal_entry_id='" +
        id(12) +
        "'",
    ),
    /differs from retained/,
  );
  await assert.rejects(f.review("approve", "", id(2)), /maker cannot review/);
  await assert.rejects(
    f.db.exec(
      "update books_journal_proposals set status='rejected',reviewed_at=now(),reviewed_by='" +
        id(2) +
        "',review_note='Rejected'",
    ),
    /Independent review/,
  );
  assert.equal(
    (await f.db.query("select status from books_journal_proposals")).rows[0]
      .status,
    "pending",
  );
});
test("failed second leg rolls back approval and both journals; inactive accounts prevent new approval", async (t) => {
  const f = await fixture(t);
  await f.db.exec(
    `create function fail_second_leg() returns trigger language plpgsql as $$begin if new.entry_kind='reversal' then raise exception 'Injected second leg failure';end if;return new;end$$;create trigger test_second_leg after insert on journal_entries for each row execute function fail_second_leg();`,
  );
  await assert.rejects(f.review(), /Injected second leg/);
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    0,
  );
  assert.equal(
    (await f.db.query("select status from books_journal_proposals")).rows[0]
      .status,
    "pending",
  );
  await f.db.exec(
    "drop trigger test_second_leg on journal_entries;update gl_accounts set active=false",
  );
  await assert.rejects(f.review(), /accounts must be active/);
});
test("rejection can resolve a departed maker proposal and retry exactly; RPC is private invoker", async (t) => {
  const f = await fixture(t);
  await f.db.exec(
    `update memberships set status='inactive' where user_id='${id(2)}'`,
  );
  const r = await f.review("reject", "Missing support");
  assert.equal(r.status, "rejected");
  assert.equal(r.journal_entry_id, null);
  assert.deepEqual(await f.review("reject", "Missing support"), {
    ...r,
    created: false,
  });
  await assert.rejects(f.review("reject", "Other support"), /retry differs/);
  const acl = (
    await f.db.query(
      "select prosecdef,has_function_privilege('authenticated',oid,'execute') allowed from pg_proc where proname='review_books_journal_proposal_atomic'",
    )
  ).rows[0];
  assert.deepEqual(acl, { prosecdef: false, allowed: false });
});
test("service validates scoped receipts, checks access before RPC, and emits only once on committed retry", async (t) => {
  const f = await fixture(t),
    Module = require("node:module"),
    filename = require.resolve("../lib/services/books/bookkeeping"),
    load = Module._load;
  let denied = false,
    forged = false,
    calls = 0,
    events = [],
    api;
  const service = {
    rpc: async (name, a) => {
      calls++;
      assert.equal(name, "review_books_journal_proposal_atomic");
      assert.equal(a.p_org_id, id(1));
      assert.equal(a.p_reviewer_id, id(7));
      const data = await f.review(a.p_decision, a.p_note);
      return {
        data: forged ? { ...data, proposalId: id(11) } : data,
        error: null,
      };
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
            userId: id(7),
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
      return load.call(this, name, ...args);
    };
    delete require.cache[filename];
    api = require(filename);
  } finally {
    Module._load = load;
  }
  const input = {
    proposalId: id(10),
    decision: "approve",
    note: "Checked support",
  };
  denied = true;
  await assert.rejects(api.reviewJournalProposal(input), /Books denied/);
  assert.equal(calls, 0);
  denied = false;
  const beforeScopeCheck = calls;
  await assert.rejects(
    api.reviewJournalProposal({
      ...input,
      expectedOrgId: id(9),
      expectedActorId: id(7),
    }),
    /another organization or user/,
  );
  await assert.rejects(
    api.reviewJournalProposal({
      ...input,
      expectedOrgId: id(1),
      expectedActorId: id(2),
    }),
    /another organization or user/,
  );
  assert.equal(calls, beforeScopeCheck);
  const r = await api.reviewJournalProposal(input);
  assert.equal(r.created, true);
  assert.equal(events.length, 1);
  assert.equal((await api.reviewJournalProposal(input)).created, false);
  assert.equal(events.length, 1);
  forged = true;
  await assert.rejects(api.reviewJournalProposal(input));
  assert.equal(events.length, 1);
});
test("future submitted fields freeze too, and new inserts cannot fabricate completed review evidence", async (t) => {
  const f = await fixture(t);
  await f.db.exec(
    "alter table books_journal_proposals add column recurring_template_id uuid",
  );
  await assert.rejects(
    f.db.exec(
      `update books_journal_proposals set recurring_template_id='${id(12)}'`,
    ),
    /intent is immutable/,
  );
  await assert.rejects(
    f.db.exec(
      `insert into books_journal_proposals(id,org_id,entry_date,memo,posting_key,policy_version,proposed_by,lines,status,reviewed_by,reviewed_at,review_note) select '${id(11)}',org_id,entry_date,memo,'other-key',policy_version,proposed_by,lines,'rejected','${id(7)}',now(),'Rejected' from books_journal_proposals`,
    ),
    /must be pending/,
  );
});
test("pending proposals cannot silently adopt an existing unreviewed journal with the same content key", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    `select post_books_journal_entry(org_id,jsonb_build_object('entry_date',entry_date,'entry_kind','adjusting','memo',memo,'posting_key',posting_key,'policy_version',policy_version,'projection_version',1,'created_by',proposed_by),lines) from books_journal_proposals`,
  );
  await assert.rejects(f.review(), /already occupied/);
  assert.equal(
    (await f.db.query("select status from books_journal_proposals")).rows[0]
      .status,
    "pending",
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    1,
  );
});
