require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  { randomUUID } = require("node:crypto");
const {
  measurementUnit,
  measurementHref,
} = require("../lib/drawings/measurement-context");
const prospect = randomUUID(),
  project = randomUUID(),
  rowId = randomUUID(),
  conditionId = randomUUID();
let worksheet, conditions, version, denied, creates;
const reset = () => {
  worksheet = {
    rows: [
      {
        id: rowId,
        description: "Flooring",
        unit: "sf",
        quantity: 200,
        metadata: {},
        cost_code_id: null,
      },
    ],
    requests: [],
  };
  conditions = [];
  version = 1;
  denied = false;
  creates = 0;
};
const orig = Module._load;
Module._load = function (request, ...args) {
  if (request === "./precon-workspace")
    return {
      authorizePreconWorkspaceWrite: async () => {
        if (denied) throw Error("Denied");
        return { projectId: project };
      },
      getPreconWorkspace: async () => ({
        pricing: structuredClone(worksheet),
        version,
      }),
    };
  if (request === "./permissions")
    return {
      requirePermission: async () => {
        if (denied) throw Error("Denied");
      },
    };
  if (request === "./precon-pricing")
    return {
      savePricingWorksheet: async (id, rows, expected) => {
        assert.equal(id, prospect);
        assert.equal(expected, version);
        worksheet = rows;
        version++;
      },
    };
  if (request === "./takeoff")
    return {
      listTakeoffConditions: async () => conditions,
      createTakeoffCondition: async (input) => {
        creates++;
        const c = { id: conditionId, ...input };
        conditions.push(c);
        return c;
      },
    };
  if (request === "./conversions")
    return { startProspectPricing: async () => ({ projectId: project }) };
  if (request === "./takeoff-destinations")
    return {
      listSyncTargets: async () => [
        {
          destination: "pricing_worksheet",
          id: prospect,
          label: "Working estimate",
          writable: true,
        },
      ],
    };
  return orig.call(this, request, ...args);
};
const {
  beginWorksheetMeasurement,
  resolveMeasurementContext,
} = require("../lib/services/measurement-context");
test.after(() => (Module._load = orig));
test.beforeEach(reset);
test("existing row creates one reusable measurement source without changing quantity or money", async () => {
  const first = await beginWorksheetMeasurement(prospect, rowId, "SF");
  const second = await beginWorksheetMeasurement(prospect, rowId, "SF");
  assert.equal(first, second);
  assert.equal(creates, 1);
  assert.equal(worksheet.rows.length, 1);
  assert.equal(worksheet.rows[0].quantity, 200);
  assert.equal(
    worksheet.rows[0].metadata.takeoff_source.condition_id,
    conditionId,
  );
  assert.ok(first.includes(`row=${rowId}`));
  assert.ok(first.includes(`condition=${conditionId}`));
});
test("permissions and removed rows fail without creating orphan measurement items", async () => {
  denied = true;
  await assert.rejects(
    beginWorksheetMeasurement(prospect, rowId, "sf"),
    /Denied/,
  );
  assert.equal(creates, 0);
  denied = false;
  await assert.rejects(
    beginWorksheetMeasurement(prospect, randomUUID(), "sf"),
    /Save this scope/,
  );
  assert.equal(creates, 0);
});
test("row context rejects another destination and resolves the exact return row", async () => {
  await assert.rejects(
    resolveMeasurementContext(
      project,
      { destination: "pricing_worksheet", target: randomUUID() },
      prospect,
    ),
    /does not belong/,
  );
  const c = await resolveMeasurementContext(
    project,
    { destination: "pricing_worksheet", target: prospect, row: rowId },
    prospect,
  );
  assert.equal(c.rowLabel, "Flooring");
  assert.equal(
    c.returnHref,
    `/pipeline/${prospect}?row=${rowId}`,
  );
});
test("unit aliases normalize without treating lump sums as measurable rates", () => {
  assert.equal(measurementUnit("Sq. Ft."), "sf");
  assert.equal(measurementUnit("LS"), null);
  assert.ok(
    measurementHref(project, {
      destination: "change_order",
      targetId: conditionId,
      label: "Change",
      returnHref: "/ignored",
    }).includes("destination=change_order"),
  );
});
