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
} = require("./fixtures/books-native-invoice-resolution-database");
const {
  verifyNativeInvoicePostingReceipt,
} = require("../lib/services/books/native-invoice-posting-receipt");
async function harness(t) {
  const f = await setup(t),
    state = {
      enabled: true,
      denied: null,
      hidden: false,
      calls: [],
      forge: null,
      forgePosting: null,
      noOwner: false,
    };
  const user = {
    from(table) {
      const filters = [],
        q = {
          select() {
            return q;
          },
          eq(k, v) {
            filters.push([k, v]);
            return q;
          },
          async maybeSingle() {
            state.calls.push("root");
            assert.equal(table, "invoices");
            assert.deepEqual(filters, [
              ["org_id", org],
              ["id", id(100)],
            ]);
            const r = await f.db.query(
              "select id,org_id,project_id,issue_date::text from invoices where org_id=$1 and id=$2",
              [org, id(100)],
            );
            return { data: state.hidden ? null : r.rows[0], error: null };
          },
        };
      return q;
    },
  };
  const service = {
    from(table) {
      const filters = [],
        q = {
          select() {
            return q;
          },
          eq(k, v) {
            filters.push([k, v]);
            return q;
          },
          async limit(n) {
            state.calls.push("lookup");
            assert.equal(table, "books_native_invoice_postings");
            assert.equal(n, 2);
            assert.deepEqual(filters, [
              ["org_id", org],
              ["invoice_id", id(100)],
            ]);
            const r = await f.db.query(
              "select id,legal_entity_id,project_id from books_native_invoice_postings where org_id=$1 and invoice_id=$2 limit 2",
              [org, id(100)],
            );
            return {
              data: state.forgePosting ? state.forgePosting(r.rows) : r.rows,
              error: null,
            };
          },
        };
      return q;
    },
  };
  const target =
      require.resolve("../lib/services/books/native-invoice-workspace"),
    old = Module._load;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (args[0]?.filename !== target) return old.call(this, name, ...args);
      if (name === "@/lib/services/context")
        return {
          requireOrgContext: async () => ({
            orgId: org,
            userId: maker,
            supabase: user,
          }),
        };
      if (name === "./module")
        return { isBooksWorkspaceEnabled: async () => state.enabled };
      if (name === "./access")
        return {
          requireBooksAuthorization: async (v) => {
            state.calls.push(v.permission);
            if (state.denied === "books") throw Error("Books denied");
          },
        };
      if (name === "@/lib/services/authorization")
        return {
          requireAuthorization: async (v) => {
            state.calls.push(v.permission);
            assert.equal(v.projectId, id(70));
            if (state.denied === "project") throw Error("Project denied");
          },
        };
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "./project-entity-ownership")
        return {
          getBooksProjectOwnerWorkspace: async (v) => {
            state.calls.push("owner");
            let r = await f.rpc("read_books_project_owner_workspace", [
              org,
              v.projectId,
              maker,
              v.entityId ?? null,
              null,
              null,
              25,
            ]);
            if (state.noOwner) r.owner = null;
            if (state.forge) r = state.forge(r);
            return r;
          },
        };
      if (name === "./native-invoice-posting")
        return {
          readNativeProjectInvoicePosting: async (v) => {
            state.calls.push("detail");
            const r = await f.rpc("read_books_native_invoice_posting", [
              v.expectedOrgId,
              v.entityId,
              v.projectId,
              v.id,
              v.expectedActorId,
            ]);
            if (r.posting)
              verifyNativeInvoicePostingReceipt(r.posting, r.entry, r.lines);
            return { ...r, posted: !!r.posting, ledgerActivated: false };
          },
        };
      return old.call(this, name, ...args);
    };
    delete require.cache[target];
    api = require(target);
  } finally {
    Module._load = old;
  }
  return {
    ...f,
    state,
    load: () => api.getNativeInvoiceWorkspace({ invoiceId: id(100) }),
  };
}
test("native invoice workspace requires Books and actual project visibility before private entity/status lookup", async (t) => {
  const f = await harness(t);
  f.state.enabled = false;
  assert.deepEqual(await f.load(), { enabled: false });
  assert.deepEqual(f.state.calls, []);
  f.state.enabled = true;
  for (const denied of ["books", "project"]) {
    f.state.denied = denied;
    f.state.calls = [];
    await assert.rejects(f.load());
    assert.ok(!f.state.calls.includes("owner"));
    assert.ok(!f.state.calls.includes("lookup"));
  }
  f.state.denied = null;
  f.state.hidden = true;
  await assert.rejects(f.load());
  assert.ok(!f.state.calls.includes("lookup"));
});
test("workspace discovers actual reviewed owner and verified source receipt; ambiguous/cross-entity/scope returns fail closed", async (t) => {
  const f = await harness(t);
  let r = await f.load();
  assert.deepEqual(r.scope, {
    orgId: org,
    actorId: maker,
    projectId: id(70),
    entityId: entity,
    invoiceId: id(100),
  });
  assert.equal(r.posting, null);
  assert.equal(r.canPost, true);
  await f.post();
  r = await f.load();
  assert.equal(r.posting.posted, true);
  assert.equal(r.posting.entry.id, id(701));
  assert.equal(r.ledgerActivated, false);
  f.state.forgePosting = (rows) => [...rows, ...rows];
  await assert.rejects(f.load());
  f.state.forgePosting = (rows) =>
    rows.map((x) => ({ ...x, legal_entity_id: id(999) }));
  await assert.rejects(f.load(), /ownership differs/);
  f.state.forgePosting = null;
  f.state.forge = (r) => ({ ...r, projectId: id(71) });
  await assert.rejects(f.load(), /scope/);
  f.state.forge = null;
  f.state.noOwner = true;
  r = await f.load();
  assert.equal(r.scope, null);
  assert.match(r.reason, /legal entity/);
});
test("native entity read revocation prevents posting detail disclosure and inactive org member fails ownership discovery", async (t) => {
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
  const hidden = await f.load();
  assert.equal(hidden.scope, null);
  assert.ok(!f.state.calls.includes("detail"));
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    reviewer,
    maker,
    "prepare",
    notes,
  ]);
  await f.db.exec(
    `update memberships set status='inactive' where org_id='${org}' and user_id='${maker}'`,
  );
  await assert.rejects(f.load(), /Active organization membership/);
  assert.ok(!f.state.calls.includes("detail"));
});
