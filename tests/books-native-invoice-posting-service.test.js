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
  entity,
  notes,
} = require("./fixtures/books-native-invoice-income-database");
async function harness(t) {
  const f = await setup(t),
    state = {
      actor: maker,
      denied: null,
      calls: [],
      forge: null,
      afterRoot: null,
      hidden: false,
      loseResponse: false,
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
          return {
            data: state.hidden ? null : (r.rows[0] ?? null),
            error: null,
          };
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
        if (
          state.loseResponse &&
          [
            "post_books_native_invoice",
            "resolve_books_native_invoice_request",
            "select_books_native_invoice_income",
            "resolve_books_native_invoice_income",
          ].includes(name)
        )
          throw Error("Lost response after actual commit");
        if (state.forge) data = state.forge(data);
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  const target =
      require.resolve("../lib/services/books/native-invoice-posting"),
    old = Module._load;
  let api, incomeApi;
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
    const incomeTarget =
      require.resolve("../lib/services/books/native-invoice-income");
    delete require.cache[incomeTarget];
    incomeApi = require(incomeTarget);
  } finally {
    Module._load = old;
  }
  const request = {
    expectedOrgId: org,
    expectedActorId: maker,
    id: id(700),
    entryId: id(701),
    economic: f.original,
    notes,
  };
  const post = (v = {}) => api.postNativeProjectInvoice({ ...request, ...v });
  const read = (v = {}) =>
    api.readNativeProjectInvoicePosting({
      expectedOrgId: org,
      expectedActorId: state.actor,
      entityId: entity,
      projectId: id(70),
      invoiceId: id(100),
      id: id(700),
      ...v,
    });
  const resolve = (v = {}) =>
    api.resolveNativeProjectInvoiceRequest({
      id: id(740),
      request,
      reason: notes,
      ...v,
    });
  return {
    ...f,
    state,
    post,
    read,
    request,
    resolve,
    resolveCode: (v = {}) =>
      incomeApi.resolveNativeInvoiceIncome({
        id: id(950),
        request: f.incomeRequest,
        reason: notes,
        ...v,
      }),
    code: (v = {}) =>
      incomeApi.selectNativeInvoiceIncome({ ...f.incomeRequest, ...v }),
  };
}

test("income service gates actual source and actor before exact coding and recovers a lost committed coding receipt", async (t) => {
  const f = await harness(t);
  for (const v of [{ expectedOrgId: id(9) }, { expectedActorId: reviewer }])
    await assert.rejects(f.code(v));
  assert.equal(f.state.calls.length, 0);
  for (const denied of ["books", "project"]) {
    f.state.denied = denied;
    f.state.calls = [];
    await assert.rejects(f.code());
    assert.ok(!f.state.calls.includes("select_books_native_invoice_income"));
  }
  f.state.denied = null;
  f.state.hidden = true;
  await assert.rejects(f.code());
  f.state.hidden = false;
  f.state.loseResponse = true;
  await assert.rejects(f.code(), /Lost response/);
  f.state.loseResponse = false;
  const r = await f.code();
  assert.equal(r.created, false);
  assert.equal(r.coded, true);
  assert.equal(r.posted, false);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_income_selections",
      )
    ).rows[0].n,
    1,
  );
  f.state.forge = (r) => ({
    ...r,
    selection: { ...r.selection, actor_id: reviewer },
  });
  await assert.rejects(f.code());
});
test("income resolution service recovers lost cancellations and original committed selections with exact intent and current caller gates", async (t) => {
  const f = await harness(t);
  for (const denied of ["books", "project"]) {
    f.state.denied = denied;
    f.state.calls = [];
    await assert.rejects(f.resolveCode());
    assert.ok(!f.state.calls.includes("resolve_books_native_invoice_income"));
  }
  f.state.denied = null;
  f.state.hidden = true;
  await assert.rejects(f.resolveCode());
  f.state.hidden = false;
  f.state.loseResponse = true;
  await assert.rejects(f.resolveCode(), /Lost response/);
  f.state.loseResponse = false;
  const r = await f.resolveCode();
  assert.equal(r.outcome, "cancelled");
  await assert.rejects(f.code(), /cancelled/);
  f.state.forge = (v) => ({
    ...v,
    resolution: { ...v.resolution, reason: notes + " forged" },
  });
  await assert.rejects(f.resolveCode(), /decision/);
  f.state.forge = null;
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    maker,
    reviewer,
    "manage",
    notes,
  ]);
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    reviewer,
    maker,
    "revoked",
    notes,
  ]);
  await assert.rejects(f.resolveCode(), /access/);
  const g = await harness(t);
  const original = await g.code();
  assert.deepEqual((await g.resolveCode()).selection, original.selection);
  g.state.forge = (v) => ({
    ...v,
    selection: { ...v.selection, actor_id: reviewer },
  });
  await assert.rejects(g.resolveCode());
});
test("native operational service requires actual caller-visible invoice and Books/project authority before scoped private money", async (t) => {
  const f = await harness(t);
  for (const v of [
    { expectedOrgId: id(9) },
    { expectedActorId: reviewer },
    {
      economic: {
        ...f.original,
        native: { ...f.original.native, actorId: reviewer },
      },
    },
  ])
    await assert.rejects(f.post(v));
  assert.equal(f.state.calls.length, 0);
  for (const denied of ["books", "project"]) {
    f.state.calls = [];
    f.state.denied = denied;
    await assert.rejects(f.post());
    assert.ok(!f.state.calls.includes("post_books_native_invoice"));
  }
  f.state.denied = null;
  f.state.hidden = true;
  f.state.calls = [];
  await assert.rejects(f.post());
  assert.ok(!f.state.calls.includes("project.manage"));
  assert.ok(!f.state.calls.includes("post_books_native_invoice"));
  f.state.hidden = false;
  f.state.calls = [];
  const r = await f.post();
  assert.equal(r.posted, true);
  assert.equal(r.ledgerActivated, false);
  assert.deepEqual(f.state.calls, [
    "books.manage",
    "root",
    "project.manage",
    "post_books_native_invoice",
  ]);
});
test("a lost native invoice write response recovers the exact committed request without recapturing changed economics", async (t) => {
  const f = await harness(t);
  f.state.loseResponse = true;
  await assert.rejects(f.post(), /Lost response/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_postings",
      )
    ).rows[0].n,
    1,
  );
  f.state.loseResponse = false;
  await f.db.exec(
    "update invoices set status='paid',metadata='{\"label\":\"Later paid source\"}';update accounting_policies set status='superseded'",
  );
  const detail = await f.read();
  assert.equal(detail.posted, true);
  f.state.calls = [];
  const retry = await f.post();
  assert.equal(retry.created, false);
  assert.equal(retry.entry.id, id(701));
  assert.ok(
    !f.state.calls.includes("read_books_native_invoice_economic_context"),
  );
  await assert.rejects(f.post({ notes: notes + " changed" }), /retry differs/);
  f.state.actor = reviewer;
  assert.equal((await f.read()).posting.posted_by, maker);
});
test("service refuses forged returned receipt/header/legs and scopes missing detail before exposing any source money", async (t) => {
  const f = await harness(t);
  await f.post();
  for (const forge of [
    (r) => ({ ...r, posting: { ...r.posting, notes: notes + " forged" } }),
    (r) => ({ ...r, posting: { ...r.posting, id: id(999) } }),
    (r) => ({ ...r, entry: { ...r.entry, total_cents: 1 } }),
    (r) => ({ ...r, lines: r.lines.slice(1) }),
  ]) {
    f.state.forge = forge;
    await assert.rejects(f.post());
  }
  f.state.forge = null;
  const empty = await f.read({ id: id(999) });
  assert.equal(empty.posted, false);
  assert.equal(empty.entry, null);
  assert.deepEqual(empty.lines, []);
  for (const forge of [
    (r) => ({ ...r, actorId: reviewer }),
    (r) => ({ ...r, projectId: id(71) }),
    (r) => ({ ...r, posting: null }),
    (r) => ({ ...r, entry: null }),
  ]) {
    f.state.forge = forge;
    await assert.rejects(f.read());
  }
  f.state.forge = null;
  f.state.denied = "project";
  f.state.calls = [];
  await assert.rejects(f.read());
  assert.ok(!f.state.calls.includes("read_books_native_invoice_posting"));
});
test("actual source movement after caller authorization fails before money, while missing detail alone never confirms cancellation", async (t) => {
  const f = await harness(t);
  f.state.afterRoot = () =>
    f.db.exec(
      `update invoices set project_id='${id(71)}' where id='${id(100)}'`,
    );
  await assert.rejects(
    f.post(),
    /outside project|source.*project|owner|snapshot changed/,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_postings",
      )
    ).rows[0].n,
    0,
  );
});

test("actual entity and organization authority revocation denies committed recovery reads and retries", async (t) => {
  const f = await harness(t);
  await f.post();
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    maker,
    reviewer,
    "manage",
    notes,
  ]);
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    reviewer,
    maker,
    "revoked",
    notes,
  ]);
  await assert.rejects(f.post(), /access/);
  await assert.rejects(f.read(), /access/);
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    reviewer,
    maker,
    "prepare",
    notes,
  ]);
  await f.db.exec(
    `update memberships set status='inactive' where user_id='${maker}'`,
  );
  await assert.rejects(f.post(), /access/);
  await assert.rejects(f.read(), /access/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_postings",
      )
    ).rows[0].n,
    1,
  );
});

test("authorized resolution survives a lost cancellation response, denies forged output, and fences the saved original posting", async (t) => {
  const f = await harness(t);
  f.state.loseResponse = true;
  await assert.rejects(f.resolve(), /Lost response/);
  f.state.loseResponse = false;
  const r = await f.resolve();
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.resolution.request_id, f.request.id);
  await assert.rejects(f.post(), /cancelled/);
  for (const forge of [
    (r) => ({
      ...r,
      resolution: { ...r.resolution, reason: notes + " forged" },
    }),
    (r) => ({ ...r, posted: true }),
    (r) => ({ ...r, resolution: { ...r.resolution, request_id: id(999) } }),
  ]) {
    f.state.forge = forge;
    await assert.rejects(f.resolve());
  }
  f.state.forge = null;
  f.state.denied = "project";
  f.state.calls = [];
  await assert.rejects(f.resolve());
  assert.ok(!f.state.calls.includes("resolve_books_native_invoice_request"));
});
test("authorized resolution returns the independently validated original committed money and never invents cancellation", async (t) => {
  const f = await harness(t),
    p = await f.post(),
    r = await f.resolve();
  assert.equal(r.outcome, "committed_original");
  assert.deepEqual(r.posting, p.posting);
  assert.equal(r.resolution, null);
  f.state.forge = (r) => ({ ...r, lines: r.lines.slice(1) });
  await assert.rejects(f.resolve());
});
