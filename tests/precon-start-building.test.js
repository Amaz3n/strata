require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const prospectId = "30000000-0000-0000-0000-000000000001";
const projectId = "50000000-0000-0000-0000-000000000001";
const agreementId = "40000000-0000-0000-0000-000000000001";

let budget, agreement, created, rpc;
function reset() {
  budget = null;
  created = [];
  rpc = [];
  agreement = {
    id: agreementId,
    subtotal_cents: 100_000_00,
    metadata: {
      contingency_percent: 5,
      precon: { purpose: "construction_agreement", contingency_treatment: "builder_reserve", allowance_policy: "Reconciled by change order" },
    },
    items: [
      { id: "group", item_type: "group", description: "Interior", sort_order: 0 },
      { id: "framing", item_type: "line", description: "Framing", quantity: 1, unit_cost_cents: 60_000_00, sort_order: 1, cost_code_id: null, metadata: {} },
      { id: "tile", item_type: "line", description: "Tile", quantity: 1, unit_cost_cents: 40_000_00, sort_order: 2, cost_code_id: null, metadata: { is_allowance: true } },
      { id: "hot-tub", item_type: "line", description: "Hot tub", quantity: 1, unit_cost_cents: 9_000_00, sort_order: 3, cost_code_id: null, metadata: { is_optional: true } },
    ],
  };
}
const db = {
  from(table) {
    const query = {
      select: () => query,
      eq: () => query,
      limit: () => query,
      maybeSingle: async () =>
        table === "prospects"
          ? { data: { id: prospectId }, error: null }
          : table === "projects"
            ? { data: { id: projectId }, error: null }
            : table === "budgets"
              ? { data: budget, error: null }
              : { data: agreement, error: null },
    };
    return query;
  },
  async rpc(name, args) {
    rpc.push({ name, args });
    return { data: { projectId, alreadyStarted: false }, error: null };
  },
};
const stubs = {
  "server-only": {},
  "@/lib/services/context": { requireOrgContext: async () => ({ supabase: db, orgId: "org", userId: "actor", productTier: "residential" }) },
  "@/lib/services/authorization": { requireAuthorization: async () => {} },
  "@/lib/supabase/server": { createServiceSupabaseClient: () => db },
  "./budgets": { createBudget: async (input) => created.push(input) },
};
const original = Module._load;
Module._load = function (request, ...args) {
  return stubs[request] ?? original.call(this, request, ...args);
};
test.after(() => {
  Module._load = original;
});
const { startBuilding } = require("../lib/services/precon-project-start");

test("starting the job drafts its budget from the signed lines at cost", async () => {
  reset();
  const result = await startBuilding(prospectId, agreementId);
  assert.equal(rpc[0].name, "start_prospect_project");
  assert.equal(rpc[0].args.p_expected_agreement_id, agreementId);
  assert.equal(result.budgetCreated, true);
  const lines = created[0].lines;
  assert.equal(created[0].status, "draft");
  assert.equal(created[0].project_id, projectId);
  assert.deepEqual(lines.map((line) => line.description), ["Framing", "Tile", "Builder contingency reserve"]);
  assert.equal(lines[0].metadata.section_title, "Interior");
  assert.equal(lines[1].metadata.is_allowance, true);
  assert.equal(lines[1].metadata.allowance_policy, "Reconciled by change order");
  assert.equal(lines[2].amount_cents, 5_000_00);
});

test("a job that already has a budget keeps it", async () => {
  reset();
  budget = { id: "existing" };
  const result = await startBuilding(prospectId, agreementId);
  assert.equal(result.budgetCreated, false);
  assert.equal(created.length, 0);
});

test("contingency included in the price is not budgeted twice", async () => {
  reset();
  agreement.metadata.precon.contingency_treatment = "included_in_price";
  await startBuilding(prospectId, agreementId);
  assert.ok(!created[0].lines.some((line) => /contingency/i.test(line.description)));
});
