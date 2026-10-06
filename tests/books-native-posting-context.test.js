require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const {
  setup,
  id,
  org,
  maker,
  reviewer,
} = require("./fixtures/books-native-posting-database");
async function harness(t) {
  const f = await setup(t),
    state = {
      actor: maker,
      denied: null,
      calls: [],
      forge: null,
      afterRoot: null,
    };
  const user = {
    from(table) {
      assert.ok(
        ["invoices", "vendor_bills", "project_expenses"].includes(table),
      );
      const args = [];
      const q = {
        select() {
          return q;
        },
        eq(k, v) {
          args.push([k, v]);
          return q;
        },
        async maybeSingle() {
          state.calls.push("root");
          assert.deepEqual(
            args.map((a) => a[0]),
            ["org_id", "id"],
          );
          const r = await f.db.query(
            `select id,org_id,project_id from ${table} where org_id=$1 and id=$2`,
            args.map((a) => a[1]),
          );
          await state.afterRoot?.();
          return { data: r.rows[0] ?? null, error: null };
        },
      };
      return q;
    },
  };
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
  const target =
      require.resolve("../lib/services/books/native-posting-context"),
    old = Module._load;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (args[0]?.filename === target && name === "./module")
        return {
          requireBooksWorkspaceEnabled: async () => {
            state.calls.push("workspace");
            if (state.denied === "workspace") throw Error("Books disabled");
            return { orgId: org, userId: state.actor, supabase: user };
          },
        };
      if (args[0]?.filename === target && name === "./access")
        return {
          requireBooksAuthorization: async (i) => {
            state.calls.push(i.permission);
            if (state.denied === "books") throw Error("Books denied");
          },
        };
      if (name === "@/lib/services/authorization")
        return {
          requireAuthorization: async (i) => {
            state.calls.push(i.permission);
            assert.equal(i.projectId, id(70));
            if (state.denied === "project") throw Error("Project denied");
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
  const load = (v = {}) =>
    api.loadNativeProjectPostingContext({
      expectedOrgId: org,
      expectedActorId: maker,
      sourceType: "invoice",
      sourceId: id(100),
      entryDate: "2026-04-15",
      ...v,
    });
  return { ...f, state, load };
}
test("source routing requires exact actor/org, Books management and actual project management before the private native snapshot", async (t) => {
  const f = await harness(t);
  for (const v of [
    { expectedOrgId: id(9) },
    { expectedActorId: reviewer },
    { entryDate: "2026-02-30" },
  ])
    await assert.rejects(f.load(v));
  assert.ok(!f.state.calls.includes("root") && !f.state.calls.includes("rpc"));
  for (const denied of ["workspace", "books", "project"]) {
    f.state.calls = [];
    f.state.denied = denied;
    await assert.rejects(f.load());
    assert.ok(!f.state.calls.includes("rpc"));
  }
  f.state.calls = [];
  f.state.denied = null;
  const c = await f.load();
  assert.equal(c.sourceId, id(100));
  assert.deepEqual(f.state.calls, [
    "workspace",
    "books.manage",
    "root",
    "project.manage",
    "rpc",
  ]);
});
test("actual source movement and revoked entity preparation rights prevent routing after project metadata was read", async (t) => {
  const f = await harness(t);
  f.state.afterRoot = () =>
    f.db.exec(
      `update invoices set project_id='${id(71)}' where id='${id(100)}'`,
    );
  // Existing ownership also guards the source movement itself.
  await assert.rejects(f.load(), /governed correction/);
  f.state.afterRoot = null;
  await f.db.exec(
    `update memberships set status='revoked' where user_id='${maker}'`,
  );
  await assert.rejects(f.load(), /preparation access/);
});
test("forged private response header, native account identity and approval receipt scope reject before returning a plan context", async (t) => {
  const f = await harness(t);
  for (const change of [
    (c) => (c.actorId = reviewer),
    (c) => (c.source.org_id = id(9)),
    (c) => (c.accounts[0].definition.legal_entity_id = id(999)),
    (c) => (c.chartReview.reviewed_by = c.chart.prepared_by),
    (c) => (c.calendarReview.calendar_year_id = id(999)),
  ]) {
    f.state.forge = (c) => {
      change(c);
      return c;
    };
    await assert.rejects(f.load(), /differs/);
  }
  f.state.forge = null;
  assert.equal((await f.load()).ledgerActivated, false);
});
