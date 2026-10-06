require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  org,
  maker,
  entity,
  id,
  notes,
} = require("./fixtures/books-native-invoice-resolution-database");
const api = require("../lib/services/books/native-invoice-recovery");
const scope = {
  orgId: org,
  actorId: maker,
  entityId: entity,
  projectId: id(70),
  invoiceId: id(100),
};
function store() {
  const map = new Map();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}
function locks() {
  let tail = Promise.resolve();
  return {
    request(name, fn) {
      assert.equal(name, api.nativeInvoiceRecoveryKey(scope));
      const job = tail.then(fn);
      tail = job.catch(() => {});
      return job;
    },
  };
}
async function fixture(t) {
  const f = await setup(t);
  return {
    ...f,
    storage: store(),
    locks: locks(),
    record: { version: 1, request: f.resolutionRequest },
  };
}
async function post(f, r) {
  const q = r.request;
  return {
    success: true,
    data: await f.post({
      id: q.id,
      entry: q.entryId,
      economic: q.economic,
      notes: q.notes,
    }),
  };
}
async function resolve(f, r) {
  return {
    success: true,
    data: await f.resolve({
      id: r.resolution.id,
      request: r.request,
      reason: r.resolution.reason,
    }),
  };
}
test("exact native request is durable before money; lost committed response survives reload and recovers without duplicate source journal", async (t) => {
  const f = await fixture(t),
    input = { storage: f.storage, scope, record: f.record, locks: f.locks };
  await assert.rejects(
    api.submitNativeInvoiceRecovery({
      ...input,
      transport: async (r) => {
        assert.deepEqual(api.readNativeInvoiceRecovery(f.storage, scope), r);
        await post(f, r);
        throw Error("Lost committed response");
      },
    }),
    /Lost/,
  );
  const saved = api.readNativeInvoiceRecovery(f.storage, scope);
  assert.deepEqual(saved, f.record);
  await f.db.exec(
    "update invoices set status='paid';update accounting_policies set status='superseded'",
  );
  const r = await api.submitNativeInvoiceRecovery({
    ...input,
    record: saved,
    transport: (r) => post(f, r),
  });
  assert.equal(r.created, false);
  assert.equal(r.posting.id, id(700));
  assert.equal(api.readNativeInvoiceRecovery(f.storage, scope), null);
  const terminal = JSON.parse(
    f.storage.getItem(
      api.nativeInvoiceRecoveryKey(scope) + ":outcome:" + id(700),
    ),
  );
  assert.equal(terminal.outcome, "committed_original");
  assert.equal(terminal.ledgerActivated, false);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
});
test("storage or browser coordination failure prevents submission and corrupt or foreign saved requests block new money", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const transport = async (r) => {
    calls++;
    return post(f, r);
  };
  const input = { scope, record: f.record, locks: f.locks, transport };
  await assert.rejects(
    api.submitNativeInvoiceRecovery({
      ...input,
      storage: {
        ...f.storage,
        setItem() {
          throw Error("Quota exhausted");
        },
      },
    }),
    /Quota/,
  );
  await assert.rejects(
    api.submitNativeInvoiceRecovery({
      ...input,
      storage: { ...f.storage, setItem() {} },
    }),
    /could not be saved/,
  );
  await assert.rejects(
    api.submitNativeInvoiceRecovery({
      ...input,
      storage: f.storage,
      locks: undefined,
    }),
    /safely submit/,
  );
  const key = api.nativeInvoiceRecoveryKey(scope);
  f.storage.setItem(key, "{bad");
  await assert.rejects(
    api.submitNativeInvoiceRecovery({ ...input, storage: f.storage }),
  );
  f.storage.setItem(
    key,
    JSON.stringify({
      ...f.record,
      request: { ...f.record.request, expectedActorId: id(999) },
    }),
  );
  assert.throws(() => api.readNativeInvoiceRecovery(f.storage, scope));
  assert.equal(calls, 0);
  f.storage.setItem(key, JSON.stringify(f.record));
  assert.throws(
    () =>
      api.readNativeInvoiceRecovery(f.storage, { ...scope, projectId: id(71) }),
    /project/,
  );
  assert.equal(
    api.readNativeInvoiceRecovery(f.storage, { ...scope, actorId: id(999) }),
    null,
  );
});
test("lost cancellation response retains exact resolution identity and forbids original submission until its receipt is verified", async (t) => {
  const f = await fixture(t);
  api.persistNativeInvoiceRecovery(f.storage, scope, f.record);
  const decision = { id: id(740), reason: notes },
    input = {
      storage: f.storage,
      scope,
      record: f.record,
      decision,
      locks: f.locks,
    };
  await assert.rejects(
    api.resolveNativeInvoiceRecovery({
      ...input,
      transport: async (r) => {
        assert.equal(
          api.readNativeInvoiceRecovery(f.storage, scope).resolution.id,
          id(740),
        );
        await resolve(f, r);
        throw Error("Lost cancellation response");
      },
    }),
    /Lost/,
  );
  const saved = api.readNativeInvoiceRecovery(f.storage, scope);
  assert.deepEqual(saved.resolution, decision);
  await assert.rejects(
    api.submitNativeInvoiceRecovery({
      storage: f.storage,
      scope,
      record: saved,
      locks: f.locks,
      transport: (r) => post(f, r),
    }),
    /saved resolution/,
  );
  await assert.rejects(
    api.resolveNativeInvoiceRecovery({
      ...input,
      record: saved,
      decision: { ...decision, id: id(741) },
      transport: (r) => resolve(f, r),
    }),
    /changing/,
  );
  assert.equal(
    (
      await api.resolveNativeInvoiceRecovery({
        ...input,
        record: saved,
        transport: (r) => resolve(f, r),
      })
    ).outcome,
    "cancelled",
  );
  assert.equal(api.readNativeInvoiceRecovery(f.storage, scope), null);
  await assert.rejects(f.post(), /cancelled/);
});
test("forged response, orphan/missing detail and failed confirmation persistence leave the exact request recoverable", async (t) => {
  const f = await fixture(t),
    input = { storage: f.storage, scope, record: f.record, locks: f.locks };
  const actual = (await post(f, f.record)).data;
  for (const change of [
    (r) => ({ ...r, posting: null, entry: null, lines: [], posted: false }),
    (r) => ({ ...r, lines: r.lines.slice(1) }),
    (r) => ({ ...r, entry: { ...r.entry, total_cents: 1 } }),
    (r) => ({ ...r, posting: { ...r.posting, id: id(799) } }),
    (r) => ({
      ...r,
      posting: { ...r.posting, request_sha256: "a".repeat(64) },
    }),
  ]) {
    await assert.rejects(
      api.submitNativeInvoiceRecovery({
        ...input,
        transport: async () => ({ success: true, data: change(actual) }),
      }),
    );
    assert.deepEqual(api.readNativeInvoiceRecovery(f.storage, scope), f.record);
  }
  const failOutcome = {
    ...f.storage,
    setItem(k, v) {
      if (k.includes(":outcome:")) throw Error("Confirmation quota");
      f.storage.setItem(k, v);
    },
  };
  await assert.rejects(
    api.submitNativeInvoiceRecovery({
      ...input,
      storage: failOutcome,
      transport: (r) => post(f, r),
    }),
    /Confirmation quota/,
  );
  assert.deepEqual(api.readNativeInvoiceRecovery(f.storage, scope), f.record);
  const failRemoval = { ...f.storage, removeItem() {} };
  await assert.rejects(
    api.submitNativeInvoiceRecovery({
      ...input,
      storage: failRemoval,
      transport: (r) => post(f, r),
    }),
    /acknowledgement failed/,
  );
  assert.deepEqual(api.readNativeInvoiceRecovery(f.storage, scope), f.record);
  assert.ok(
    f.storage.getItem(
      api.nativeInvoiceRecoveryKey(scope) + ":outcome:" + id(700),
    ),
  );
});
test("cross-tab serialization prevents a competing new intent replacing an uncertain request and resolution recovers committed original money", async (t) => {
  const f = await fixture(t),
    input = { storage: f.storage, scope, locks: f.locks };
  let release;
  const pause = new Promise((r) => (release = r));
  const first = api.submitNativeInvoiceRecovery({
    ...input,
    record: f.record,
    transport: async (r) => {
      await post(f, r);
      await pause;
      throw Error("Lost response");
    },
  });
  const firstRejected = assert.rejects(first, /Lost/);
  const other = {
    ...f.record,
    request: { ...f.record.request, id: id(702), entryId: id(703) },
  };
  let calls = 0;
  const second = api.submitNativeInvoiceRecovery({
    ...input,
    record: other,
    transport: async (r) => {
      calls++;
      return post(f, r);
    },
  });
  const secondRejected = assert.rejects(second, /Resolve the saved/);
  release();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(calls, 0);
  const saved = api.readNativeInvoiceRecovery(f.storage, scope);
  const result = await api.resolveNativeInvoiceRecovery({
    ...input,
    record: saved,
    decision: { id: id(740), reason: notes },
    transport: (r) => resolve(f, r),
  });
  assert.equal(result.outcome, "committed_original");
  assert.equal(api.readNativeInvoiceRecovery(f.storage, scope), null);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
});
