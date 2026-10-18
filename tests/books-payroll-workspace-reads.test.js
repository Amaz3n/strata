const { migrationSql } = require("./support/migration-sql")
require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  scenario,
} = require("./helpers/books-payroll-construction-decisions-fixture");
const {
  nextSource,
} = require("./helpers/books-payroll-correction-lineage-fixture");
const { capture } = require("./helpers/books-payroll-workflow-fixture"),
  { org, id } = require("./helpers/books-payroll-register-fixture");
const {
  parsePayrollCorrectionSource,
} = require("../lib/services/books/payroll-correction-source");
const {
  parsePayrollCorrectionProposalEvidence,
} = require("../lib/services/books/payroll-correction-proposal");
const {
  verifyPayrollCorrectionPosting,
} = require("../lib/services/books/payroll-correction-posting");
const {
  payrollLiabilityHistory,
} = require("../lib/services/books/payroll-liability-history");
const {
  parsePayrollCorrectionContext,
} = require("../lib/services/books/payroll-correction-context");
const migration = migrationSql("20261004053644_books_payroll_workspace_reads");
async function setup(t) {
  const f = await scenario(t);
  await f.db.exec(migration);
  return f;
}
async function read(
  f,
  {
    project = id(4),
    source = null,
    time = null,
    before = null,
    limit = 50,
    organization = org,
  } = {},
) {
  return (
    await f.db.query(
      "select capture_books_payroll_workspace_snapshot($1,$2,$3,$4,$5,$6) result",
      [organization, project, source, time, before, limit],
    )
  ).rows[0].result;
}
test("scoped payroll reads replay full actual source/proposal/receipt proof and omit unrelated construction and accounting modules", async (t) => {
  const f = await setup(t);
  await f.db.query("insert into projects values($1,$2,'active')", [
    id(8000),
    org,
  ]);
  await f.db.query("insert into invoices values($1,$2)", [id(8001), org]);
  await f.db.query(
    "insert into time_entries(id,org_id,project_id) values($1,$2,$3)",
    [id(8002), org, id(8000)],
  );
  const full = await capture(f.db),
    scoped = await read(f);
  assert.equal(scoped.orgId, org);
  assert.equal(scoped.projectId, id(4));
  assert.equal(scoped.sourceIds.length, 2);
  assert.equal(scoped.nextCursor, null);
  assert.equal(scoped.tables.invoices, undefined);
  assert.equal(scoped.tables.files, undefined);
  assert.ok(!scoped.tables.projects.some((row) => row.id === id(8000)));
  assert.ok(!scoped.tables.time_entries.some((row) => row.id === id(8002)));
  for (const source of scoped.tables.books_payroll_correction_sources)
    assert.deepEqual(
      parsePayrollCorrectionSource(source, scoped.tables),
      parsePayrollCorrectionSource(source, full.tables),
    );
  for (const p of scoped.tables.books_payroll_correction_proposals)
    assert.deepEqual(
      parsePayrollCorrectionProposalEvidence(p, scoped.tables),
      parsePayrollCorrectionProposalEvidence(p, full.tables),
    );
  for (const receipt of scoped.tables.books_payroll_correction_postings)
    assert.deepEqual(
      verifyPayrollCorrectionPosting(receipt, scoped.tables),
      verifyPayrollCorrectionPosting(receipt, full.tables),
    );
  assert.deepEqual(
    payrollLiabilityHistory(org, scoped.tables),
    payrollLiabilityHistory(org, full.tables),
  );
  const current = (
    await f.db.query(
      "select lock_books_payroll_correction_context($1,$2) result",
      [org, f.source.id],
    )
  ).rows[0].result;
  assert.deepEqual(
    parsePayrollCorrectionContext(current, scoped.tables),
    parsePayrollCorrectionContext(current, full.tables),
  );
  const exact = await read(f, { project: id(994), source: f.source.id });
  assert.deepEqual(exact.sourceIds, [f.source.id]);
  assert.equal(exact.tables.books_payroll_correction_sources.length, 2);
});
test("keyset pages retain tied timestamps, complete root ancestry and do not repeat sources when newer evidence arrives", async (t) => {
  const f = await setup(t);
  await f.db.exec("begin");
  for (let n = 10; n < 18; n++) {
    const s = await nextSource(f, { number: n, review: false });
    await f.db.query(
      "select withdraw_books_payroll_correction_source($1,$2,$3,$4)",
      [
        org,
        s.id,
        id(51),
        "Superseded documentary register retained for pagination review",
      ],
    );
  }
  await f.db.exec("commit");
  const first = await read(f, { limit: 3 });
  assert.equal(first.sourceIds.length, 3);
  assert.ok(first.nextCursor);
  const initial = (
    await capture(f.db)
  ).tables.books_payroll_correction_sources.map((row) => row.id);
  const newSource = await nextSource(f, { number: 30, review: false });
  assert.ok(!initial.includes(newSource.id));
  const seen = [...first.sourceIds];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await read(f, {
      limit: 3,
      time: cursor.preparedAt,
      before: cursor.id,
    });
    seen.push(...page.sourceIds);
    cursor = page.nextCursor;
  }
  assert.equal(new Set(seen).size, initial.length);
  assert.deepEqual([...seen].sort(), initial.sort());
  assert.ok(!seen.includes(newSource.id));
  assert.ok((await read(f)).sourceIds.includes(newSource.id));
});
test("project scope, pagination and service-only invoker ACL are enforced by the production read RPC", async (t) => {
  const f = await setup(t);
  for (const input of [
    { organization: id(99) },
    { project: id(8000) },
    { source: id(8001) },
    { limit: 0 },
    { limit: 51 },
    { time: "2026-09-01" },
    { source: f.source.id, time: "2026-09-01", before: id(3) },
  ])
    await assert.rejects(read(f, input), /unavailable|does not affect|Invalid/);
  await f.db.query("insert into projects values($1,$2,'active')", [
    id(8002),
    org,
  ]);
  assert.deepEqual((await read(f, { project: id(8002) })).sourceIds, []);
  await assert.rejects(
    read(f, { project: id(8002), source: f.source.id }),
    /does not affect/,
  );
  const acl = (
    await f.db.query(
      "select prosecdef,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service from pg_proc where proname='capture_books_payroll_workspace_snapshot'",
    )
  ).rows[0];
  assert.deepEqual(acl, {
    prosecdef: false,
    anon: false,
    authenticated: false,
    service: true,
  });
  await f.db.exec(
    "alter role service_role bypassrls;grant select on all tables in schema public to service_role;set role service_role",
  );
  assert.equal((await read(f)).sourceIds.length, 2);
  await f.db.exec("reset role");
  for (const role of ["anon", "authenticated"]) {
    await f.db.exec("set role " + role);
    await assert.rejects(read(f), /permission denied/);
    await f.db.exec("reset role");
  }
});
test("scoped proof keeps unexpected payroll money and orphan liability evidence visible instead of hiding corruption", async (t) => {
  const f = await setup(t);
  await f.db.exec("set session_replication_role=replica");
  await f.db.query(
    "insert into job_cost_entries select (jsonb_populate_record(null::job_cost_entries,to_jsonb(j)||jsonb_build_object('id',$1::text,'source_id',$1::text,'metadata',j.metadata-'payroll_original_posting_id'))).* from job_cost_entries j where j.org_id=$2 and j.source_type='payroll_correction' limit 1",
    [id(8099), org],
  );
  await f.db.exec("set session_replication_role=origin");
  const unexpected = await read(f);
  assert.ok(
    unexpected.tables.job_cost_entries.some((row) => row.id === id(8099)),
  );
  assert.throws(
    () =>
      verifyPayrollCorrectionPosting(
        unexpected.tables.books_payroll_correction_postings[0],
        unexpected.tables,
      ),
    /differs/,
  );
  await f.db.exec("set session_replication_role=replica");
  await f.db.query("delete from job_cost_entries where id=$1", [id(8099)]);
  await f.db.exec("set session_replication_role=origin");
  await f.db.exec("set session_replication_role=replica");
  await f.db.query(
    "insert into journal_entries select (jsonb_populate_record(null::journal_entries,to_jsonb(j)||jsonb_build_object('id',$1::text,'fact_id',null,'posting_key','unexpected-payroll-money'))).* from journal_entries j where j.org_id=$2 and j.source_type='payroll_import' limit 1",
    [id(8100), org],
  );
  await f.db.exec("set session_replication_role=origin");
  const extra = await read(f);
  assert.ok(extra.tables.journal_entries.some((row) => row.id === id(8100)));
  assert.throws(
    () =>
      parsePayrollCorrectionSource(
        extra.tables.books_payroll_correction_sources[0],
        extra.tables,
      ),
    /differs/,
  );
  await f.db.exec("set session_replication_role=replica");
  await f.db.query("delete from journal_entries where id=$1", [id(8100)]);
  await f.db.exec("set session_replication_role=origin");
  const account = (await capture(f.db)).tables.gl_accounts.find(
    (row) => row.code === "2200",
  );
  await f.db.exec("set session_replication_role=replica");
  await f.db.query(
    "insert into journal_lines select (jsonb_populate_record(null::journal_lines,to_jsonb(l)||jsonb_build_object('id',$1::text,'entry_id',$2::text))).* from journal_lines l where l.org_id=$3 and l.account_id=$4 limit 1",
    [id(8101), id(8102), org, account.id],
  );
  await f.db.exec("set session_replication_role=origin");
  const orphan = await read(f);
  assert.ok(orphan.tables.journal_lines.some((row) => row.id === id(8101)));
  assert.throws(() => payrollLiabilityHistory(org, orphan.tables), /orphan/);
});
