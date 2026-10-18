require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  groupSourceAssemblyReviews,
  SOURCE_REVIEW_GROUP_SIZE,
} = require("../lib/drawings/reconstruction-review-groups");
const { levelSchema } = require("../lib/validation/floorplan");
const { applyFloorplanEdit } = require("../lib/drawings/floorplan-model");
const {
  validateArchitecturalModel,
} = require("../lib/drawings/architectural-validation");
const issue = (id, changes = {}) => ({
  id,
  code: "competing-wall-body",
  severity: "review",
  message: `Check source interval ${id}.`,
  pathIds: [2, 1],
  point: [0.2, 0.3],
  ...changes,
});
const members = (issues) =>
  issues.flatMap(
    (i) => i.members ?? [{ id: i.id, message: i.message, point: i.point }],
  );
const level = (issues) => ({
  id: "L0",
  name: "Floor",
  order: 0,
  ceilingHeightFt: 9,
  source: {
    sheetVersionId: "s",
    sheetNumber: null,
    sheetTitle: null,
    imageWidth: 1000,
    imageHeight: 1000,
    feetPerImagePx: 0.1,
    originPxX: 0,
    originPxY: 0,
    scaleConfirmed: true,
  },
  reconstruction: {
    version: 1,
    status: "needs-review",
    source: {
      wallPathCount: 2,
      representedWallPathCount: 2,
      excludedPathCount: 0,
    },
    issues,
  },
  walls: [],
  openings: [],
  rooms: [],
  confidence: { walls: 0, openings: 0, rooms: 0 },
});
test("grouping preserves every source identity, message and location, independent of source ID ordering", () => {
  const input = [
      issue("b"),
      issue("a", { point: [0.4, 0.5], pathIds: [1, 2, 1] }),
    ],
    snapshot = JSON.stringify(input),
    r = groupSourceAssemblyReviews(input);
  assert.equal(r.length, 1);
  assert.equal(r[0].severity, "review");
  assert.deepEqual(r[0].pathIds, [1, 2]);
  assert.deepEqual(
    members(r),
    [input[1], input[0]].map(({ id, message, point }) => ({
      id,
      message,
      point,
    })),
  );
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(groupSourceAssemblyReviews([...input].reverse())[0].id, r[0].id);
  assert.deepEqual(groupSourceAssemblyReviews(r), r);
});
test("critical, object-specific, unrelated source sets, other codes and missing provenance remain individual", () => {
  const input = [
    issue("error", { severity: "error" }),
    issue("error2", { severity: "error" }),
    issue("wall", { objectId: "wall-1" }),
    issue("wall2", { objectId: "wall-1" }),
    issue("unrelated", { pathIds: [3] }),
    issue("unrelated2", { pathIds: [4] }),
    issue("other", { code: "wall-network-floor-conflict" }),
    issue("other2", { code: "wall-network-floor-conflict" }),
    issue("unknown", { pathIds: [] }),
    issue("unknown2", { pathIds: [] }),
  ];
  assert.deepEqual(groupSourceAssemblyReviews(input), input);
});
test("bounded group chunks preserve all diagnostics including the single-member remainder", () => {
  const input = Array.from(
      { length: SOURCE_REVIEW_GROUP_SIZE * 2 + 1 },
      (_, i) => issue(`i${String(i).padStart(4, "0")}`),
    ),
    r = groupSourceAssemblyReviews(input);
  assert.equal(r.length, 3);
  assert.deepEqual(
    r.map((i) => i.members?.length ?? 1),
    [128, 128, 1],
  );
  assert.equal(new Set(members(r).map((i) => i.id)).size, input.length);
  const parsed = levelSchema.parse(level(r));
  assert.deepEqual(parsed.reconstruction.issues, r);
});
test("group evidence survives saved JSON and schema validation; oversized groups reject", () => {
  const r = groupSourceAssemblyReviews([issue("a"), issue("b")]),
    saved = JSON.parse(JSON.stringify(level(r)));
  assert.deepEqual(levelSchema.parse(saved).reconstruction.issues, r);
  const bad = level([
    {
      ...r[0],
      members: Array.from({ length: 129 }, (_, i) => ({
        id: String(i),
        message: "Check this interval.",
      })),
    },
  ]);
  assert.equal(levelSchema.safeParse(bad).success, false);
});
test("groups remain unresolved and block floor review until an explicit note records the complete review", () => {
  const r = groupSourceAssemblyReviews([issue("a"), issue("b")]),
    model = {
      version: 1,
      units: "feet",
      levels: [level(r)],
      correctionCount: 0,
    };
  assert.ok(
    validateArchitecturalModel(model).some((i) =>
      i.id.includes(":reconstruction:"),
    ),
  );
  assert.notEqual(
    applyFloorplanEdit(model, {
      type: "level.review",
      levelId: "L0",
      reviewed: true,
    }).levels[0].reviewed,
    true,
  );
  const edited = applyFloorplanEdit(model, {
    type: "reconstruction.resolve",
    levelId: "L0",
    issueId: r[0].id,
    note: "Verified both source intervals against the drawing.",
  });
  assert.deepEqual(
    edited.levels[0].reconstruction.issues[0].members,
    r[0].members,
  );
  assert.ok(
    !validateArchitecturalModel(edited).some((i) =>
      i.id.includes(":reconstruction:"),
    ),
  );
});
