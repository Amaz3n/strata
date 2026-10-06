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
} = require("./fixtures/books-native-invoice-income-database");
const api = require("../lib/services/books/native-invoice-income-recovery");
const money = require("../lib/services/books/native-invoice-recovery");
const scope = {
  orgId: org,
  actorId: maker,
  entityId: entity,
  projectId: id(70),
  invoiceId: id(100),
};
function store() {
  const data = new Map();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
}
function locks() {
  let tail = Promise.resolve();
  return {
    request(name, fn) {
      assert.equal(name, money.nativeInvoiceRecoveryKey(scope));
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
    record: { version: 1, request: f.incomeRequest },
  };
}
const transport = (f) => async (r) => ({
  success: true,
  data: await f.selectIncome(r.request),
});
const resolutionTransport = (f) => async (r) => ({
  success: true,
  data: await f.resolveIncome(r.request, r.resolution.id, r.resolution.reason),
});
test("coding original intent persists before SQL; lost commit survives reload and recovers without reapplying later prices", async (t) => {
  const f = await fixture(t),
    input = { scope, storage: f.storage, locks: f.locks, record: f.record };
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      transport: async (r) => {
        assert.deepEqual(
          api.readNativeInvoiceIncomeRecovery(f.storage, scope),
          r,
        );
        await f.selectIncome(r.request);
        throw Error("Lost actual coding commit response");
      },
    }),
    /Lost/,
  );
  const saved = api.readNativeInvoiceIncomeRecovery(f.storage, scope);
  await f.db.query(
    "update invoice_lines set unit_price_cents=12000 where id=$1",
    [id(602)],
  );
  const result = await api.submitNativeInvoiceIncomeRecovery({
    ...input,
    record: saved,
    transport: transport(f),
  });
  assert.equal(result.created, false);
  assert.equal(api.readNativeInvoiceIncomeRecovery(f.storage, scope), null);
  assert.equal(
    (
      await f.db.query(
        "select unit_price_cents from invoice_lines where id=$1",
        [id(602)],
      )
    ).rows[0].unit_price_cents,
    12000,
  );
  const terminal = JSON.parse(
    f.storage.getItem(
      money.nativeInvoiceIncomeRecoveryKey(scope) + ":outcome:" + id(900),
    ),
  );
  assert.equal(terminal.outcome, "committed_original");
  assert.equal(terminal.ledgerActivated, false);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_income_selections",
      )
    ).rows[0].n,
    1,
  );
});
test("lost cancellation retains original resolution decision, fences coding, and clears only a verified retry", async (t) => {
  const f = await fixture(t),
    input = { scope, storage: f.storage, locks: f.locks, record: f.record };
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      transport: async () => {
        throw Error("Transport never reached SQL");
      },
    }),
  );
  const decision = { id: id(950), reason: notes };
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      decision,
      transport: async (r) => {
        assert.deepEqual(
          api.readNativeInvoiceIncomeRecovery(f.storage, scope).resolution,
          decision,
        );
        await f.resolveIncome(r.request, r.resolution.id, r.resolution.reason);
        throw Error("Lost cancellation reply");
      },
    }),
    /Lost/,
  );
  const saved = api.readNativeInvoiceIncomeRecovery(f.storage, scope);
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      record: saved,
      transport: transport(f),
    }),
    /saved income resolution/,
  );
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      record: saved,
      decision: { ...decision, id: id(951) },
      transport: resolutionTransport(f),
    }),
    /original income resolution/,
  );
  const result = await api.submitNativeInvoiceIncomeRecovery({
    ...input,
    record: saved,
    decision,
    transport: resolutionTransport(f),
  });
  assert.equal(result.outcome, "cancelled");
  assert.equal(api.readNativeInvoiceIncomeRecovery(f.storage, scope), null);
  await assert.rejects(f.selectIncome(), /cancelled/);
});
test("quota, missing coordination, corrupt scope and forged coding/cancellation evidence keep intent recoverable", async (t) => {
  const f = await fixture(t),
    input = { scope, storage: f.storage, locks: f.locks, record: f.record };
  let calls = 0;
  const send = async (r) => {
    calls++;
    return transport(f)(r);
  };
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      storage: { ...f.storage, setItem() {} },
      transport: send,
    }),
    /could not be saved/,
  );
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      locks: undefined,
      transport: send,
    }),
    /coordinate/,
  );
  assert.equal(calls, 0);
  const key = money.nativeInvoiceIncomeRecoveryKey(scope);
  f.storage.setItem(key, "broken");
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({ ...input, transport: send }),
  );
  f.storage.removeItem(key);
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      scope: { ...scope, actorId: id(999) },
      locks: { request: (_, fn) => fn() },
      transport: send,
    }),
    /another scope/,
  );
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      transport: async (r) => {
        const result = await f.selectIncome(r.request),
          e = JSON.parse(result.selection.result_text);
        e.lines.find((l) => l.source.id === id(602)).source.unit_price_cents++;
        result.selection.result_text = JSON.stringify(e);
        result.selection.result_sha256 = require("node:crypto")
          .createHash("sha256")
          .update(result.selection.result_text)
          .digest("hex");
        return { success: true, data: result };
      },
    }),
    /unrelated source/,
  );
  assert.deepEqual(
    api.readNativeInvoiceIncomeRecovery(f.storage, scope),
    f.record,
  );
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      storage: {
        ...f.storage,
        setItem(k, v) {
          if (k.includes(":outcome:")) throw Error("Terminal quota");
          f.storage.setItem(k, v);
        },
      },
      transport: transport(f),
    }),
    /Terminal quota/,
  );
  assert.deepEqual(
    api.readNativeInvoiceIncomeRecovery(f.storage, scope),
    f.record,
  );
  const g = await fixture(t),
    base = { scope, storage: g.storage, locks: g.locks, record: g.record };
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...base,
      transport: async () => {
        throw Error("Offline");
      },
    }),
  );
  const decision = { id: id(950), reason: notes };
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...base,
      decision,
      transport: async (r) => {
        const data = await g.resolveIncome(
          r.request,
          r.resolution.id,
          r.resolution.reason,
        );
        data.resolution.reason = notes + " forged";
        return { success: true, data };
      },
    }),
    /saved decision/,
  );
  assert.deepEqual(
    api.readNativeInvoiceIncomeRecovery(g.storage, scope).resolution,
    decision,
  );
});
test("shared invoice lock prevents posting over an unresolved coding intent and coding over saved money", async (t) => {
  const f = await fixture(t),
    input = { scope, storage: f.storage, locks: f.locks, record: f.record };
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      ...input,
      transport: async () => {
        throw Error("Offline coding");
      },
    }),
  );
  let calls = 0;
  await assert.rejects(
    money.submitNativeInvoiceRecovery({
      storage: f.storage,
      scope,
      locks: f.locks,
      record: { version: 1, request: f.resolutionRequest },
      transport: async () => {
        calls++;
        throw Error("Unreachable");
      },
    }),
    /saved income selection/,
  );
  assert.equal(calls, 0);
  const g = await fixture(t);
  money.persistNativeInvoiceRecovery(g.storage, scope, {
    version: 1,
    request: g.resolutionRequest,
  });
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({
      scope,
      storage: g.storage,
      locks: g.locks,
      record: g.record,
      transport: async () => {
        calls++;
        throw Error("Unreachable");
      },
    }),
    /saved invoice posting/,
  );
  assert.equal(calls, 0);
});
test("a competing posting waits for coding transport and then observes its retained uncertain intent", async (t) => {
  const f = await fixture(t);
  let entered,
    release,
    calls = 0;
  const started = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  const coding = api.submitNativeInvoiceIncomeRecovery({
    scope,
    storage: f.storage,
    locks: f.locks,
    record: f.record,
    transport: async (r) => {
      await f.selectIncome(r.request);
      entered();
      await gate;
      throw Error("Lost concurrent coding reply");
    },
  });
  const failedCoding = assert.rejects(coding, /Lost concurrent/);
  await started;
  const posting = money.submitNativeInvoiceRecovery({
    scope,
    storage: f.storage,
    locks: f.locks,
    record: { version: 1, request: f.resolutionRequest },
    transport: async () => {
      calls++;
      throw Error("Unreachable");
    },
  });
  const blockedPosting = assert.rejects(posting, /saved income selection/);
  assert.equal(calls, 0);
  release();
  await failedCoding;
  await blockedPosting;
  assert.equal(calls, 0);
  assert.deepEqual(
    api.readNativeInvoiceIncomeRecovery(f.storage, scope),
    f.record,
  );
});
test("maximum supported original request leaves room for a durable resolution decision", async (t) => {
  const f = await fixture(t),
    record = structuredClone(f.record);
  record.request.economic.lines[0].source.metadata = { padding: "" };
  const base = Buffer.byteLength(JSON.stringify(record.request));
  record.request.economic.lines[0].source.metadata.padding = "x".repeat(
    8400000 - base,
  );
  assert.equal(Buffer.byteLength(JSON.stringify(record.request)), 8400000);
  const input = {
    scope,
    storage: f.storage,
    locks: f.locks,
    record,
    transport: async () => {
      throw Error("Offline budget fixture; no SQL");
    },
  };
  await assert.rejects(api.submitNativeInvoiceIncomeRecovery(input), /Offline/);
  const decision = { id: id(950), reason: "x".repeat(2000) };
  await assert.rejects(
    api.submitNativeInvoiceIncomeRecovery({ ...input, decision }),
    /Offline/,
  );
  assert.deepEqual(
    api.readNativeInvoiceIncomeRecovery(f.storage, scope).resolution,
    decision,
  );
});
