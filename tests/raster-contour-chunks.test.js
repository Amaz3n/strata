require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  joinRasterContourChunks,
} = require("../lib/drawings/raster-contour-chunks");
test("exact observed chunk endpoints join in either direction with segment-level provenance", () => {
  const chunks = [
      {
        id: 20,
        points: [
          [1, 0],
          [2, 0],
        ],
      },
      {
        id: 10,
        points: [
          [1, 0],
          [0, 0],
        ],
      },
      {
        id: 30,
        points: [
          [3, 0],
          [2, 0],
        ],
      },
    ],
    snapshot = JSON.stringify(chunks);
  const [route] = joinRasterContourChunks(chunks, () => true);
  assert.deepEqual(route.points, [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ]);
  assert.deepEqual(route.segmentPathIds, [10, 20, 30]);
  assert.equal(JSON.stringify(chunks), snapshot);
});
test("white gaps, ambiguous junctions and closed rings never acquire a connecting segment", () => {
  for (const endpoint of [
    [1.00000000001, 0],
    [1, 0.00000000001],
  ]) {
    const routes = joinRasterContourChunks(
      [
        {
          id: 1,
          points: [
            [0, 0],
            [1, 0],
          ],
        },
        { id: 2, points: [endpoint, [2, 0]] },
      ],
      () => true,
    );
    assert.equal(routes.length, 2);
  }
  const branch = [
    {
      id: 1,
      points: [
        [0, 0],
        [1, 0],
      ],
    },
    {
      id: 2,
      points: [
        [1, 0],
        [2, 0],
      ],
    },
    {
      id: 3,
      points: [
        [1, 0],
        [1, 1],
      ],
    },
  ];
  assert.equal(joinRasterContourChunks(branch, () => true).length, 3);
  const ring = {
    id: 4,
    points: [
      [1, 0],
      [2, 1],
      [0, 1],
      [1, 0],
    ],
  };
  assert.equal(
    joinRasterContourChunks([branch[0], branch[1], ring], () => true).length,
    3,
  );
});
test("long contour chains retain each source vertex once and exhaust shared work explicitly", () => {
  const chunks = Array.from({ length: 1000 }, (_, i) => ({
    id: i,
    points: [
      [i, 0],
      [i + 1, 0],
    ],
  }));
  let work = 0;
  const [route] = joinRasterContourChunks(chunks, () => ++work < 10000);
  assert.equal(route.points.length, 1001);
  assert.deepEqual(
    route.segmentPathIds,
    chunks.map((c) => c.id),
  );
  assert.ok(work < 7000);
  let bounded = 0;
  assert.deepEqual(
    joinRasterContourChunks(chunks, () => ++bounded < 1100),
    [],
  );
});
