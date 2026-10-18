require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  triangulatePolygon,
  interiorPoint,
} = require("../lib/drawings/architectural-polygon");
const {
  polygonArea,
  pointInPolygon,
  applyFloorplanEdit,
} = require("../lib/drawings/floorplan-model");
const {
  validateArchitecturalModel,
} = require("../lib/drawings/architectural-validation");
const {
  buildLevelGeometry,
  placeLevel,
  isWalkable,
} = require("../lib/plans/floorplan-geometry");
const {
  floorplanModelSchema,
  sourceSelectionsSchema,
} = require("../lib/validation/floorplan");
const ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];
function fixture() {
  return {
    version: 1,
    units: "feet",
    correctionCount: 0,
    levels: [
      {
        id: "L0",
        name: "Ground floor",
        order: 0,
        ceilingHeightFt: 9,
        reviewed: true,
        source: {
          sheetVersionId: "s",
          sheetNumber: null,
          sheetTitle: null,
          imageWidth: 1000,
          imageHeight: 1000,
          feetPerImagePx: 0.01,
          originPxX: 0,
          originPxY: 0,
          scaleConfirmed: true,
        },
        walls: ring.map((p, i) => ({
          id: `w${i}`,
          x0: p[0],
          y0: p[1],
          x1: ring[(i + 1) % 4][0],
          y1: ring[(i + 1) % 4][1],
          thicknessFt: 0.5,
          confidence: 1,
          source: "manual",
        })),
        rooms: [
          {
            id: "r",
            polygon: ring,
            label: "Living",
            areaSqft: 100,
            confidence: 1,
          },
        ],
        openings: [],
        confidence: { walls: 1, rooms: 1, openings: 1 },
      },
    ],
  };
}
function triangleArea(ring, holes = []) {
  const { points, indices } = triangulatePolygon(ring, holes);
  let area = 0;
  for (let i = 0; i < indices.length; i += 3)
    area += polygonArea(indices.slice(i, i + 3).map((j) => points[j]));
  return area;
}
test('window width provenance survives persistence and changes only when its measured width is edited',()=>{
 const model=fixture(),opening={id:'window',wallId:'w0',kind:'window',offsetFt:2,widthFt:5.36,widthBasis:'connected-frame',sillFt:3,headFt:7,confidence:.7}
 model.levels[0].openings=[opening]
 const saved=floorplanModelSchema.parse(JSON.parse(JSON.stringify(model)))
 assert.equal(saved.levels[0].openings[0].widthBasis,'connected-frame')
 const style=applyFloorplanEdit(saved,{type:'opening.upsert',levelId:'L0',opening:{...opening,style:'sliding'}})
 assert.equal(style.levels[0].openings[0].widthBasis,'connected-frame')
 const changed=applyFloorplanEdit(saved,{type:'opening.upsert',levelId:'L0',opening:{...opening,widthFt:5}})
 assert.equal(changed.levels[0].openings[0].widthBasis,'manual')
 assert.equal(model.levels[0].openings[0].widthBasis,'connected-frame')
 const legacy=structuredClone(model);delete legacy.levels[0].openings[0].widthBasis
 assert.equal(floorplanModelSchema.safeParse(legacy).success,true)
 const invented=structuredClone(model);invented.levels[0].openings[0].widthBasis='verified-schedule'
 assert.equal(floorplanModelSchema.safeParse(invented).success,false)
})
test("concave U-shaped rooms triangulate without filling the courtyard", () => {
  const u = [
    [0, 0],
    [10, 0],
    [10, 10],
    [7, 10],
    [7, 3],
    [3, 3],
    [3, 10],
    [0, 10],
  ];
  assert.equal(triangleArea(u), 72);
  assert.ok(pointInPolygon(interiorPoint(u), u));
});
test("floor voids are excluded from triangles and walking", () => {
  const hole = [
    [3, 3],
    [7, 3],
    [7, 7],
    [3, 7],
  ];
  assert.equal(triangleArea(ring, [hole]), 84);
  const model = fixture();
  model.levels[0].rooms[0].holes = [hole];
  const geometry = buildLevelGeometry(model.levels[0], {
    centerX: 0,
    centerY: 0,
    baseY: 0,
  });
  assert.equal(isWalkable(geometry, 5, 5), false);
  assert.equal(isWalkable(geometry, 2, 2), true);
  assert.equal(geometry.floorAreaSqft, 84);
  const p = interiorPoint(ring, [hole]);
  assert.ok(!pointInPolygon(p, hole));
});
test("source limitations require explicit acknowledgment and remain in the document", () => {
  const model = fixture();
  model.warnings = ["Scan requires comparison with the source."];
  assert.equal(validateArchitecturalModel(model).length, 1);
  const reviewed = applyFloorplanEdit(model, {
    type: "source.review",
    levelId: "L0",
    warning: model.warnings[0],
    acknowledged: true,
  });
  assert.deepEqual(validateArchitecturalModel(reviewed), []);
  assert.deepEqual(reviewed.warnings, model.warnings);
  assert.equal(
    floorplanModelSchema.parse(reviewed).acknowledgedWarnings.length,
    1,
  );
  reviewed.warnings.push("A different source was skipped.");
  assert.equal(validateArchitecturalModel(reviewed).length, 1);
});
test("geometry edits invalidate floor review while material edits preserve it", () => {
  const model = fixture();
  const finish = {
    color: "#ffffff",
    pattern: "solid",
    scaleFt: 1,
    roughness: 0.8,
  };
  const cosmetic = applyFloorplanEdit(model, {
    type: "wall.update",
    levelId: "L0",
    wallId: "w0",
    changes: { finish },
  });
  assert.equal(cosmetic.levels[0].reviewed, true);
  const geometric = applyFloorplanEdit(model, {
    type: "wall.update",
    levelId: "L0",
    wallId: "w0",
    changes: { heightFt: 10 },
  });
  assert.equal(geometric.levels[0].reviewed, false);
});
test("hosted openings reject overlap and shortening their wall", () => {
  const opening = {
    id: "o",
    wallId: "w0",
    kind: "door",
    offsetFt: 2,
    widthFt: 3,
    sillFt: 0,
    headFt: 7,
    confidence: 1,
  };
  const model = applyFloorplanEdit(fixture(), {
    type: "opening.upsert",
    levelId: "L0",
    opening,
  });
  assert.equal(model.levels[0].openings.length, 1);
  assert.equal(
    applyFloorplanEdit(model, {
      type: "opening.upsert",
      levelId: "L0",
      opening: { ...opening, id: "overlap", offsetFt: 4 },
    }),
    model,
  );
  assert.equal(
    applyFloorplanEdit(model, {
      type: "wall.update",
      levelId: "L0",
      wallId: "w0",
      changes: { x1: 4 },
    }),
    model,
  );
});
test("scale corrections resize plan geometry and voids but preserve explicit heights", () => {
  const model = fixture();
  model.levels[0].rooms[0].holes = [
    [
      [2, 2],
      [3, 2],
      [3, 3],
      [2, 3],
    ],
  ];
  const scaled = applyFloorplanEdit(model, {
    type: "level.scale",
    levelId: "L0",
    feetPerImagePx: 0.02,
  }).levels[0];
  assert.equal(scaled.walls[0].x1, 20);
  assert.deepEqual(scaled.rooms[0].holes[0][0], [4, 4]);
  assert.equal(scaled.ceilingHeightFt, 9);
  assert.equal(scaled.reviewed, false);
});
test("floor registration applies rotation and translation in one coordinate system", () => {
  const level = fixture().levels[0];
  level.placement = {
    xFt: 20,
    yFt: 30,
    rotationDeg: 90,
    elevationFt: 12,
    assemblyFt: 1,
    confirmed: true,
  };
  const placed = placeLevel(level);
  assert.ok(Math.abs(placed.walls[0].x1 - 20) < 1e-8);
  assert.ok(Math.abs(placed.walls[0].y1 - 40) < 1e-8);
});
test("intersecting voids fail the publish gate", () => {
  const model = fixture();
  model.levels[0].rooms[0].holes = [
    [
      [2, 2],
      [6, 2],
      [6, 6],
      [2, 6],
    ],
    [
      [4, 4],
      [8, 4],
      [8, 8],
      [4, 8],
    ],
  ];
  assert.ok(
    validateArchitecturalModel(model).some((i) => i.severity === "error"),
  );
});

test("walking crosses a doorway between takeoff wall-face room boundaries", () => {
  const level = fixture().levels[0];
  level.walls.push({
    id: "partition",
    x0: 5,
    y0: 0,
    x1: 5,
    y1: 10,
    thicknessFt: 0.5,
    confidence: 1,
    source: "manual",
  });
  level.rooms = [
    {
      id: "left",
      polygon: [
        [0, 0],
        [4.75, 0],
        [4.75, 10],
        [0, 10],
      ],
      areaSqft: 47.5,
      label: null,
      confidence: 1,
    },
    {
      id: "right",
      polygon: [
        [5.25, 0],
        [10, 0],
        [10, 10],
        [5.25, 10],
      ],
      areaSqft: 47.5,
      label: null,
      confidence: 1,
    },
  ];
  level.openings = [
    {
      id: "door",
      wallId: "partition",
      kind: "door",
      offsetFt: 3,
      widthFt: 3,
      sillFt: 0,
      headFt: 7,
      confidence: 1,
    },
  ];
  const geometry = buildLevelGeometry(level, {
    centerX: 0,
    centerY: 0,
    baseY: 0,
  });
  assert.equal(isWalkable(geometry, 5, 4.5), true);
  assert.equal(isWalkable(geometry, 5, 8), false);
});

test("door handedness, double leaves and pocket style change joinery geometry", () => {
  const level = fixture().levels[0];
  const make = (style, handing = "left") =>
    buildLevelGeometry(
      {
        ...level,
        openings: [
          {
            id: "o",
            wallId: "w0",
            kind: "door",
            offsetFt: 2,
            widthFt: 4,
            sillFt: 0,
            headFt: 7,
            confidence: 1,
            style,
            handing,
          },
        ],
      },
      { centerX: 0, centerY: 0, baseY: 0 },
    ).trim;
  const left = make("hinged"),
    right = make("hinged", "right"),
    double = make("double"),
    pocket = make("pocket");
  assert.notDeepEqual(left.positions, right.positions);
  assert.ok(double.indices.length > left.indices.length);
  assert.ok(pocket.indices.length < left.indices.length);
});
