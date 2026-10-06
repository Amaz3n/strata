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
} = require("./fixtures/books-project-owner-database");
test("reviewed owner is attached to an actual project, independent and immutable; exact retries preserve its original receipt", async (t) => {
  const f = await setup(t);
  const p = await f.prepare();
  assert.equal(p.proposal.project_id, id(70));
  assert.equal(p.proposal.documents[0].id, id(81));
  assert.equal(p.ledgerActivated, false);
  assert.deepEqual(await f.prepare(), p);
  await assert.rejects(f.review({ actor: maker }), /Independent/);
  const r = await f.review();
  assert.equal(r.sourceOwnerEstablished, true);
  assert.deepEqual(await f.review(), r);
  await assert.rejects(
    f.prepare({ notes: notes + " changed" }),
    /retry differs/,
  );
  await assert.rejects(
    f.db.exec("delete from books_project_entity_reviews"),
    /immutable/,
  );
  await assert.rejects(
    f.db.exec(`update projects set org_id='${id(9)}' where id='${id(70)}'`),
    /foreign key/,
  );
  await assert.rejects(
    f.db.exec(
      `insert into journal_lines(id,org_id,project_id) values('${id(100)}','${org}','${id(70)}')`,
    ),
    /entity-native/,
  );
  await assert.rejects(
    f.db.exec(
      `insert into accounting_facts(id,org_id,payload) values('${id(101)}','${org}','{"labor_basis":{"allocations":[{"project_id":"${id(70)}"}]}}')`,
    ),
    /entity-native/,
  );
  await f.db.exec(
    `insert into invoices values('${id(120)}','${org}','${id(70)}');insert into payments values('${id(121)}','${org}','${id(120)}',null,null)`,
  );
  await assert.rejects(
    f.db.exec(
      `update invoices set project_id='${id(71)}' where id='${id(120)}'`,
    ),
    /governed correction/,
  );
  await assert.rejects(
    f.db.exec(`update payments set invoice_id=null where id='${id(121)}'`),
    /governed correction/,
  );
  await assert.rejects(
    f.db.exec(
      `insert into journal_entries values('${id(123)}','${org}','invoice','${id(120)}')`,
    ),
    /entity-native/,
  );
  await assert.rejects(
    f.db.exec(
      `insert into accounting_facts(id,org_id,payload,source_type,source_id) values('${id(122)}','${org}','{}','invoice_payment','${id(121)}')`,
    ),
    /entity-native/,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from accounting_facts")).rows[0]
      .n,
    0,
  );
});
test("ledger history, competing ownership, revoked maker and altered original documents prevent fresh ownership without disturbing ordinary projects", async (t) => {
  const f = await setup(t);
  await f.db.exec(
    `insert into journal_lines(id,org_id,project_id) values('${id(100)}','${org}','${id(71)}')`,
  );
  await assert.rejects(
    f.prepare({ project: id(71), id: id(92) }),
    /retained accounting history/,
  );
  await assert.rejects(f.prepare({ project: id(72) }), /unavailable/);
  await f.prepare();
  await f.prepare({ id: id(92) });
  await f.review();
  await assert.rejects(
    f.review({ proposal: id(92), id: id(93) }),
    /retry differs/,
  );
  await f.db.exec(
    `insert into accounting_facts(id,org_id,payload) values('${id(110)}','${org}','{"project_id":"${id(71)}"}')`,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from accounting_facts")).rows[0]
      .n,
    1,
  );
  const d = await setup(t);
  await d.prepare();
  await d.db.exec(`update doc_versions set checksum=repeat('b',64)`);
  await assert.rejects(d.review(), /documents changed/);
  const revoked = await setup(t);
  await revoked.prepare();
  await revoked.db.exec(
    `update memberships set status='revoked' where user_id='${maker}'`,
  );
  await assert.rejects(revoked.review(), /active/);
});

test("nested UUID references and project-dimension keys resolve through exact project identities", async (t) => {
  const f = await setup(t);
  const refs = (
    await f.db.query("select books_payload_uuid_refs($1::jsonb) id", [
      JSON.stringify({
        project_dimensions: { [id(70)]: { other: "value" } },
        labor: { rows: [{ project_id: id(71) }] },
      }),
    ])
  ).rows
    .map((r) => r.id)
    .sort();
  assert.deepEqual(refs, [id(70), id(71)].sort());
  assert.deepEqual(
    (
      await f.db.query(
        "select books_fact_project_refs($1,$2,$3,$4::jsonb) id",
        [org, "expense", id(999), JSON.stringify({ project_id: id(72) })],
      )
    ).rows,
    [],
  );
});
