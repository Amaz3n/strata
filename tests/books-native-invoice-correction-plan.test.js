require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  setup,
  id,
  notes,
} = require("./fixtures/books-native-invoice-posting-database");
const {
  buildNativeInvoiceReversalPlan: reverse,
} = require("../lib/services/books/native-invoice-correction-plan");

test("native invoice reversal derives every original SQL journal leg and retains immutable provenance", async (t) => {
  const f = await setup(t),
    receipt = await f.post();
  const economic = await f.economic({ date: "2026-04-16" });
  const request = {
    id: id(960),
    context: economic.native,
    original: {
      posting: receipt.posting,
      entry: receipt.entry,
      lines: receipt.lines,
    },
    notes,
  };
  const r = reverse(request);
  assert.deepEqual(
    r.plan.lines.map((l) => [
      l.accountId,
      l.debitCents,
      l.creditCents,
      l.dimensions,
    ]),
    receipt.lines.map((l) => [
      l.account_id,
      l.credit_cents,
      l.debit_cents,
      l.dimensions,
    ]),
  );
  assert.equal(r.plan.entryKind, "reversal");
  assert.equal(r.plan.entryDate, "2026-04-16");
  assert.equal(r.plan.totalCents, receipt.entry.total_cents);
  assert.deepEqual(
    r.provenance.originalLegIds,
    receipt.lines.map((l) => l.id),
  );
  assert.equal(r.provenance.originalEntryId, receipt.entry.id);
  assert.equal(r.posted, false);
  assert.equal(r.reviewed, false);
  assert.equal(r.sourceChanged, false);
  assert.equal(r.ledgerActivated, false);
  assert.deepEqual(reverse(request), r);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );

  await t.test(
    "mutable current source amounts cannot change original reversal money",
    () => {
      const q = structuredClone(request);
      q.context.source.total_cents = 999999;
      assert.deepEqual(reverse(q).plan.lines, r.plan.lines);
      // Returned dimension objects do not share mutable source receipt state.
      r.plan.lines[0].dimensions.futureMutation = true;
      assert.equal(receipt.lines[0].dimensions.futureMutation, undefined);
    },
  );
  await t.test("missing, extra, reordered or forged original legs fail", () => {
    for (const edit of [
      (q) => q.original.lines.pop(),
      (q) => q.original.lines.push(q.original.lines[0]),
      (q) => q.original.lines.reverse(),
      (q) => {
        q.original.lines[0].account_id = id(999);
      },
      (q) => {
        q.original.lines[0].dimensions.cost_code_id = id(999);
      },
      (q) => {
        q.original.lines[0].debit_cents++;
      },
    ]) {
      const q = structuredClone(request);
      edit(q);
      assert.throws(() => reverse(q), /inventory|leg|journal/);
    }
  });
  await t.test(
    "foreign source, entity, backdate, stale capture and reused identity fail",
    () => {
      for (const edit of [
        (q) => {
          q.context.sourceId = id(999);
        },
        (q) => {
          q.context.owner.legal_entity_id = id(999);
        },
        (q) => {
          q.context.entryDate = "2026-04-14";
        },
        (q) => {
          q.context.capturedAt = "2020-01-01T00:00:00Z";
        },
        (q) => {
          q.id = receipt.entry.id;
        },
        (q) => {
          q.id = receipt.posting.id;
        },
      ]) {
        const q = structuredClone(request);
        edit(q);
        assert.throws(() => reverse(q), /scope|chronology|identity/);
      }
    },
  );
  await t.test(
    "renamed codes preserve account IDs, while replacement identities and reclassification fail",
    () => {
      const q = structuredClone(request),
        definition = JSON.parse(q.context.chart.definition_text);
      const account = q.context.accounts.find(
        (a) => a.id === receipt.lines[0].account_id,
      );
      const oldCode = account.code,
        newCode = "1199";
      account.code = newCode;
      for (const a of definition.accounts) {
        if (a.code === oldCode) a.code = newCode;
        if (a.parent_code === oldCode) a.parent_code = newCode;
      }
      for (const role of Object.keys(definition.controls))
        if (definition.controls[role] === oldCode)
          definition.controls[role] = newCode;
      q.context.chart.definition_text = JSON.stringify(definition);
      q.context.chart.definition_sha256 = createHash("sha256")
        .update(q.context.chart.definition_text)
        .digest("hex");
      assert.equal(
        reverse(q).plan.lines[0].accountId,
        receipt.lines[0].account_id,
      );
      assert.equal(reverse(q).plan.lines[0].accountCode, newCode);
      account.id = id(999);
      assert.throws(() => reverse(q), /absent/);
      const changed = structuredClone(request);
      changed.context.accounts.find(
        (a) => a.id === receipt.lines[0].account_id,
      ).definition.normal_balance = "credit";
      assert.throws(() => reverse(changed), /classification/);
    },
  );
  await t.test(
    "caller-supplied partial credit legs cannot masquerade as a full reversal",
    () => {
      assert.throws(
        () => reverse({ ...request, lines: [] }),
        /unrecognized_keys/,
      );
    },
  );
});
