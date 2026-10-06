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
} = require("./fixtures/books-native-invoice-economic-database");
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
          assert.equal(table, "invoices");
          const r = await f.db.query(
            "select id,org_id,project_id from invoices where org_id=$1 and id=$2",
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
      state.calls.push(name);
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
          requireBooksWorkspaceEnabled: async () => ({
            orgId: org,
            userId: state.actor,
            supabase: user,
          }),
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
    api.loadNativeInvoiceEconomicContext({
      expectedOrgId: org,
      expectedActorId: maker,
      sourceType: "invoice",
      sourceId: id(100),
      entryDate: "2026-04-15",
      ...v,
    });
  return { ...f, state, load };
}
test("native invoice economics requires caller-visible invoice, Books/project management and exact actor before its one coherent private snapshot", async (t) => {
  const f = await harness(t);
  await assert.rejects(f.load({ expectedOrgId: id(9) }));
  await assert.rejects(f.load({ expectedActorId: reviewer }));
  await assert.rejects(f.load({ sourceType: "vendor_bill" }));
  assert.ok(!f.state.calls.includes("root"));
  for (const denied of ["books", "project"]) {
    f.state.calls = [];
    f.state.denied = denied;
    await assert.rejects(f.load());
    assert.ok(
      !f.state.calls.includes("read_books_native_invoice_economic_context"),
    );
  }
  f.state.denied = null;
  f.state.calls = [];
  const e = await f.load();
  assert.equal(e.native.sourceId, id(100));
  assert.deepEqual(f.state.calls, [
    "books.manage",
    "root",
    "project.manage",
    "read_books_native_invoice_economic_context",
  ]);
});
test("native invoice service rejects forged policy or project lines and actual source movement after the caller preflight", async (t) => {
  const f = await harness(t);
  for (const forge of [
    (e) => ({ ...e, policy: { ...e.policy, org_id: id(9) } }),
    (e) => ({
      ...e,
      lines: e.lines.map((l, i) =>
        i === 0 ? { ...l, source: { ...l.source, invoice_id: id(999) } } : l,
      ),
    }),
    (e) => ({ ...e, native: { ...e.native, actorId: reviewer } }),
  ]) {
    f.state.forge = forge;
    await assert.rejects(f.load());
  }
  f.state.forge = null;
  f.state.afterRoot = () =>
    f.db.exec(
      `update invoices set project_id='${id(71)}' where id='${id(100)}'`,
    );
  await assert.rejects(
    f.load(),
    /missing or outside project|governed correction/,
  );
});
