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
const {
  readProjectOwnerRecovery: read,
  persistProjectOwnerRecovery: save,
  acknowledgeProjectOwnerRecovery: ack,
  submitProjectOwnerRecovery: submit,
} = require("../lib/services/books/project-owner-recovery");
function storage() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
    data,
  };
}
function locks() {
  let tail = Promise.resolve();
  return {
    request(_key, fn) {
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    },
  };
}
async function fixture(t) {
  const f = await setup(t),
    scope = { orgId: org, actorId: maker, projectId: id(70) },
    record = {
      version: 1,
      kind: "prepare",
      request: {
        expectedOrgId: org,
        expectedActorId: maker,
        projectId: id(70),
        entityId: entity,
        id: id(90),
        profileId: id(20),
        effectiveOn: "2026-01-01",
        evidence: f.decision,
        notes,
      },
    };
  return { ...f, scope, record, storage: storage(), locks: locks() };
}
test("save-before-send preserves exact uncertain request through reload, then actual original receipt clears it", async (t) => {
  const f = await fixture(t);
  let receipt;
  await assert.rejects(
    submit({
      ...f,
      transport: async (r) => {
        assert.deepEqual(read(f.storage, f.scope), r);
        receipt = await f.prepare();
        throw Error("Lost response");
      },
    }),
    /Lost response/,
  );
  assert.deepEqual(read(f.storage, f.scope), f.record);
  await submit({
    ...f,
    transport: async (r) => {
      assert.equal(r.request.id, id(90));
      return { success: true, receipt: (await f.prepare()).proposal };
    },
  });
  assert.equal(read(f.storage, f.scope), null);
  assert.deepEqual(receipt, await f.prepare());
});
test("storage failure or unsupported locks cannot send a request; corrupt and foreign-scope records cannot be reused", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const transport = async () => {
    calls++;
    throw Error("Unexpected");
  };
  await assert.rejects(
    submit({ ...f, locks: undefined, transport }),
    /cannot safely/,
  );
  await assert.rejects(
    submit({
      ...f,
      storage: {
        ...f.storage,
        setItem() {
          throw Error("Storage blocked");
        },
      },
      transport,
    }),
    /Storage blocked/,
  );
  assert.equal(calls, 0);
  for (const change of [
    { expectedOrgId: id(9) },
    { expectedActorId: reviewer },
    { projectId: id(71) },
  ])
    assert.throws(
      () =>
        save(f.storage, f.scope, {
          ...f.record,
          request: { ...f.record.request, ...change },
        }),
      /another organization, actor or project/,
    );
  save(f.storage, f.scope, f.record);
  const key = [...f.storage.data.keys()][0];
  f.storage.data.set(key, "invalid JSON");
  assert.throws(() => read(f.storage, f.scope));
});
test("receipt scope/content mismatches never acknowledge or overwrite an unresolved preparation", async (t) => {
  const f = await fixture(t),
    p = (await f.prepare()).proposal;
  save(f.storage, f.scope, f.record);
  for (const bad of [
    { ...p, project_id: id(71) },
    { ...p, prepared_by: reviewer },
    { ...p, preparation_notes: notes + " altered" },
    { ...p, effective_on: "2026-02-01" },
  ])
    assert.throws(() => ack(f.storage, f.scope, f.record, bad), /differs/);
  assert.throws(
    () =>
      save(f.storage, f.scope, {
        ...f.record,
        request: { ...f.record.request, id: id(91) },
      }),
    /Resolve the saved/,
  );
  assert.deepEqual(read(f.storage, f.scope), f.record);
});
test("cross-tab serialization preserves the first unknown request and refuses a conflicting second submission", async (t) => {
  const f = await fixture(t);
  let calls = 0,
    release;
  const waiting = new Promise((r) => (release = r));
  const first = submit({
    ...f,
    transport: async () => {
      calls++;
      await waiting;
      throw Error("Unknown response");
    },
  });
  await Promise.resolve();
  const second = submit({
    ...f,
    record: { ...f.record, request: { ...f.record.request, id: id(92) } },
    transport: async () => {
      calls++;
      throw Error("Must not send");
    },
  });
  release();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.equal(calls, 1);
  assert.deepEqual(read(f.storage, f.scope), f.record);
});
test("independent review recovery requires matching original review notes and proposal before acknowledging", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const receipt = (await f.review()).review,
    scope = { ...f.scope, actorId: reviewer },
    record = {
      version: 1,
      kind: "review",
      request: {
        expectedOrgId: org,
        expectedActorId: reviewer,
        projectId: id(70),
        entityId: entity,
        id: id(91),
        proposalId: id(90),
        notes,
      },
    };
  save(f.storage, scope, record);
  assert.throws(
    () =>
      ack(f.storage, scope, record, {
        ...receipt,
        review_notes: notes + " changed",
      }),
    /differs/,
  );
  ack(f.storage, scope, record, receipt);
  assert.equal(read(f.storage, scope), null);
});

test("resolution is saved before sending; lost cancellation response survives reload and replays exact original resolution", async (t) => {
  const f = await fixture(t);
  save(f.storage, f.scope, f.record);
  const {
    resolveProjectOwnerRecovery: resolve,
  } = require("../lib/services/books/project-owner-recovery");
  const decision = {
    id: id(500),
    reason: "Original supporting document is unavailable; cancel this request",
  };
  const transport = async (r) => ({
    success: true,
    receipt: await f.rpc("resolve_books_project_owner_request", [
      org,
      entity,
      id(70),
      maker,
      r.resolution.id,
      r.kind,
      JSON.stringify(r.request),
      r.resolution.reason,
    ]),
  });
  await assert.rejects(
    resolve({
      ...f,
      decision,
      transport: async (r) => {
        assert.deepEqual(read(f.storage, f.scope), r);
        await transport(r);
        throw Error("Lost cancellation response");
      },
    }),
    /Lost cancellation/,
  );
  const saved = read(f.storage, f.scope);
  assert.deepEqual(saved.resolution, decision);
  await assert.rejects(
    submit({
      ...f,
      record: saved,
      transport: async () => {
        throw Error("Must not resend writer");
      },
    }),
    /Recover the saved resolution/,
  );
  await assert.rejects(
    resolve({
      ...f,
      record: saved,
      decision: { ...decision, id: id(501) },
      transport,
    }),
    /original saved resolution/,
  );
  const receipt = await resolve({ ...f, record: saved, decision, transport });
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(read(f.storage, f.scope), null);
  await assert.rejects(f.prepare(), /cancelled/);
});
test("resolution storage failures send nothing and forged cancellation content keeps the saved decision", async (t) => {
  const f = await fixture(t);
  save(f.storage, f.scope, f.record);
  const {
    resolveProjectOwnerRecovery: resolve,
  } = require("../lib/services/books/project-owner-recovery");
  const decision = {
    id: id(500),
    reason: "Original supporting documents are invalid for this request",
  };
  let calls = 0;
  await assert.rejects(
    resolve({
      ...f,
      decision,
      storage: {
        ...f.storage,
        setItem() {
          throw Error("Storage failed");
        },
      },
      transport: async () => {
        calls++;
        throw Error("Unexpected");
      },
    }),
    /Storage failed/,
  );
  assert.equal(calls, 0);
  const actual = await f.rpc("resolve_books_project_owner_request", [
    org,
    entity,
    id(70),
    maker,
    decision.id,
    "prepare",
    JSON.stringify(f.record.request),
    decision.reason,
  ]);
  await assert.rejects(
    resolve({
      ...f,
      decision,
      transport: async () => ({
        success: true,
        receipt: {
          ...actual,
          resolution: {
            ...actual.resolution,
            reason: "Different cancellation explanation",
          },
        },
      }),
    }),
    /receipt differs/,
  );
  assert.deepEqual(read(f.storage, f.scope).resolution, decision);
});
test("uncertain committed preparation resolves by original receipt instead of canceling ownership", async (t) => {
  const f = await fixture(t),
    original = await f.prepare();
  save(f.storage, f.scope, f.record);
  const {
    resolveProjectOwnerRecovery: resolve,
  } = require("../lib/services/books/project-owner-recovery");
  const result = await resolve({
    ...f,
    decision: {
      id: id(500),
      reason: "Recover exact original outcome before another request",
    },
    transport: async (r) => ({
      success: true,
      receipt: await f.rpc("resolve_books_project_owner_request", [
        org,
        entity,
        id(70),
        maker,
        r.resolution.id,
        r.kind,
        JSON.stringify(r.request),
        r.resolution.reason,
      ]),
    }),
  });
  assert.equal(result.outcome, "committed_original");
  assert.deepEqual(result.proposal, original.proposal);
  assert.equal(read(f.storage, f.scope), null);
});
