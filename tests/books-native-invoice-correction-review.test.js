require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  { createHash } = require("node:crypto");
const {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./fixtures/books-native-invoice-correction-database");
const {
  verifyNativeInvoiceCorrectionReview: verify,
} = require("../lib/services/books/native-invoice-correction-review");
const {
  archive,
  bundle,
  restore,
} = require("./fixtures/books-native-invoice-correction-archive");
const {
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const sha = (s) => createHash("sha256").update(s).digest("hex");
async function prepare(f) {
  const baseEconomic = await f.economic({ date: "2026-04-16" });
  const q = {
    ...f.request,
    id: id(998),
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
  return (await f.prepare(q)).proposal;
}
function review(f, p, overrides = {}) {
  return f.rpc("review_books_native_invoice_correction", [
    overrides.org ?? org,
    overrides.entity ?? entity,
    overrides.project ?? id(70),
    overrides.actor ?? reviewer,
    overrides.id ?? id(999),
    p.id,
    overrides.decision ?? "approve",
    overrides.notes ?? notes,
    overrides.requestSha ?? p.request_sha256,
    overrides.derivationSha ?? p.derivation_sha256,
  ]);
}
test("independent replacement approval retains exact pair and reviewer context without changing source or journal; exact retry survives later labels", async (t) => {
  const f = await setup(t),
    p = await prepare(f),
    r = await review(f, p),
    v = verify(r.review, p);
  assert.equal(v.pair.reversal.totalCents, 12000);
  assert.equal(v.pair.replacement.totalCents, 14000);
  assert.equal(v.reviewerContext.actorId, reviewer);
  assert.equal(v.pair.baseEconomic.native.actorId, maker);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await f.db.query("select total_cents from invoices")).rows[0].total_cents,
    10000,
  );
  await f.db.exec("update projects set name='Later project label'");
  assert.deepEqual(await review(f, p), { ...r, created: false });
  await assert.rejects(
    review(f, p, { notes: "Changed independent review explanation" }),
    /retry differs/,
  );
  await assert.rejects(
    f.db.exec(
      "update books_native_invoice_correction_reviews set notes='Different retained review explanation'",
    ),
    /immutable/,
  );
  const sql = fs.readFileSync(
      "supabase/tests/books_native_invoice_correction_reviews.test.sql",
      "utf8",
    ),
    conditions = [
      ...sql.matchAll(/select ok\(([\s\S]*?),('(?:[^']|'')*')\);/g),
    ];
  assert.equal(conditions.length, 4);
  for (const [, expr, label] of conditions)
    assert.equal(
      (await f.db.query(`select (${expr}) ok`)).rows[0].ok,
      true,
      label,
    );
});
test("review rejects self approval, wrong saved hashes, foreign scope, v1 reinterpretation and changed source evidence", async (t) => {
  const f = await setup(t),
    p = await prepare(f);
  for (const o of [
    { actor: maker },
    { requestSha: "0".repeat(64) },
    { derivationSha: "0".repeat(64) },
    { project: id(71) },
    { entity: id(11) },
  ])
    await assert.rejects(review(f, p, o));
  const classic = (await f.prepare(f.request)).proposal;
  await assert.rejects(review(f, classic), /explicit replacement/);
  await f.db.exec("update projects set name='Changed source project evidence'");
  await assert.rejects(review(f, p), /snapshot|changed/);
  const r = await review(f, p, { decision: "reject" });
  assert.equal(verify(r.review, p).pair, null);
  await assert.rejects(review(f, p, { decision: "approve" }), /retry differs/);
});
test("direct review inserts derive their own evidence and forged retained pair fails independent receipt validation", async (t) => {
  const f = await setup(t),
    p = await prepare(f);
  await f.db.query(
    "insert into books_native_invoice_correction_reviews(id,org_id,legal_entity_id,project_id,proposal_id,decision,request_sha256,derivation_sha256,reviewed_by,notes,reviewer_context_text,reviewer_context_sha256,rechecked_derivation_text,rechecked_derivation_sha256,reviewed_at,reviewed_access_event_id) values($1,$2,$3,$4,$5,'approve',$6,$7,$8,$9,'{}',repeat('0',64),'{}',repeat('0',64),now(),$10)",
    [
      id(999),
      org,
      entity,
      id(70),
      p.id,
      p.request_sha256,
      p.derivation_sha256,
      reviewer,
      notes,
      id(999),
    ],
  );
  const r = (
    await f.db.query(
      "select to_jsonb(r) body from books_native_invoice_correction_reviews r",
    )
  ).rows[0].body;
  assert.equal(verify(r, p).pair.replacement.totalCents, 14000);
  const bad = structuredClone(r),
    d = JSON.parse(bad.rechecked_derivation_text);
  d.replacementDraft.lines[0].debitCents++;
  bad.rechecked_derivation_text = JSON.stringify(d);
  bad.rechecked_derivation_sha256 = sha(bad.rechecked_derivation_text);
  assert.throws(() => verify(bad, p));
});
test("review archive and populated restore retain approved pair, historical authority and exact retry; downgrade or self review fails", async (t) => {
  const f = await setup(t),
    target = await setup(t),
    p = await prepare(f),
    r = await review(f, p),
    tables = await archive(f);
  const report = verifyBooksExportBundle(bundle(tables, 32));
  assert.equal(report.valid, true, JSON.stringify(report));
  assert.equal(verifyBooksExportBundle(bundle(tables, 31)).valid, false);
  const bad = structuredClone(tables);
  bad.books_native_invoice_correction_reviews[0].reviewed_by = maker;
  assert.equal(verifyBooksExportBundle(bundle(bad, 32)).valid, false);
  await restore(target, tables);
  assert.deepEqual(await review(target, p), { ...r, created: false });
  assert.equal(verify(r.review, p).pair.replacement.totalCents, 14000);
  assert.equal(
    (await target.rpc("capture_books_export_snapshot", [org])).tables
      .books_native_invoice_correction_reviews.length,
    1,
  );
});
