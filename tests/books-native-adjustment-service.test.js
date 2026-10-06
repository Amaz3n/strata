require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./fixtures/books-native-adjustment-database");
async function harness(t) {
  const f = await setup(t),
    state = { actor: maker, deny: null, calls: [], forge: null };
  const service = {
    async rpc(name, args) {
      state.calls.push("rpc");
      try {
        let data = await f.rpc(name, Object.values(args));
        if (state.forge) data = state.forge(data);
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  const target = require.resolve("../lib/services/books/native-adjustments"),
    old = Module._load;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (args[0]?.filename === target && name === "./module")
        return {
          requireBooksWorkspaceEnabled: async () => ({
            orgId: org,
            userId: state.actor,
            supabase: {},
          }),
        };
      if (args[0]?.filename === target && name === "./access")
        return {
          requireBooksAuthorization: async (i) => {
            state.calls.push(i.permission);
            if (state.deny === "books") throw Error("Books denied");
          },
        };
      if (name === "@/lib/services/authorization")
        return {
          requireAuthorization: async (i) => {
            state.calls.push(i.permission);
            assert.equal(i.projectId, id(70));
            if (state.deny === "project") throw Error("Project denied");
          },
        };
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      return old.call(this, name, ...args);
    };
    delete require.cache[target];
    api = require(target);
  } finally {
    Module._load = old;
  }
  const prep = (v = {}) =>
    api.prepareNativeProjectAdjustment({
      expectedOrgId: org,
      expectedActorId: maker,
      id: id(200),
      request: f.request,
      notes,
      ...v,
    });
  const review = (v = {}) =>
    api.reviewNativeProjectAdjustment({
      expectedOrgId: org,
      expectedActorId: reviewer,
      entityId: entity,
      projectId: id(70),
      factId: id(200),
      id: id(201),
      entryId: id(202),
      decision: "approve",
      notes,
      ...v,
    });
  const read = () =>
    api.readNativeProjectAdjustment({
      expectedOrgId: org,
      expectedActorId: state.actor,
      entityId: entity,
      projectId: id(70),
      factId: id(200),
    });
  return { ...f, state, api, prep, review, read };
}
test("native adjustment services enforce actor, Books adjustment and actual project read before private money; scoped detail uses Books read", async (t) => {
  const f = await harness(t);
  await assert.rejects(f.prep({ expectedOrgId: id(9) }));
  await assert.rejects(f.prep({ expectedActorId: reviewer }));
  assert.ok(!f.state.calls.includes("rpc"));
  for (const deny of ["books", "project"]) {
    f.state.calls = [];
    f.state.deny = deny;
    await assert.rejects(f.prep());
    assert.ok(!f.state.calls.includes("rpc"));
  }
  f.state.deny = null;
  f.state.calls = [];
  await f.prep();
  assert.deepEqual(f.state.calls, ["books.adjust", "project.read", "rpc"]);
  f.state.actor = reviewer;
  const r = await f.review();
  assert.equal(r.posted, true);
  assert.deepEqual(await f.review(), { ...r, created: false });
  f.state.calls = [];
  const d = await f.read();
  assert.equal(d.entry.id, id(202));
  assert.deepEqual(f.state.calls, ["books.read", "project.read", "rpc"]);
});
test("native services validate returned monetary receipts and recover exact preparation despite later operational amount changes", async (t) => {
  const f = await harness(t),
    p = await f.prep();
  await f.db.exec(
    "alter table invoices add column changed_amount integer;update invoices set changed_amount=999",
  );
  assert.deepEqual(await f.prep(), p);
  f.state.actor = reviewer;
  await assert.rejects(f.review(), /snapshot changed/);
  const rejected = await f.review({ decision: "reject", entryId: null });
  assert.equal(rejected.posted, false);
  f.state.forge = (d) => ({ ...d, actorId: maker });
  await assert.rejects(f.read(), /scope/);
});
test("native service rejects forged legs after original SQL approval and respects revoked entity rights on committed retry", async (t) => {
  const f = await harness(t);
  await f.prep();
  f.state.actor = reviewer;
  f.state.forge = (d) => ({
    ...d,
    lines: d.lines.map((l, i) =>
      i === 0 ? { ...l, debit_cents: l.debit_cents + 1 } : l,
    ),
  });
  await assert.rejects(f.review(), /leg differs/);
  f.state.forge = null;
  assert.equal((await f.review()).created, false);
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    maker,
    reviewer,
    "revoked",
    notes,
  ]);
  await assert.rejects(f.review(), /review access/);
});
