require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  id,
  org,
  maker,
  reviewer,
  entity,
  notes,
} = require("./fixtures/books-native-invoice-income-database");
const {
  verifyNativeInvoiceIncomeSelection: verify,
} = require("../lib/services/books/native-invoice-income-contract");
test("income selection updates only exact invoice goods metadata and retains immutable exact source/chart authority", async (t) => {
  const f = await setup(t),
    r = await f.selectIncome();
  assert.equal(r.coded, true);
  assert.equal(r.posted, false);
  assert.equal(r.created, true);
  assert.equal(r.ledgerActivated, false);
  verify(r.selection);
  assert.deepEqual((await f.selectIncome()).selection, r.selection);
  assert.equal((await f.selectIncome()).created, false);
  await assert.rejects(
    f.selectIncome({ ...f.incomeRequest, notes: notes + " changed" }),
    /original request/,
  );
  await assert.rejects(
    f.db.exec("delete from books_native_invoice_income_selections"),
    /immutable/,
  );
  const retained = (
    await f.db.query("select metadata from invoice_lines where id=$1", [
      id(603),
    ])
  ).rows[0];
  assert.equal(retained.metadata.system_generated_kind, "retainage_hold");
  await f.post({ economic: await f.economic() });
  assert.deepEqual((await f.selectIncome()).selection, r.selection);
  await assert.rejects(
    f.selectIncome({
      ...f.incomeRequest,
      id: id(901),
      economic: await f.economic(),
    }),
    /governed reversal/,
  );
});
test("foreign, duplicate, partial, generated, nonincome and stale requests roll back coding and cannot insert a receipt", async (t) => {
  const f = await setup(t);
  const q = f.incomeRequest;
  for (const assignments of [
    [],
    [q.assignments[0], q.assignments[0]],
    [{ lineId: id(603), accountId: null }],
    [{ lineId: id(999), accountId: null }],
    [{ lineId: id(602), accountId: id(999) }],
    [
      {
        lineId: id(602),
        accountId: f.original.native.accounts.find((a) => a.code === "1100").id,
      },
    ],
  ])
    await assert.rejects(f.selectIncome({ ...q, assignments }));
  await f.db.exec(
    `update invoice_lines set unit_price_cents=12000 where id='${id(602)}'`,
  );
  await assert.rejects(f.selectIncome(), /snapshot changed/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_income_selections",
      )
    ).rows[0].n,
    0,
  );
});
test("native chart selections replace explicit legacy coding without changing pricing or unrelated metadata", async (t) => {
  const f = await setup(t);
  await f.db.exec(
    `update invoice_lines set metadata='{"arc_books_gl_account_id":"legacy-id","description_hint":"preserve"}' where id='${id(602)}'`,
  );
  const economic = await f.economic(),
    account = economic.native.accounts.find(
      (a) => a.definition.account_type === "income",
    );
  const r = await f.selectIncome({
    ...f.incomeRequest,
    economic,
    assignments: [{ lineId: id(602), accountId: account.id }],
  });
  const checked = verify(r.selection);
  assert.equal(
    checked.economic.lines.find((l) => l.source.id === id(602)).source.metadata
      .arc_books_entity_account_id,
    account.id,
  );
  assert.equal(
    checked.economic.lines.find((l) => l.source.id === id(602)).source.metadata
      .description_hint,
    "preserve",
  );
  assert.ok(
    !(
      "arc_books_gl_account_id" in
      checked.economic.lines.find((l) => l.source.id === id(602)).source
        .metadata
    ),
  );
  const bad = structuredClone(r.selection),
    data = JSON.parse(bad.result_text);
  data.lines[0].source.unit_price_cents += 1;
  bad.result_text = JSON.stringify(data);
  bad.result_sha256 = require("node:crypto")
    .createHash("sha256")
    .update(bad.result_text)
    .digest("hex");
  assert.throws(() => verify(bad));
});
test("revoked entity preparation and inactive membership deny committed coding retries", async (t) => {
  const f = await setup(t);
  await f.selectIncome();
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
  await assert.rejects(f.selectIncome(), /access/);
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    reviewer,
    maker,
    "prepare",
    notes,
  ]);
  await f.db.exec(
    `update memberships set status='inactive' where user_id='${maker}'`,
  );
  await assert.rejects(f.selectIncome(), /access/);
});

test("a rejected later assignment rolls back the earlier source edit and immutable receipt together", async (t) => {
  const f = await setup(t);
  await f.db.exec(
    `insert into invoice_lines values('${id(903)}','${org}','${id(100)}',1,0,null,'{}')`,
  );
  const economic = await f.economic();
  const account = economic.native.accounts.find(
    (a) => a.definition.account_type === "income",
  );
  await assert.rejects(
    f.selectIncome({
      ...f.incomeRequest,
      economic,
      assignments: [
        { lineId: id(602), accountId: account.id },
        { lineId: id(903), accountId: id(999) },
      ],
    }),
    /income chart/,
  );
  assert.equal(
    (
      await f.db.query("select metadata from invoice_lines where id=$1", [
        id(602),
      ])
    ).rows[0].metadata.arc_books_entity_account_id,
    undefined,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_income_selections",
      )
    ).rows[0].n,
    0,
  );
});

test("actual scoped SQL catalog enforces all twelve native coding and archive ACL/invoker/foreign-key assertions", async (t) => {
  const f = await setup(t);
  const sql = require("node:fs").readFileSync(
    "supabase/tests/books_native_invoice_income_selection.test.sql",
    "utf8",
  );
  const assertions = [
    ...sql.matchAll(/select ok\(([\s\S]*?),('(?:[^']|'')*')\);/g),
  ];
  assert.equal(assertions.length, 12);
  for (const [, expression, label] of assertions) {
    const r = await f.db.query(`select (${expression}) as ok`);
    assert.equal(r.rows[0].ok, true, label);
  }
});

test("a valid chart account injected through ordinary source metadata cannot bypass authorized selection before native posting", async (t) => {
  const f = await setup(t);
  const account = f.original.native.accounts.find(
    (a) => a.definition.account_type === "income",
  );
  await f.db.query(
    "update invoice_lines set metadata=jsonb_build_object('arc_books_entity_account_id',$1::text) where id=$2",
    [account.id, id(602)],
  );
  const economic = await f.economic();
  await assert.rejects(f.post({ economic }), /authorized source selection/);
  await f.selectIncome({
    ...f.incomeRequest,
    economic,
    assignments: [{ lineId: id(602), accountId: account.id }],
  });
  const result = await f.post({ economic: await f.economic() });
  assert.equal(result.posted, true);
});
test("default income with a dangling source selection reference rejects before money and can be repaired by an authorized selection", async (t) => {
  const f = await setup(t);
  await f.db.query(
    "update invoice_lines set metadata=jsonb_build_object('arc_books_entity_income_selection_id',$1::text) where id=$2",
    [id(999), id(602)],
  );
  const economic = await f.economic();
  await assert.rejects(f.post({ economic }), /authorized selection identity/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_postings",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    0,
  );
  await f.selectIncome({ ...f.incomeRequest, economic });
  const receipt = await f.post({ economic: await f.economic() });
  assert.equal(receipt.posting.income_selection_id, id(900));
});
