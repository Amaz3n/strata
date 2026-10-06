require("../scripts/register-ts-node-test");
const fs = require("node:fs"),
  test = require("node:test"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
const {
  setup,
  id,
  org,
} = require("./fixtures/books-native-invoice-correction-database");
const {
  archive,
  bundle,
  restore,
} = require("./fixtures/books-native-invoice-correction-archive");
const {
  verifyNativeInvoiceCorrectionProposal: verify,
  NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE: TABLE,
} = require("../lib/services/books/native-invoice-correction-proposal");
const {
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const sha = (s) => createHash("sha256").update(s).digest("hex");
async function request(f, nonce = id(995)) {
  const baseEconomic = await f.economic({ date: "2026-04-16" });
  return {
    ...f.request,
    id: nonce,
    context: baseEconomic.native,
    protocolVersion: 2,
    intent: "replace",
    baseEconomic,
    patch: {
      totalCents: 12000,
      taxCents: 1000,
      lines: [
        {
          id: id(602),
          quantity: "1",
          unitPriceCents: 13000,
          incomeAccountId: null,
        },
      ],
    },
  };
}
test("explicit replacement proposal persists independently verified original reversal and full replacement without source or money edits", async (t) => {
  const f = await setup(t),
    q = await request(f),
    r = await f.prepare(q),
    v = verify(r.proposal);
  assert.deepEqual(v.request, q);
  assert.equal(v.pair.replacement.totalCents, 14000);
  assert.equal(v.pair.reversal.totalCents, 12000);
  assert.equal(
    v.pair.replacementEconomic.native.source.issue_date,
    "2026-04-15",
  );
  assert.equal(v.proposal.entry_date, "2026-04-16");
  assert.equal(
    (await f.db.query("select total_cents from invoices")).rows[0].total_cents,
    10000,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
  const old = await f.prepare(f.request);
  await f.db.exec(
    'update invoices set metadata=metadata||\'{"label":"Later review"}\'::jsonb',
  );
  assert.deepEqual(await f.prepare(q), { ...r, created: false });
  const changed = structuredClone(q);
  changed.patch.totalCents++;
  await assert.rejects(f.prepare(changed), /retry differs/);
  assert.equal(verify(old.proposal).pair, null);
});
test("v2 replacement cannot be reinterpreted as an old reversal-only proposal or retain divergent context", async (t) => {
  const f = await setup(t),
    q = await request(f);
  for (const edit of [
    (x) => {
      delete x.protocolVersion;
    },
    (x) => {
      x.protocolVersion = 1;
    },
    (x) => {
      x.intent = "void";
    },
    (x) => {
      x.context = { ...x.context, entryDate: "2026-04-17" };
    },
    (x) => {
      x.patch.lines = [];
    },
    (x) => {
      x.patch.totalCents++;
    },
    (x) => {
      x.baseEconomic = {
        ...x.baseEconomic,
        project: { ...x.baseEconomic.project, id: id(71) },
      };
    },
  ]) {
    const bad = structuredClone(q);
    edit(bad);
    await assert.rejects(f.prepare(bad));
  }
  assert.equal(
    (await f.db.query(`select count(*)::int n from ${TABLE}`)).rows[0].n,
    0,
  );
});
test("direct replacement insertion ignores forged retained money and retains canonical complete pair", async (t) => {
  const f = await setup(t),
    q = await request(f);
  const sql = fs.readFileSync(
      "supabase/tests/books_native_invoice_replacement_proposals.test.sql",
      "utf8",
    ),
    conditions = [
      ...sql.matchAll(/select ok\(([\s\S]*?),('(?:[^']|'')*')\);/g),
    ];
  assert.equal(conditions.length, 3);
  for (const [, expression, label] of conditions)
    assert.equal(
      (await f.db.query(`select (${expression}) as ok`)).rows[0].ok,
      true,
      label,
    );
  await f.db.query(
    `insert into ${TABLE}(id,org_id,legal_entity_id,project_id,prepared_by,request_text,request_sha256,derivation_text,derivation_sha256) values($1,$2,$3,$4,$5,$6,repeat('0',64),'{}',repeat('0',64))`,
    [
      q.id,
      org,
      q.context.owner.legal_entity_id,
      q.context.projectId,
      q.expectedActorId,
      JSON.stringify(q),
    ],
  );
  const row = (await f.db.query(`select to_jsonb(r) body from ${TABLE} r`))
    .rows[0].body;
  assert.equal(verify(row).pair.replacement.totalCents, 14000);
  assert.notEqual(row.derivation_text, "{}");
  const forged = structuredClone(row),
    d = JSON.parse(forged.derivation_text);
  d.replacementDraft.lines[0].accountCode = "4000";
  forged.derivation_text = JSON.stringify(d);
  forged.derivation_sha256 = sha(forged.derivation_text);
  assert.throws(() => verify(forged), /draft differs/);
});
test("schema31 closes the complete pair and rejects downgrade, detached original, rehashed revision and changed intent", async (t) => {
  const f = await setup(t),
    q = await request(f);
  await f.prepare(q);
  await f.prepare(f.request);
  const tables = await archive(f),
    r = verifyBooksExportBundle(bundle(tables, 31));
  assert.equal(r.valid, true, JSON.stringify(r));
  assert.equal(verifyBooksExportBundle(bundle(tables, 30)).valid, false);
  assert.equal(verifyBooksExportBundle(bundle(tables, 29)).valid, false);
  for (const edit of [
    (x) => {
      x.books_native_invoice_postings = [];
    },
    (x) => {
      const p = x[TABLE].find((r) => r.id === q.id),
        d = JSON.parse(p.derivation_text);
      d.replacementEconomic.native.source.total_cents++;
      p.derivation_text = JSON.stringify(d);
      p.derivation_sha256 = sha(p.derivation_text);
    },
    (x) => {
      const p = x[TABLE].find((r) => r.id === q.id),
        a = JSON.parse(p.request_text);
      delete a.protocolVersion;
      delete a.intent;
      delete a.baseEconomic;
      delete a.patch;
      p.request_text = JSON.stringify(a);
      p.request_sha256 = sha(p.request_text);
    },
  ]) {
    const copy = structuredClone(tables);
    edit(copy);
    assert.equal(verifyBooksExportBundle(bundle(copy, 31)).valid, false);
  }
  const captured = await f.rpc("capture_books_export_snapshot", [org]);
  assert.equal(captured.tables[TABLE].length, 2);
});
test("populated scoped restore preserves both proposal meanings, exact retries and fresh paired preparation", async (t) => {
  const source = await setup(t),
    target = await setup(t),
    q = await request(source),
    newProposal = await source.prepare(q),
    oldProposal = await source.prepare(source.request),
    tables = await archive(source);
  assert.equal(verifyBooksExportBundle(bundle(tables, 31)).valid, true);
  await restore(target, tables);
  assert.deepEqual(await target.prepare(q), { ...newProposal, created: false });
  assert.deepEqual(await target.prepare(source.request), {
    ...oldProposal,
    created: false,
  });
  assert.equal(verify(oldProposal.proposal).pair, null);
  const fresh = await request(target, id(996));
  assert.equal((await target.prepare(fresh)).created, true);
  assert.equal(
    (await target.post({ economic: source.original })).created,
    false,
  );
  const report = verifyBooksExportBundle(bundle(await archive(target), 31));
  assert.equal(report.valid, true, JSON.stringify(report));
});
