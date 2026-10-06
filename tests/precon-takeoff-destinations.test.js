require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");
const orgId = randomUUID(),
  projectId = randomUUID(),
  prospectId = randomUUID();
const conditionId = randomUUID(),
  estimateId = randomUUID();
let phase, estimateRows, queryError, conditions;
const queries = [];
let lineRows = [],
  writes = [];
const matches = (row, filters) =>
  filters.every(([k, v]) => {
    const value =
      k === "metadata->takeoff->>condition_id"
        ? row.metadata?.takeoff?.condition_id
        : row[k];
    return Array.isArray(v) ? v.includes(value) : value === v;
  });
const supabase = {
  from(table) {
    const filters = [];
    let insertion, update, projectStatusOnly = false;
    const records = () =>
      table === "estimates"
        ? estimateRows
        : table === "estimate_items"
          ? lineRows
          : table === "takeoff_conditions"
            ? conditions
            : table === "drawing_markups"
              ? [
                  {
                    id: randomUUID(),
                    org_id: orgId,
                    condition_id: conditionId,
                    quantity: 100,
                    drawing_sheet_id: randomUUID(),
                  },
                ]
              : [];
    queries.push({ table, filters });
    const q = {
      select(fields) {
        projectStatusOnly = table === "projects" && fields === "prospect_id";
        if (table === "projects" && fields !== "prospect_id") {
          assert.ok(
            fields.includes("project_module_overrides(module_key, enabled)"),
          );
          assert.ok(!fields.split(", ").includes("module_overrides"));
        }
        return q;
      },
      eq(key, value) {
        filters.push([key, value]);
        return q;
      },
      in(key, value) {
        filters.push([key, value]);
        return q;
      },
      order() {
        return q;
      },
      limit() {
        return q;
      },
      insert(value) {
        insertion = value;
        return q;
      },
      update(value) {
        update = value;
        return q;
      },
      maybeSingle() {
        return Promise.resolve({
          data:
            table === "projects"
              ? { id: projectId, phase, prospect_id: projectStatusOnly ? null : prospectId }
              : records().find((row) => matches(row, filters)),
          error: null,
        });
      },
      then(resolve, reject) {
        if (insertion) {
          const value = { id: randomUUID(), ...insertion };
          lineRows.push(value);
          writes.push({ table, value });
        }
        if (update) {
          for (const row of records().filter((row) => matches(row, filters)))
            Object.assign(row, update);
          writes.push({ table, value: update });
        }
        return Promise.resolve({
          data: records().filter((row) => matches(row, filters)),
          error: table === "estimates" ? queryError : null,
        }).then(resolve, reject);
      },
    };
    return q;
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, main) {
  if (request === "@/lib/services/context")
    return {
      requireOrgContext: async () => ({
        supabase,
        orgId,
        userId: randomUUID(),
      }),
      getOrgProductTier: async () => "custom",
    };
  if (request === "@/lib/services/permissions")
    return { requirePermission: async () => {} };
  if (request === "@/lib/services/audit")
    return { recordAudit: async () => {} };
  if (request === "@/lib/services/events")
    return { recordEvent: async () => {} };
  return originalLoad.call(this, request, parent, main);
};
const { listSyncTargets } = require("../lib/services/takeoff-destinations");
const {
  previewConditionSync,
  syncConditions,
} = require("../lib/services/takeoff");
Module._load = originalLoad;
const row = (overrides = {}) => ({
  id: estimateId,
  title: "Kitchen estimate",
  org_id: orgId,
  project_id: null,
  prospect_id: prospectId,
  status: "draft",
  is_current_version: true,
  metadata: {},
  ...overrides,
});
test.beforeEach(() => {
  lineRows = [];
  writes = [];
  phase = "precon";
  estimateRows = [row()];
  queryError = null;
  queries.length = 0;
  conditions = [
    {
      id: conditionId,
      org_id: orgId,
      project_id: projectId,
      house_plan_version_id: null,
      name: "Flooring",
      uom: "sf",
      waste_pct: 10,
      unit_cost_cents: 200,
    },
  ];
});
test("precon finds prospect-owned estimates with no project ID and excludes other prospects", async () => {
  estimateRows.push(row({ id: randomUUID(), prospect_id: randomUUID() }));
  const targets = await listSyncTargets(projectId);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].destination, "pricing_worksheet");
  assert.equal(targets[0].id, prospectId);
  assert.equal(targets[1].id, estimateId);
  assert.equal(targets[0].writable, true);
  assert.ok(
    queries
      .find((q) => q.table === "estimates")
      .filters.some(([k, v]) => k === "prospect_id" && v === prospectId),
  );
  assert.ok(!queries.some((q) => q.table === "bid_packages"));
});
test("precon excludes service agreements and prevents sent, signed, and superseded estimates receiving quantities", async () => {
  estimateRows = [
    row({ metadata: { precon: { purpose: "preconstruction_agreement" } } }),
    ...[
      "sent",
      "approved",
      "client_signed",
      "executed",
      "converted_to_project",
    ].map((status) => row({ id: randomUUID(), status })),
    row({ id: randomUUID(), is_current_version: false }),
  ];
  const targets = await listSyncTargets(projectId);
  assert.equal(targets.length, 7);
  assert.ok(
    targets
      .filter((t) => t.destination === "estimate")
      .every((t) => !t.writable),
  );
});
test("delivery still uses project-owned estimates", async () => {
  phase = "delivery";
  estimateRows = [row({ project_id: projectId }), row({ id: randomUUID() })];
  const targets = await listSyncTargets(projectId);
  assert.equal(targets.length, 1);
  assert.ok(
    queries
      .find((q) => q.table === "estimates")
      .filters.some(([k, v]) => k === "project_id" && v === projectId),
  );
});
test("a failed estimate query is not presented as an empty workspace", async () => {
  queryError = { message: "connection failed" };
  await assert.rejects(listSyncTargets(projectId), /Unable to load estimates/);
});
for (const operation of [previewConditionSync, syncConditions]) {
  test(`${operation.name} refuses unrelated destinations before reading or writing lines`, async () => {
    await assert.rejects(
      operation({
        destination: "estimate",
        target_id: randomUUID(),
        condition_ids: [conditionId],
      }),
      /does not belong/,
    );
    assert.ok(!queries.some((q) => q.table === "estimate_items"));
  });
  test(`${operation.name} refuses locked estimates`, async () => {
    estimateRows = [row({ status: "sent" })];
    await assert.rejects(
      operation({
        destination: "estimate",
        target_id: estimateId,
        condition_ids: [conditionId],
      }),
      /new draft version/,
    );
    assert.ok(!queries.some((q) => q.table === "estimate_items"));
  });
  test(`${operation.name} refuses partly missing conditions`, async () => {
    await assert.rejects(
      operation({
        destination: "estimate",
        target_id: estimateId,
        condition_ids: [conditionId, randomUUID()],
      }),
      /conditions are unavailable/,
    );
  });
}

test("prospect takeoff previews, writes priced quantities with provenance, and re-syncs without duplicates", async () => {
  estimateRows = [row({ metadata: { markup_percent: 20 } })];
  const input = {
    destination: "estimate",
    target_id: estimateId,
    condition_ids: [conditionId],
  };
  const preview = await previewConditionSync(input);
  assert.equal(preview[0].action, "create");
  assert.ok(Math.abs(preview[0].next_quantity - 110) < 0.00001);
  assert.equal(writes.length, 0);
  const result = await syncConditions(input);
  assert.equal(result.created, 1);
  assert.equal(lineRows.length, 1);
  assert.equal(lineRows[0].estimate_id, estimateId);
  assert.equal(lineRows[0].metadata.takeoff.condition_id, conditionId);
  assert.equal(lineRows[0].unit_cost_cents, 200);
  assert.equal(lineRows[0].markup_pct, 20);
  assert.equal(estimateRows[0].total_cents, 26400);
  const again = await syncConditions(input);
  assert.equal(again.unchanged, 1);
  assert.equal(lineRows.length, 1);
});

test("worksheet takeoff sync preserves edited rates, avoids duplicates and protects selected quotes", async () => {
  const {
    EMPTY_PRICING_WORKSHEET,
  } = require("../lib/precon/pricing-worksheet");
  let worksheet = { ...EMPTY_PRICING_WORKSHEET, rows: [], requests: [] },
    version = 0;
  const priorLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === "./precon-workspace")
      return {
        getPreconWorkspace: async () => ({
          pricing: structuredClone(worksheet),
          version,
        }),
      };
    if (request === "./precon-pricing")
      return {
        savePricingWorksheet: async (id, value, expected) => {
          assert.equal(id, prospectId);
          assert.equal(expected, version);
          worksheet = structuredClone(value);
          version++;
        },
      };
    return priorLoad.call(this, request, ...args);
  };
  try {
    const input = {
      destination: "pricing_worksheet",
      target_id: prospectId,
      condition_ids: [conditionId],
    };
    assert.equal((await syncConditions(input)).created, 1);
    assert.equal(worksheet.rows.length, 1);
    assert.equal(worksheet.rows[0].unit_cost_cents, 200);
    assert.equal((await syncConditions(input)).unchanged, 1);
    worksheet.rows[0].unit_cost_cents = 500;
    conditions[0].waste_pct = 20;
    assert.equal((await syncConditions(input)).updated, 1);
    assert.equal(worksheet.rows[0].quantity, 120);
    assert.equal(worksheet.rows[0].unit_cost_cents, 500);
    worksheet.requests = [
      {
        row_ids: [worksheet.rows[0].id],
        quote: { normalized_total_cents: 60000 },
      },
    ];
    conditions[0].waste_pct = 30;
    assert.equal((await syncConditions(input)).updated, 1);
    assert.equal(worksheet.rows[0].metadata.takeoff.evidence_only, true);
    assert.equal(worksheet.rows[0].metadata.takeoff.measured_quantity, 130);
    assert.equal(worksheet.rows[0].quantity, 120);
    assert.equal(worksheet.rows.length, 1);
    const { pricingRowSchema } = require("../lib/precon/pricing-worksheet");
    worksheet.requests = [];
    worksheet.rows = [pricingRowSchema.parse({ id: randomUUID(), description: "Existing flooring", quantity: 77, unit: "sf", unit_cost_cents: 550 })];
    const rowId = worksheet.rows[0].id;
    const mapped = { ...input, line_mappings: { [conditionId]: rowId } };
    const preview = await previewConditionSync(mapped);
    assert.equal(preview[0].current_quantity, 77);
    assert.equal(preview[0].action, "update");
    assert.equal((await syncConditions({ ...mapped, reviewed_quantities: { [conditionId]: 130 } })).updated, 1);
    assert.equal(worksheet.rows.length, 1);
    assert.equal(worksheet.rows[0].id, rowId);
    assert.equal(worksheet.rows[0].unit_cost_cents, 550);
    assert.equal(worksheet.rows[0].metadata.takeoff_source.condition_id, conditionId);
    await assert.rejects(syncConditions({ ...mapped, reviewed_line_quantities: { [conditionId]: 12 } }), /changed after review/);
    await assert.rejects(syncConditions({ ...mapped, reviewed_quantities: { [conditionId]: 1 } }), /changed after review/);
    await assert.rejects(syncConditions({ ...mapped, line_mappings: { [conditionId]: randomUUID() } }), /no longer available/);
    worksheet.rows[0].metadata.takeoff_source.condition_id = randomUUID();
    await assert.rejects(syncConditions(mapped), /another measurement source/);
    worksheet.rows = [pricingRowSchema.parse({ id: rowId, description: "Allowance", quantity: 1, unit: "ls", unit_cost_cents: 50000 })];
    assert.equal((await previewConditionSync(mapped))[0].reprice_required, true);
    await syncConditions(mapped);
    assert.equal(worksheet.rows[0].quantity, 130);
    assert.equal(worksheet.rows[0].unit_cost_cents, null, "lump sums cannot become per-unit rates silently");
    worksheet.rows[0].unit = "lf";
    await assert.rejects(syncConditions(mapped), /unit does not match/);
  } finally {
    Module._load = priorLoad;
  }
});
