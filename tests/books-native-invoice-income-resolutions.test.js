require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./fixtures/books-native-invoice-income-database");
const {
  verifyNativeIncomeResolution: verify,
} = require("../lib/services/books/native-invoice-income-resolution");
const input = (f) => ({ id: id(950), request: f.incomeRequest, reason: notes });
test("scoped SQL catalog enforces all ten native income resolution ACL/RLS/trigger/nonce conditions", async (t) => {
  const f = await setup(t),
    sql = require("node:fs").readFileSync(
      "supabase/tests/books_native_invoice_income_resolutions.test.sql",
      "utf8",
    );
  const assertions = [
    ...sql.matchAll(/select ok\(([\s\S]*?),('(?:[^']|'')*')\);/g),
  ];
  assert.equal(assertions.length, 10);
  for (const [, expression, label] of assertions)
    assert.equal(
      (await f.db.query(`select (${expression}) as ok`)).rows[0].ok,
      true,
      label,
    );
});
test("absent coding resolution durably cancels the exact stale request without source changes and fences RPC and direct insertion", async (t) => {
  const f = await setup(t);
  await f.db.query(
    "update invoice_lines set unit_price_cents=12000 where id=$1",
    [id(602)],
  );
  const before = (
    await f.db.query("select to_jsonb(r) body from invoice_lines r order by id")
  ).rows;
  const r = await f.resolveIncome();
  assert.equal(r.outcome, "cancelled");
  verify(r, input(f));
  assert.deepEqual(await f.resolveIncome(), r);
  assert.deepEqual(
    (
      await f.db.query(
        "select to_jsonb(r) body from invoice_lines r order by id",
      )
    ).rows,
    before,
  );
  await assert.rejects(f.selectIncome(), /cancelled/);
  await assert.rejects(
    f.db.query(
      "insert into books_native_invoice_income_selections(id,org_id,legal_entity_id,project_id,invoice_id,actor_id,request_text) values($1,$2,$3,$4,$5,$6,$7)",
      [
        id(900),
        org,
        entity,
        id(70),
        id(100),
        maker,
        JSON.stringify(f.incomeRequest),
      ],
    ),
    /cancelled/,
  );
  await assert.rejects(
    f.db.exec("delete from books_native_invoice_income_resolutions"),
    /immutable/,
  );
  await assert.rejects(
    f.resolveIncome(f.incomeRequest, id(950), notes + " changed"),
    /original decision/,
  );
  const fresh = await f.selectIncome({
    ...f.incomeRequest,
    id: id(901),
    economic: await f.economic(),
  });
  assert.equal(fresh.created, true);
  assert.equal(fresh.selection.selection_revision, 1);
});
test("committed coding resolution recovers original receipt after further selections, posting, source status and policy changes", async (t) => {
  const f = await setup(t),
    original = await f.selectIncome();
  await f.selectIncome({
    ...f.incomeRequest,
    id: id(901),
    economic: await f.economic(),
  });
  await f.post({ economic: await f.economic() });
  await f.db.exec(
    "update invoices set status='paid';update accounting_policies set status='superseded'",
  );
  const recovered = await f.resolveIncome();
  assert.equal(recovered.outcome, "committed_original");
  assert.deepEqual(recovered.selection, original.selection);
  verify(recovered, input(f));
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_income_resolutions",
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(
    f.resolveIncome({ ...f.incomeRequest, notes: notes + " changed" }),
    /saved request/,
  );
  await assert.rejects(
    f.db.query(
      "insert into books_native_invoice_income_resolutions(id,org_id,legal_entity_id,project_id,invoice_id,actor_id,request_id,request_text,reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id(950),
        org,
        entity,
        id(70),
        id(100),
        maker,
        id(900),
        JSON.stringify(f.incomeRequest),
        notes,
      ],
    ),
    /already committed/,
  );
});
test("income resolution requires current scope authority but can cancel while the native period is held", async (t) => {
  const f = await setup(t);
  await f.rpc("set_books_native_period_hold", [
    org,
    entity,
    f.original.native.period.id,
    maker,
    id(730),
    null,
    "hold",
    notes,
  ]);
  verify(await f.resolveIncome(), input(f));
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    maker,
    reviewer,
    "manage",
    notes,
  ]);
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    reviewer,
    maker,
    "revoked",
    notes,
  ]);
  await assert.rejects(f.resolveIncome(), /access/);
  const g = await setup(t);
  await assert.rejects(
    g.resolveIncome({ ...g.incomeRequest, expectedActorId: reviewer }),
    /scope/,
  );
  await assert.rejects(
    g.resolveIncome({ ...g.incomeRequest, id: id(902), expectedOrgId: id(9) }),
    /scope/,
  );
  const future = structuredClone(g.incomeRequest);
  future.economic.native.capturedAt = "2099-01-01T00:00:00.000000Z";
  await assert.rejects(g.resolveIncome(future), /source witness/);
  const foreignSource = structuredClone(g.incomeRequest);
  foreignSource.economic.native.source.org_id = id(9);
  await assert.rejects(g.resolveIncome(foreignSource), /source witness/);
  await g.db.exec("begin;set local session_replication_role=replica");
  await g.db.query("update invoices set project_id=$1 where id=$2", [
    id(71),
    id(100),
  ]);
  await g.db.exec("set local session_replication_role=origin;commit");
  await assert.rejects(g.resolveIncome(), /source/);
});
