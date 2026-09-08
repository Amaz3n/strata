const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { z } = require("zod");

function load(file, imports) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(
    compiled,
    {
      exports,
      Buffer,
      require(name) {
        if (!(name in imports))
          throw new Error(`Unexpected dependency: ${name}`);
        return imports[name];
      },
    },
    { filename: file },
  );
  return exports;
}
const directory = load("lib/projects/directory.ts", { zod: { z } });
const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const communityId = "00000000-0000-4000-8000-000000000003";
const divisionId = "00000000-0000-4000-8000-000000000004";

function fixture({
  assigned = false,
  permission = true,
  divisions = null,
  membershipError = null,
} = {}) {
  const calls = [];
  const scopedClient = {
    from() {
      const query = {
        select: () => query,
        eq: () => query,
        then: (resolve) =>
          Promise.resolve({
            data: [{ project_scope: assigned ? "assigned" : "all" }],
            error: membershipError,
          }).then(resolve),
      };
      return query;
    },
    rpc() {
      throw new Error("An authenticated client cannot call a service-only RPC");
    },
  };
  const context = {
    orgId,
    userId,
    supabase: scopedClient,
    productTier: "residential",
  };
  const services = load("lib/services/project-directory.ts", {
    "server-only": {},
    react: { cache: (fn) => fn },
    "@/lib/services/context": { requireOrgContext: async () => context },
    "@/lib/services/authorization": {
      getDivisionAccessForUser: async () => ({
        assignedOnly: divisions !== null,
        divisionIds: divisions ?? [],
      }),
    },
    "@/lib/services/permissions": {
      hasAnyPermission: async () => permission,
      hasPermission: async () => true,
      requireProjectPermission: async () => {},
    },
    "@/lib/services/desk-context": {
      getAmbientDeskContext: async () => ({
        communities: [{ id: communityId, name: "Test community" }],
        communityId,
        divisionId,
      }),
    },
    "@/lib/observability/spans": { withSpan: (_name, _attrs, fn) => fn() },
    "@/lib/projects/directory": directory,
    "@/lib/services/projects": { getProjectWithFinancials: async () => null },
    "@/lib/supabase/server": {
      createServiceSupabaseClient: () => ({
        rpc: async (name, args) => {
          calls.push({ name, args });
          return { data: [], error: null };
        },
      }),
    },
  });
  return { services, calls };
}

test("an authenticated directory request uses a guarded service read with the verified actor and scopes", async () => {
  const { services, calls } = fixture({
    assigned: true,
    divisions: [divisionId],
  });
  await services.loadProjectDirectory({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.p_user_id, userId);
  assert.equal(calls[0].args.p_org_id, orgId);
  assert.equal(calls[0].args.p_all_projects, false);
  assert.equal(calls[0].args.p_community_id, communityId);
  assert.equal(calls[0].args.p_division_id, divisionId);
  assert.deepEqual(calls[0].args.p_division_ids, [divisionId]);
});
test("membership errors and empty division scope never broaden access", async () => {
  const bad = fixture({ membershipError: { message: "database unavailable" } });
  await assert.rejects(
    bad.services.loadProjectDirectory({}),
    /Unable to resolve project scope/,
  );
  assert.equal(bad.calls.length, 0);
  const empty = fixture({ divisions: [] });
  assert.equal(
    (await empty.services.loadProjectDirectory({})).page.rows.length,
    0,
  );
  assert.equal(empty.calls.length, 0);
  const denied = fixture({ permission: false });
  await denied.services.loadProjectDirectory({});
  assert.equal(denied.calls[0].args.p_all_projects, false);
});
test("All communities overrides the ambient default; an unknown community matches nothing", async () => {
  const f = fixture();
  await f.services.loadProjectDirectory({ community: "all" });
  assert.equal(f.calls[0].args.p_community_id, null);
  const result = await f.services.loadProjectDirectory({ community: userId });
  assert.equal(result.page.rows.length, 0);
  assert.equal(f.calls.length, 1);
});
test("invalid filter and cursor inputs cannot reach the database", async () => {
  const f = fixture();
  await assert.rejects(
    f.services.loadProjectDirectory({ sort: "arbitrary SQL" }),
  );
  await assert.rejects(f.services.loadProjectDirectory({ cursor: "invalid" }));
  assert.equal(f.calls.length, 0);
});
