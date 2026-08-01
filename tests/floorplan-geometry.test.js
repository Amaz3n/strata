require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  buildSceneGeometry,
  buildLevelGeometry,
  resolveWalkCollision,
  roomFloorTint,
  wallIsExterior,
  EYE_HEIGHT_FT,
  FLOOR_ASSEMBLY_FT,
  WALK_RADIUS_FT,
} = require("../lib/plans/floorplan-geometry")

const SOURCE = {
  sheetVersionId: "sv-1",
  sheetNumber: "A2.1",
  sheetTitle: "First Floor Plan",
  imageWidth: 2400,
  imageHeight: 1800,
  feetPerImagePx: 0.02,
  originPxX: 0,
  originPxY: 0,
}

/** A 20' × 12' box with one interior partition and a door through it. */
function level(overrides = {}) {
  return {
    id: "L0",
    name: "First Floor",
    order: 0,
    ceilingHeightFt: 9,
    source: SOURCE,
    walls: [
      { id: "w1", x0: 0, y0: 0, x1: 20, y1: 0, thicknessFt: 0.5, confidence: 0.9, source: "paired" },
      { id: "w2", x0: 20, y0: 0, x1: 20, y1: 12, thicknessFt: 0.5, confidence: 0.9, source: "paired" },
      { id: "w3", x0: 0, y0: 12, x1: 20, y1: 12, thicknessFt: 0.5, confidence: 0.9, source: "paired" },
      { id: "w4", x0: 0, y0: 0, x1: 0, y1: 12, thicknessFt: 0.5, confidence: 0.9, source: "paired" },
      { id: "w5", x0: 10, y0: 0, x1: 10, y1: 12, thicknessFt: 0.35, confidence: 0.8, source: "paired" },
    ],
    openings: [
      { id: "o1", wallId: "w5", kind: "door", offsetFt: 4, widthFt: 3, sillFt: 0, headFt: 6.75, confidence: 0.9 },
      { id: "o2", wallId: "w1", kind: "window", offsetFt: 2, widthFt: 4, sillFt: 2.5, headFt: 6.75, confidence: 0.8 },
    ],
    rooms: [
      { id: "r1", polygon: [[0, 0], [10, 0], [10, 12], [0, 12]], label: "KITCHEN", areaSqft: 120, confidence: 0.85 },
      { id: "r2", polygon: [[10, 0], [20, 0], [20, 12], [10, 12]], label: null, areaSqft: 120, confidence: 0.5 },
    ],
    confidence: { walls: 0.88, openings: 0.9, rooms: 0.7 },
    ...overrides,
  }
}

function model(levels) {
  return { version: 1, units: "feet", levels, correctionCount: 0 }
}

test("a level produces wall, floor and ceiling meshes with consistent buffers", () => {
  const scene = buildSceneGeometry(model([level()]))
  assert.equal(scene.levels.length, 1)
  const geometry = scene.levels[0]

  for (const mesh of [
    geometry.walls,
    geometry.exteriorWalls,
    geometry.trim,
    geometry.glass,
    geometry.floor,
    geometry.ceiling,
  ]) {
    assert.ok(mesh.positions.length > 0, "mesh has vertices")
    assert.equal(mesh.positions.length, mesh.normals.length, "one normal per vertex")
    assert.equal(mesh.positions.length % 3, 0)
    assert.equal(mesh.indices.length % 3, 0)
    const vertexCount = mesh.positions.length / 3
    for (const index of mesh.indices) {
      assert.ok(index < vertexCount, `index ${index} is out of range`)
    }
    assert.ok(mesh.positions.every((value) => Number.isFinite(value)), "no NaN vertices")
  }
})

test("the model is centred on the origin, so the camera needs no sheet knowledge", () => {
  const scene = buildSceneGeometry(model([level()]))
  const positions = Float32Array.from([
    ...scene.levels[0].walls.positions,
    ...scene.levels[0].exteriorWalls.positions,
  ])
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i])
    maxX = Math.max(maxX, positions[i])
    minZ = Math.min(minZ, positions[i + 2])
    maxZ = Math.max(maxZ, positions[i + 2])
  }
  assert.ok(Math.abs(minX + maxX) < 0.5, `x is off centre: ${minX}..${maxX}`)
  assert.ok(Math.abs(minZ + maxZ) < 0.5, `z is off centre: ${minZ}..${maxZ}`)
  assert.ok(Math.abs(scene.widthFt - 20) < 0.01)
  assert.ok(Math.abs(scene.depthFt - 12) < 0.01)
})

test("geometry never rises above the ceiling or falls through the slab", () => {
  const geometry = buildLevelGeometry(level(), { centerX: 10, centerY: 6, baseY: 0 })
  const heights = []
  for (let i = 1; i < geometry.walls.positions.length; i += 3) heights.push(geometry.walls.positions[i])
  assert.ok(Math.min(...heights) >= -0.001)
  assert.ok(Math.max(...heights) <= 9.001)
})

test("levels stack with a floor assembly between them", () => {
  const upper = level({ id: "L1", name: "Second Floor", order: 1 })
  const scene = buildSceneGeometry(model([level(), upper]))
  assert.equal(scene.levels[0].baseY, 0)
  assert.equal(scene.levels[1].baseY, 9 + FLOOR_ASSEMBLY_FT)
  assert.equal(scene.levels[1].name, "Second Floor")
})

test("both levels share one coordinate frame, so a second storey lands over the first", () => {
  // The upper sheet's plan sits ten feet east of the lower one's.
  const shifted = level({
    id: "L1",
    order: 1,
    walls: level().walls.map((wall) => ({ ...wall, x0: wall.x0 + 10, x1: wall.x1 + 10 })),
    rooms: level().rooms.map((room) => ({
      ...room,
      polygon: room.polygon.map(([x, y]) => [x + 10, y]),
    })),
  })
  const scene = buildSceneGeometry(model([level(), shifted]))
  // A shared frame means the upper storey is offset by exactly that ten feet,
  // not re-centred on top of the lower one.
  const centroid = (geometry) => {
    let sum = 0
    let count = 0
    for (let i = 0; i < geometry.walls.positions.length; i += 3) {
      sum += geometry.walls.positions[i]
      count++
    }
    return sum / count
  }
  assert.ok(Math.abs(centroid(scene.levels[1]) - centroid(scene.levels[0]) - 10) < 0.5)
})

test("labelled rooms become billboards; unnamed ones do not", () => {
  const geometry = buildLevelGeometry(level(), { centerX: 10, centerY: 6, baseY: 0 })
  assert.equal(geometry.labels.length, 1)
  assert.equal(geometry.labels[0].text, "KITCHEN")
  assert.equal(geometry.labels[0].areaSqft, 120)
  assert.ok(geometry.labels[0].y > 0 && geometry.labels[0].y < 9)
  assert.equal(geometry.roomCount, 2)
  assert.equal(geometry.floorAreaSqft, 240)
})

test("a doorway is a genuine gap in collision; a window sill is not", () => {
  const geometry = buildLevelGeometry(level(), { centerX: 10, centerY: 6, baseY: 0 })
  const distanceTo = (point) => {
    let best = Infinity
    for (const segment of geometry.collision) {
      const dx = segment.x1 - segment.x0
      const dz = segment.z1 - segment.z0
      const lenSq = dx * dx + dz * dz
      const t = Math.min(1, Math.max(0, ((point.x - segment.x0) * dx + (point.z - segment.z0) * dz) / lenSq))
      best = Math.min(
        best,
        Math.hypot(point.x - (segment.x0 + t * dx), point.z - (segment.z0 + t * dz)),
      )
    }
    return best
  }
  // Centre of the door on w5: plan (10, 5.5) → world (0, -0.5).
  assert.ok(distanceTo({ x: 0, z: -0.5 }) > 1, "the doorway must be open to the capsule")
  // Centre of the window on w1: plan (4, 0) → world (-6, -6) — the sill blocks.
  assert.ok(distanceTo({ x: -6, z: -6 }) < 0.3, "the window sill must still block walking")
  // Solid stretch of w5 well away from the door: plan (10, 10) → world (0, 4).
  assert.ok(distanceTo({ x: 0, z: 4 }) < 0.3, "solid wall must still collide")
})

test("perimeter walls classify as exterior; partitions do not", () => {
  const fixture = level()
  const rooms = fixture.rooms
  assert.equal(wallIsExterior(fixture.walls[0], rooms), true, "w1 is perimeter")
  assert.equal(wallIsExterior(fixture.walls[4], rooms), false, "w5 is a partition")
  assert.equal(wallIsExterior(fixture.walls[0], []), false, "no rooms, no exterior claim")
  const geometry = buildLevelGeometry(fixture, { centerX: 10, centerY: 6, baseY: 0 })
  assert.ok(geometry.exteriorWalls.indices.length > 0)
  assert.ok(geometry.walls.indices.length > 0)
})

test("openings grow joinery: trim for all, glass only for windows", () => {
  const geometry = buildLevelGeometry(level(), { centerX: 10, centerY: 6, baseY: 0 })
  assert.ok(geometry.trim.indices.length > 0, "jambs and the door leaf exist")
  assert.ok(geometry.glass.indices.length > 0, "the window pane exists")
  const doorless = buildLevelGeometry(level({ openings: [] }), { centerX: 10, centerY: 6, baseY: 0 })
  assert.equal(doorless.trim.indices.length, 0)
  assert.equal(doorless.glass.indices.length, 0)
})

test("floors carry a per-vertex room tint keyed off the label", () => {
  const geometry = buildLevelGeometry(level(), { centerX: 10, centerY: 6, baseY: 0 })
  assert.ok(geometry.floor.colors, "floor mesh has vertex colours")
  assert.equal(geometry.floor.colors.length, geometry.floor.positions.length)
  assert.notDeepEqual(roomFloorTint("KITCHEN"), roomFloorTint(null), "wet rooms tint away from base")
  assert.notDeepEqual(roomFloorTint("GARAGE"), roomFloorTint("BEDROOM 2"))
  assert.deepEqual(roomFloorTint("MYSTERY"), roomFloorTint("GREAT ROOM"), "unknown names read as living space")
})

test("label anchors carry floor-paint placement", () => {
  const geometry = buildLevelGeometry(level(), { centerX: 10, centerY: 6, baseY: 0 })
  const label = geometry.labels[0]
  assert.equal(label.floorY, 0)
  assert.ok(label.fitFt >= 3 && label.fitFt <= 14)
  assert.ok(label.angle === 0 || label.angle === Math.PI / 2)
})

test("walk mode spawns inside a room, not in a wall", () => {
  const geometry = buildLevelGeometry(level(), { centerX: 10, centerY: 6, baseY: 0 })
  assert.ok(geometry.spawn, "a level with rooms has a spawn point")
  for (const segment of geometry.collision) {
    const dx = segment.x1 - segment.x0
    const dz = segment.z1 - segment.z0
    const lenSq = dx * dx + dz * dz
    const t = Math.min(1, Math.max(0, ((geometry.spawn.x - segment.x0) * dx + (geometry.spawn.z - segment.z0) * dz) / lenSq))
    const distance = Math.hypot(
      geometry.spawn.x - (segment.x0 + t * dx),
      geometry.spawn.z - (segment.z0 + t * dz),
    )
    assert.ok(distance >= segment.halfThickness, `spawn sits inside a wall (${distance.toFixed(2)}')`)
  }
})

test("EYE_HEIGHT is a standing viewpoint under any ceiling this model allows", () => {
  assert.ok(EYE_HEIGHT_FT > 4 && EYE_HEIGHT_FT < 6)
})

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

const WALL = [{ x0: -10, z0: 0, x1: 10, z1: 0, halfThickness: 0.25 }]

test("walking into a wall stops at the wall, not through it", () => {
  const resolved = resolveWalkCollision({ x: 0, z: 3 }, { x: 0, z: 0.1 }, WALL)
  assert.ok(resolved.z >= 0.25 + WALK_RADIUS_FT - 1e-6, `ended up at z=${resolved.z}`)
  assert.ok(Math.abs(resolved.x) < 1e-6, "a head-on stop must not drift sideways")
})

test("walking along a wall slides instead of sticking", () => {
  // Aiming diagonally into the wall: the along-wall component survives.
  const resolved = resolveWalkCollision({ x: 0, z: 2 }, { x: 4, z: 0.2 }, WALL)
  assert.ok(resolved.x > 3.5, `slide lost its forward motion (x=${resolved.x})`)
  assert.ok(resolved.z >= 0.25 + WALK_RADIUS_FT - 1e-6)
})

test("free movement is left exactly alone", () => {
  const target = { x: 5, z: 8 }
  assert.deepEqual(resolveWalkCollision({ x: 5, z: 9 }, target, WALL), target)
})

test("an inside corner resolves against both walls", () => {
  const corner = [
    { x0: -10, z0: 0, x1: 10, z1: 0, halfThickness: 0.25 },
    { x0: 0, z0: 0, x1: 0, z1: 10, halfThickness: 0.25 },
  ]
  const resolved = resolveWalkCollision({ x: 3, z: 3 }, { x: 0.2, z: 0.2 }, corner)
  const clearance = 0.25 + WALK_RADIUS_FT - 1e-6
  assert.ok(resolved.z >= clearance, `z=${resolved.z} is inside the south wall`)
  assert.ok(Math.abs(resolved.x) >= clearance, `x=${resolved.x} is inside the east wall`)
})

test("a walker somehow inside a wall is pushed back the way it came", () => {
  const resolved = resolveWalkCollision({ x: 0, z: 2 }, { x: 0, z: 0 }, WALL)
  assert.ok(resolved.z > 0, "pushed out on the side it entered from")
  assert.ok(resolved.z >= 0.25 + WALK_RADIUS_FT - 1e-6)
})

test("an empty model builds an empty scene rather than throwing", () => {
  const scene = buildSceneGeometry(model([]))
  assert.deepEqual(scene.levels, [])
  assert.equal(scene.totalFloorAreaSqft, 0)
  assert.ok(scene.radiusFt > 0, "the camera still needs somewhere to point")
})

test("a level with walls but no traced rooms still builds", () => {
  const geometry = buildLevelGeometry(level({ rooms: [] }), { centerX: 10, centerY: 6, baseY: 0 })
  assert.ok(geometry.walls.indices.length > 0)
  assert.equal(geometry.floor.indices.length, 0)
  assert.equal(geometry.spawn, null)
  assert.equal(geometry.floorAreaSqft, 0)
})
