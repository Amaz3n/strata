require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const { fixture, id } = require("./fixtures/books-journal-resolution-database");
test("absent preparation can be cancelled exactly; late original packets are fenced while a fresh identity remains usable", async (t) => {
  const f = await fixture(t),
    r = await f.resolve("prepare", f.prep);
  assert.equal(r.resolution, "cancelled_preparation");
  assert.equal(r.created, true);
  assert.equal((await f.resolve("prepare", f.prep)).created, false);
  await assert.rejects(
    f.resolve("prepare", f.prep, { reason: "Changed decision" }),
    /retry differs/,
  );
  await assert.rejects(f.prepare(), /was cancelled/);
  assert.equal(
    (await f.db.query("select count(*)::int n from books_journal_proposals"))
      .rows[0].n,
    0,
  );
  assert.equal((await f.prepare({ intent: id(11) })).created, true);
  await assert.rejects(
    f.db.exec("delete from books_journal_request_resolutions"),
    /immutable|cannot|mutation|append-only/i,
  );
});
test("committed preparation cannot be mislabeled uncommitted or lose its original receipt", async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  await assert.rejects(f.resolve("prepare", f.prep), /already committed/);
  assert.equal((await f.prepare()).id, p.id);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_journal_request_resolutions",
      )
    ).rows[0].n,
    0,
  );
});
test("cancelled pending review rolls back both money and the proposal transition; a separately described review can proceed", async (t) => {
  const f = await fixture(t),
    p = await f.prepare(),
    r = await f.resolve("review", f.req(p.id));
  assert.equal(r.resolution, "cancelled_review");
  await assert.rejects(f.review(p.id), /was cancelled/);
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    0,
  );
  assert.equal(
    (await f.db.query("select status from books_journal_proposals")).rows[0]
      .status,
    "pending",
  );
  await f.db.query(
    "select review_books_journal_proposal_atomic($1,$2,$3,'approve','Reviewed updated evidence')",
    [id(1), p.id, id(7)],
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    1,
  );
});
test("resolved review acknowledgement retains original or superseding independent decision and money references without writing more money", async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  await f.review(p.id);
  const r = await f.resolve("review", f.req(p.id));
  assert.equal(r.resolution, "acknowledged_original_review");
  assert.equal(r.observedProposalId, p.id);
  assert.ok(r.observedReview.journalEntryId);
  assert.equal((await f.resolve("review", f.req(p.id))).created, false);
  const changed = {
    ...f.req(p.id),
    decision: "reject",
    note: "Original request now superseded",
  };
  const other = await f.resolve("review", changed, { key: id(51) });
  assert.equal(other.resolution, "acknowledged_superseded_review");
  assert.equal(
    other.observedReview.journalEntryId,
    r.observedReview.journalEntryId,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    1,
  );
});
test("resolution guards enforce scope/current membership, capture exact immutable rows in the scoped snapshot, and keep browser access private", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.resolve("prepare", { ...f.prep, expectedOrgId: id(9) }),
    /another organization/,
  );
  await assert.rejects(
    f.resolve("prepare", f.prep, { actor: id(8) }),
    /membership/,
  );
  const r = await f.resolve("prepare", f.prep);
  const snap = (
    await f.db.query("select capture_books_export_snapshot($1) s", [id(1)])
  ).rows[0].s;
  assert.equal(snap.tables.books_journal_request_resolutions[0].id, r.id);
  assert.equal(
    snap.tables.books_journal_request_resolutions[0].request_text,
    r.requestText,
  );
  const empty = (
    await f.db.query("select capture_books_export_snapshot($1) s", [id(9)])
  ).rows[0].s;
  assert.equal(empty.tables.books_journal_request_resolutions.length, 0);
  const acl = (
    await f.db.query(
      "select prosecdef,has_function_privilege('authenticated',oid,'execute') allowed from pg_proc where proname='resolve_books_journal_request_atomic'",
    )
  ).rows[0];
  assert.deepEqual(acl, { prosecdef: false, allowed: false });
});
test("schema20 business verification retains resolution/receipt closure and rejects checksum-recomputed money, scope and classification corruption", async (t) => {
  const f = await fixture(t),
    p = await f.prepare();
  await f.review(p.id);
  await f.resolve("review", f.req(p.id));
  const tables = {};
  for (const name of [
    "books_journal_request_resolutions",
    "books_journal_proposals",
    "journal_entries",
    "journal_lines",
  ])
    tables[name] = (
      await f.db.query("select to_jsonb(t) row from " + name + " t")
    ).rows.map((r) => r.row);
  const {
    verifyJournalResolutionArchive,
  } = require("../lib/services/books/journal-resolution-archive");
  assert.deepEqual(verifyJournalResolutionArchive(tables, id(1), 20), []);
  assert.ok(verifyJournalResolutionArchive(tables, id(1), 19).length);
  for (const corrupt of [
    (b) =>
      (b.books_journal_request_resolutions[0].resolution =
        "acknowledged_superseded_review"),
    (b) => (b.books_journal_request_resolutions[0].actor_id = id(8)),
    (b) =>
      (b.books_journal_request_resolutions[0].observed_review.journalEntryId =
        id(99)),
    (b) =>
      b.journal_lines.forEach((l) => {
        if (l.debit_cents) l.debit_cents += 1;
        if (l.credit_cents) l.credit_cents += 1;
      }),
    (b) => (b.journal_lines[0].dimensions = { basis: "Changed" }),
  ]) {
    const bad = structuredClone(tables);
    corrupt(bad);
    assert.ok(verifyJournalResolutionArchive(bad, id(1), 20).length);
  }
});
test("cancelled request archives detect later resurrection even with recomputed metadata and checksums", async (t) => {
  const f = await fixture(t);
  await f.resolve("prepare", f.prep);
  const tables = {
    books_journal_request_resolutions: (
      await f.db.query(
        "select to_jsonb(t) row from books_journal_request_resolutions t",
      )
    ).rows.map((r) => r.row),
    books_journal_proposals: [],
  };
  const {
    verifyJournalResolutionArchive,
  } = require("../lib/services/books/journal-resolution-archive");
  assert.deepEqual(verifyJournalResolutionArchive(tables, id(1), 20), []);
  tables.books_journal_proposals.push({
    id: id(99),
    org_id: id(1),
    proposed_by: id(2),
    posting_key: "adjustment-intent:" + id(10),
  });
  assert.ok(verifyJournalResolutionArchive(tables, id(1), 20).length);
});
test("actual permission-checked resolution service validates full original request receipt and expected scope before its RPC", async (t) => {
  const f = await fixture(t),
    Module = require("node:module"),
    filename = require.resolve("../lib/services/books/bookkeeping"),
    load = Module._load;
  let calls = 0,
    denied = false,
    forged = false,
    api;
  const service = {
    rpc: async (name, a) => {
      calls++;
      assert.equal(name, "resolve_books_journal_request_atomic");
      assert.equal(a.p_org, id(1));
      assert.equal(a.p_actor, id(2));
      const data = await f.resolve(a.p_kind, a.p_request, {
        org: a.p_org,
        actor: a.p_actor,
        key: a.p_id,
        reason: a.p_reason,
      });
      return {
        data: forged
          ? {
              ...data,
              requestText: JSON.stringify({
                ...f.prep,
                memo: "Changed original",
              }),
            }
          : data,
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
      return load.call(this, name, ...args);
    };
    delete require.cache[filename];
    api = require(filename);
  } finally {
    Module._load = load;
  }
  const input = {
    resolutionId: id(50),
    reason: "Original request no longer needed",
    record: { version: 1, kind: "prepare", request: f.prep },
  };
  denied = true;
  await assert.rejects(api.resolveJournalRecovery(input), /Books denied/);
  assert.equal(calls, 0);
  denied = false;
  await assert.rejects(
    api.resolveJournalRecovery({
      ...input,
      record: { ...input.record, request: { ...f.prep, expectedOrgId: id(9) } },
    }),
    /another organization/,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await api.resolveJournalRecovery(input)).resolution,
    "cancelled_preparation",
  );
  assert.equal((await api.resolveJournalRecovery(input)).created, false);
  forged = true;
  await assert.rejects(api.resolveJournalRecovery(input), /receipt differs/);
});
test("resolution retention accommodates UTF-8 bytes from a supported compact browser request without losing its original text", async (t) => {
  const f = await fixture(t),
    request = {
      ...f.prep,
      lines: f.prep.lines.map((l, i) =>
        i ? l : { ...l, description: "建".repeat(350000) },
      ),
    };
  const receipt = await f.resolve("prepare", request);
  assert.ok(Buffer.byteLength(receipt.requestText, "utf8") > 1048576);
  assert.equal(
    JSON.parse(receipt.requestText).lines[0].description.length,
    350000,
  );
  assert.equal(receipt.resolution, "cancelled_preparation");
});
