require("../scripts/register-ts-node-test");
const fs = require("node:fs"),
  test = require("node:test"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
const base = require("./fixtures/books-native-invoice-income-database");
const {
  buildNativeInvoiceReversalPlan,
  verifyNativeInvoiceReversalDerivation,
} = require("../lib/services/books/native-invoice-correction-plan");
const {
  buildNativeProjectPostingPlan,
} = require("../lib/services/books/native-posting-plan");
const migration =
  "supabase/migrations/20261005111155_books_native_invoice_reversal_derivation.sql";
async function setup(t) {
  const f = await base.setup(t);
  await f.db.exec(fs.readFileSync(migration, "utf8"));
  const original = await f.post(),
    context = (await f.economic({ date: "2026-04-16" })).native;
  const derive = (v = {}) =>
    f.rpc("books_derive_native_invoice_reversal", [
      v.org ?? base.org,
      v.entity ?? base.entity,
      v.project ?? base.id(70),
      v.actor ?? base.maker,
      v.id ?? base.id(960),
      v.original ?? original.posting.id,
      JSON.stringify(v.context ?? context),
      v.notes ?? base.notes,
    ]);
  return { ...f, original, context, derive };
}
test("actual SQL independently derives exact full-leg reversal matching typed planner without new journal money", async (t) => {
  const f = await setup(t),
    r = await f.derive();
  const typed = buildNativeInvoiceReversalPlan({
    id: base.id(960),
    context: r.validatedContext,
    original: {
      posting: f.original.posting,
      entry: f.original.entry,
      lines: f.original.lines,
    },
    notes: base.notes,
  });
  assert.deepEqual(
    buildNativeProjectPostingPlan(r.validatedContext, r.draft).plan,
    typed.plan,
  );
  const request = {
    id: base.id(960),
    context: f.context,
    original: {
      posting: f.original.posting,
      entry: f.original.entry,
      lines: f.original.lines,
    },
    notes: base.notes,
  };
  assert.deepEqual(
    verifyNativeInvoiceReversalDerivation(request, r).plan,
    typed.plan,
  );
  for (const mutate of [
    (v) => {
      v.draft.lines[0].accountCode = "4000";
    },
    (v) => {
      v.draft.memo = "Forged reversal description";
    },
    (v) => {
      v.draft.lines[0].dimensions.forged = true;
    },
    (v) => {
      v.originalJournalSha256 = "0".repeat(64);
    },
    (v) => {
      const j = JSON.parse(v.originalJournalText);
      j.lines[0].dimensions.forged = true;
      v.originalJournalText = JSON.stringify(j);
      v.originalJournalSha256 = createHash("sha256")
        .update(v.originalJournalText)
        .digest("hex");
    },
  ]) {
    const forged = structuredClone(r);
    mutate(forged);
    assert.throws(
      () => verifyNativeInvoiceReversalDerivation(request, forged),
      /draft differs|checksum|leg differs/,
    );
  }
  assert.deepEqual(JSON.parse(r.originalJournalText), {
    entry: f.original.entry,
    lines: f.original.lines,
  });
  assert.equal(
    createHash("sha256").update(r.originalJournalText).digest("hex"),
    r.originalJournalSha256,
  );
  for (const field of [
    "posted",
    "reviewed",
    "sourceChanged",
    "ledgerActivated",
  ])
    assert.equal(r[field], false);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual((await f.derive()).draft, r.draft);
});
test("SQL reversal rejects foreign originals, reused identities, backdating, future capture and altered context", async (t) => {
  const f = await setup(t);
  for (const v of [
    { original: base.id(999) },
    { project: base.id(71) },
    { id: f.original.entry.id },
    { id: f.original.posting.id },
    { context: { ...f.context, entryDate: "2026-04-14" } },
    { context: { ...f.context, capturedAt: "2099-01-01T00:00:00Z" } },
    {
      context: {
        ...f.context,
        source: { ...f.context.source, total_cents: 123 },
      },
    },
  ])
    await assert.rejects(f.derive(v), /foreign|identity|chronology|snapshot/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
});
test("SQL reversal rejects restored corrupt original legs even when total money still balances", async (t) => {
  const f = await setup(t);
  await f.db.exec(
    "set session_replication_role=replica;update books_native_journal_lines set dimensions=dimensions||'{\"forged\":true}'::jsonb where position=1;set session_replication_role=origin",
  );
  await assert.rejects(f.derive(), /journal leg differs/);
});
test("SQL reversal rejects retained checksum corruption and current period holds", async (t) => {
  const f = await setup(t);
  await f.rpc("set_books_native_period_hold", [
    base.org,
    base.entity,
    f.context.period.id,
    base.maker,
    base.id(970),
    null,
    "hold",
    base.notes,
  ]);
  await assert.rejects(f.derive(), /held|snapshot/);
  await f.db.exec(
    "set session_replication_role=replica;delete from books_native_period_holds;update books_native_invoice_postings set draft_sha256=repeat('0',64);set session_replication_role=origin",
  );
  await assert.rejects(f.derive(), /checksum/);
});
test("SQL reversal helper is private INVOKER and denies public client execution", async (t) => {
  const f = await setup(t);
  const catalog = fs.readFileSync(
    "supabase/tests/books_native_invoice_reversal_derivation.test.sql",
    "utf8",
  );
  const assertions = [
    ...catalog.matchAll(/select ok\(([\s\S]*?),('(?:[^']|'')*')\);/g),
  ];
  assert.equal(assertions.length, 5);
  for (const [, expression, label] of assertions)
    assert.equal(
      (await f.db.query(`select (${expression}) as ok`)).rows[0].ok,
      true,
      label,
    );
  const r = (
    await f.db.query(
      "select prosecdef,has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u,has_function_privilege('service_role',oid,'execute') s from pg_proc where proname='books_derive_native_invoice_reversal'",
    )
  ).rows[0];
  assert.deepEqual(r, { prosecdef: false, a: false, u: false, s: true });
  await f.db.exec("set role anon");
  await assert.rejects(f.derive(), /permission denied/);
  await f.db.exec("reset role");
});

test("SQL reversal rechecks current entity authority and active organization membership", async (t) => {
  const f = await setup(t);
  await f.rpc("set_books_legal_entity_member", [
    base.org,
    base.entity,
    base.maker,
    base.reviewer,
    "manage",
    base.notes,
  ]);
  await f.rpc("set_books_legal_entity_member", [
    base.org,
    base.entity,
    base.reviewer,
    base.maker,
    "revoked",
    base.notes,
  ]);
  await assert.rejects(f.derive(), /access/);
  await f.rpc("set_books_legal_entity_member", [
    base.org,
    base.entity,
    base.reviewer,
    base.maker,
    "prepare",
    base.notes,
  ]);
  await f.db.exec(
    `update memberships set status='inactive' where org_id='${base.org}' and user_id='${base.maker}'`,
  );
  await assert.rejects(f.derive(), /access|membership/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
});
