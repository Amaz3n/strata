require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  interpretLevel,
  interpretFloorplan,
  roomLabelFromText,
  selectFloorplanSheets,
  detectDoorArcs,
  closePerimeterGaps,
} = require("../lib/drawings/floorplan-interpret")
const {
  applyFloorplanEdit,
  extractRoomPolygons,
  wallSolidSpans,
  modelToImagePx,
  imagePxToModel,
  polygonArea,
  pointInPolygon,
  modelConfidence,
} = require("../lib/drawings/floorplan-model")
const { encodeTextRuns, parseTextRuns } = require("../lib/drawings/text-runs")

// ---------------------------------------------------------------------------
// Fixture builder
//
// Plans are authored here in FEET and encoded down into the normalized
// vectors.bin space the pipeline actually stores, so the fixtures read like a
// floorplan and the code under test sees exactly what production hands it.
// ---------------------------------------------------------------------------

const IMAGE = { width: 2400, height: 1800 }
/** 0.02 ft per rendered pixel → a 48' × 36' sheet area. */
const FEET_PER_PX = 0.02

class PlanBuilder {
  constructor() {
    this.segments = []
    this.flags = []
    this.textRuns = []
  }

  /** One drawn line, in feet. */
  line(x0, y0, x1, y1, { dashed = false, filled = false } = {}) {
    this.segments.push(
      x0 / (IMAGE.width * FEET_PER_PX),
      y0 / (IMAGE.height * FEET_PER_PX),
      x1 / (IMAGE.width * FEET_PER_PX),
      y1 / (IMAGE.height * FEET_PER_PX),
    )
    this.flags.push((dashed ? 1 : 0) | (filled ? 2 : 0))
    return this
  }

  /**
   * A double-line wall run: two parallel faces `thickness` apart, drawn along
   * (x0,y0)→(x1,y1) with `gaps` (offset, width) left open for doors/windows.
   */
  wall(x0, y0, x1, y1, { thickness = 0.5, gaps = [] } = {}) {
    const length = Math.hypot(x1 - x0, y1 - y0)
    const ux = (x1 - x0) / length
    const uy = (y1 - y0) / length
    const nx = (-uy * thickness) / 2
    const ny = (ux * thickness) / 2

    const spans = []
    let cursor = 0
    for (const [offset, width] of [...gaps].sort((a, b) => a[0] - b[0])) {
      if (offset > cursor) spans.push([cursor, offset])
      cursor = offset + width
    }
    if (cursor < length) spans.push([cursor, length])

    for (const [start, end] of spans) {
      for (const side of [1, -1]) {
        this.line(
          x0 + ux * start + nx * side,
          y0 + uy * start + ny * side,
          x0 + ux * end + nx * side,
          y0 + uy * end + ny * side,
        )
      }
    }
    return this
  }

  /** A door swing: a quarter-circle sampled at 8 chords, as MuPDF flattens it. */
  doorArc(cx, cy, radius, startAngle) {
    let prevX = cx + radius * Math.cos(startAngle)
    let prevY = cy + radius * Math.sin(startAngle)
    for (let i = 1; i <= 8; i++) {
      const angle = startAngle + (Math.PI / 2) * (i / 8)
      const x = cx + radius * Math.cos(angle)
      const y = cy + radius * Math.sin(angle)
      this.line(prevX, prevY, x, y)
      prevX = x
      prevY = y
    }
    return this
  }

  /** Glazing lines drawn inside a window opening, along the wall. */
  glazing(x0, y0, x1, y1) {
    const length = Math.hypot(x1 - x0, y1 - y0)
    const ux = (x1 - x0) / length
    const uy = (y1 - y0) / length
    for (const offset of [-0.12, 0.12]) {
      this.line(x0 - uy * offset, y0 + ux * offset, x1 - uy * offset, y1 + ux * offset)
    }
    return this
  }

  label(text, x, y, size = 0.9) {
    this.textRuns.push({
      text,
      x: (x - 2) / (IMAGE.width * FEET_PER_PX),
      y: (y - size / 2) / (IMAGE.height * FEET_PER_PX),
      w: 4 / (IMAGE.width * FEET_PER_PX),
      h: size / (IMAGE.height * FEET_PER_PX),
    })
    return this
  }

  input(overrides = {}) {
    return {
      sheetVersionId: "sv-1",
      sheetNumber: "A2.1",
      sheetTitle: "First Floor Plan",
      name: "First Floor",
      order: 0,
      imageWidth: IMAGE.width,
      imageHeight: IMAGE.height,
      feetPerImagePx: FEET_PER_PX,
      segments: Float32Array.from(this.segments),
      flags: Uint8Array.from(this.flags),
      textRuns: this.textRuns,
      ...overrides,
    }
  }
}

/**
 * A 24' × 16' two-room house: an outer shell, one interior partition with a
 * 3' door, and a 4' window on the south wall.
 *
 *   (0,0) ┌──────────────┬──────────┐ (24,0)
 *         │   KITCHEN    │  BEDROOM │
 *         │              ╪ (door)   │
 *   (0,16)└──────═══─────┴──────────┘ (24,16)
 *                window
 */
function twoRoomHouse() {
  const plan = new PlanBuilder()
  plan.wall(0, 0, 24, 0, { thickness: 0.5 })
  plan.wall(24, 0, 24, 16, { thickness: 0.5 })
  plan.wall(0, 16, 24, 16, { thickness: 0.5, gaps: [[8, 4]] })
  plan.glazing(8, 16, 12, 16)
  plan.wall(0, 0, 0, 16, { thickness: 0.5 })
  plan.wall(14, 0, 14, 16, { thickness: 0.35, gaps: [[6, 3]] })
  plan.doorArc(14, 6, 3, 0)
  plan.label("KITCHEN", 7, 8)
  plan.label("BEDROOM", 19, 8)
  plan.label("12'-0\" x 14'-0\"", 7, 9.2, 0.5)
  return plan
}

// ---------------------------------------------------------------------------
// Wall extraction
// ---------------------------------------------------------------------------

test("interprets a two-room house into walls, rooms, and openings", () => {
  const level = interpretLevel(twoRoomHouse().input())

  assert.equal(level.name, "First Floor")
  assert.equal(level.ceilingHeightFt, 9)
  assert.ok(level.walls.length >= 5, `expected at least 5 walls, got ${level.walls.length}`)
  assert.ok(
    level.walls.every((wall) => wall.source === "paired"),
    "double-line drafting must produce paired walls, not the single-line fallback",
  )

  // Two rooms: 14' × 16' and 10' × 16', measured to the wall centerlines.
  assert.equal(level.rooms.length, 2, `expected 2 rooms, got ${level.rooms.length}`)
  const areas = level.rooms.map((room) => room.areaSqft).sort((a, b) => b - a)
  assert.ok(Math.abs(areas[0] - 224) < 25, `large room ${areas[0]} sf off expected ~224`)
  assert.ok(Math.abs(areas[1] - 160) < 25, `small room ${areas[1]} sf off expected ~160`)

  const labels = level.rooms.map((room) => room.label).sort()
  assert.deepEqual(labels, ["BEDROOM", "KITCHEN"])
})

test("wall thickness is recovered in real-world inches", () => {
  const level = interpretLevel(twoRoomHouse().input())
  const exterior = level.walls.filter((wall) => wall.thicknessFt > 0.42)
  assert.ok(exterior.length >= 4, "the four 6\" shell walls should survive as thick walls")
  for (const wall of level.walls) {
    assert.ok(wall.thicknessFt >= 0.25 && wall.thicknessFt <= 1.2, `implausible thickness ${wall.thicknessFt}`)
  }
})

test("a door swing arc classifies its opening as a door", () => {
  const level = interpretLevel(twoRoomHouse().input())
  const doors = level.openings.filter((opening) => opening.kind === "door")
  assert.ok(doors.length >= 1, "the arc-marked 3' gap must read as a door")
  const door = doors[0]
  assert.ok(Math.abs(door.widthFt - 3) < 0.6, `door width ${door.widthFt} off expected 3'`)
  assert.equal(door.sillFt, 0)
  assert.ok(door.confidence >= 0.9, "arc evidence should be high confidence")
})

test("glazing lines classify their opening as a window", () => {
  const level = interpretLevel(twoRoomHouse().input())
  const windows = level.openings.filter((opening) => opening.kind === "window")
  assert.ok(windows.length >= 1, "the glazed 4' gap must read as a window")
  assert.ok(windows[0].sillFt > 2, "a window floats off the floor")
})

test("openings land inside their wall", () => {
  const level = interpretLevel(twoRoomHouse().input())
  assert.ok(level.openings.length >= 2)
  for (const opening of level.openings) {
    const wall = level.walls.find((candidate) => candidate.id === opening.wallId)
    assert.ok(wall, `opening ${opening.id} references a missing wall`)
    const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0)
    assert.ok(opening.offsetFt >= 0, `offset ${opening.offsetFt} is negative`)
    assert.ok(
      opening.offsetFt + opening.widthFt <= length + 0.5,
      `opening runs past the end of its ${length.toFixed(1)}' wall`,
    )
  }
})

test("dashed drafting is excluded from the wall graph", () => {
  const plan = twoRoomHouse()
  // A dashed upper-cabinet outline through the middle of the kitchen.
  for (const dy of [-0.25, 0.25]) {
    plan.line(1, 4 + dy, 13, 4 + dy, { dashed: true })
  }
  const level = interpretLevel(plan.input())
  assert.equal(level.rooms.length, 2, "a dashed line must not cut the kitchen in two")
})

const perimeterWall = (id, x0, y0, x1, y1) => ({
  id,
  x0,
  y0,
  x1,
  y1,
  thicknessFt: 0.5,
  confidence: 0.9,
  source: "paired",
})

test("a collinear break in a straight run is bridged shut", () => {
  // A 20' × 12' rectangle whose south wall has a 6' bite out of it.
  const walls = [
    perimeterWall("w1", 0, 0, 8, 0),
    perimeterWall("w2", 14, 0, 20, 0),
    perimeterWall("w3", 20, 0, 20, 12),
    perimeterWall("w4", 20, 12, 0, 12),
    perimeterWall("w5", 0, 12, 0, 0),
  ]
  const closed = closePerimeterGaps(walls)
  const bridge = closed.find((wall) => wall.id.startsWith("wb"))
  assert.ok(bridge, "the gap grows a bridge wall")
  assert.ok(bridge.confidence < 0.5, "a bridge must look inferred in review")
  assert.equal(extractRoomPolygons(closed).length, 1, "the room closes")
})

test("an open end aimed at another wall extends until it lands", () => {
  // The east wall stops 3' short of the south wall.
  const walls = [
    perimeterWall("w1", 0, 0, 20, 0),
    perimeterWall("w2", 20, 3, 20, 12),
    perimeterWall("w3", 20, 12, 0, 12),
    perimeterWall("w4", 0, 12, 0, 0),
  ]
  const closed = closePerimeterGaps(walls)
  const bridge = closed.find((wall) => wall.id.startsWith("wb"))
  assert.ok(bridge, "the short corner grows a bridge")
  assert.equal(extractRoomPolygons(closed).length, 1, "the room closes")
})

test("parallel walls that merely end near each other are never bridged", () => {
  const walls = [
    perimeterWall("w1", 0, 0, 10, 0),
    perimeterWall("w2", 0, 3, 10, 3),
  ]
  const closed = closePerimeterGaps(walls)
  assert.equal(closed.length, 2, "no bridge between parallel neighbours")
})

test("hairline corner gaps are closed rather than losing the room", () => {
  const plan = new PlanBuilder()
  // The same shell, but every run stops 4" short of the corner.
  plan.wall(0.33, 0, 23.67, 0, { thickness: 0.5 })
  plan.wall(24, 0.33, 24, 15.67, { thickness: 0.5 })
  plan.wall(0.33, 16, 23.67, 16, { thickness: 0.5 })
  plan.wall(0, 0.33, 0, 15.67, { thickness: 0.5 })
  const level = interpretLevel(plan.input())
  assert.equal(level.rooms.length, 1, "a 4\" drafting gap must not open the shell")
  assert.ok(Math.abs(level.rooms[0].areaSqft - 384) < 40)
})

test("a rotated plan is straightened onto its own drafting grid", () => {
  const angle = (14 * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rotate = (x, y) => [8 + x * cos - y * sin, 4 + x * sin + y * cos]
  const plan = new PlanBuilder()
  const shell = [
    [0, 0, 20, 0],
    [20, 0, 20, 14],
    [0, 14, 20, 14],
    [0, 0, 0, 14],
  ]
  for (const [x0, y0, x1, y1] of shell) {
    const [ax, ay] = rotate(x0, y0)
    const [bx, by] = rotate(x1, y1)
    plan.wall(ax, ay, bx, by, { thickness: 0.5 })
  }
  const level = interpretLevel(plan.input())
  assert.equal(level.rooms.length, 1)
  assert.ok(Math.abs(level.rooms[0].areaSqft - 280) < 35)
})

test("an uncalibrated sheet returns an empty level, never a wrong one", () => {
  const level = interpretLevel(twoRoomHouse().input({ feetPerImagePx: 0 }))
  assert.deepEqual(level.walls, [])
  assert.deepEqual(level.rooms, [])
  assert.equal(level.confidence.walls, 0)
})

test("a sheet with no vectors returns an empty level", () => {
  const level = interpretLevel(new PlanBuilder().input())
  assert.deepEqual(level.walls, [])
})

test("dimension strings and notes never become room labels", () => {
  const plan = twoRoomHouse()
  plan.label("SCALE: 1/4\" = 1'-0\"", 7, 6, 0.4)
  plan.label("A3", 19, 6, 0.4)
  const level = interpretLevel(plan.input())
  for (const room of level.rooms) {
    assert.ok(!/scale|^A3$/i.test(room.label ?? ""), `bad label ${room.label}`)
  }
})

// ---------------------------------------------------------------------------
// Label lexicon
// ---------------------------------------------------------------------------

test("roomLabelFromText accepts room nouns and rejects everything else", () => {
  assert.equal(roomLabelFromText("KITCHEN"), "KITCHEN")
  assert.equal(roomLabelFromText("MASTER BEDROOM"), "MASTER BEDROOM")
  assert.equal(roomLabelFromText("Bedroom 2"), "Bedroom 2")
  assert.equal(roomLabelFromText("BEDROOM 3 12'-0\" x 11'-6\""), "BEDROOM 3")
  assert.equal(roomLabelFromText("2-CAR GARAGE"), "2-CAR GARAGE")

  assert.equal(roomLabelFromText("12'-0\" x 14'-0\""), null)
  assert.equal(roomLabelFromText("SCALE: 1/4\" = 1'-0\""), null)
  assert.equal(roomLabelFromText("A101"), null)
  assert.equal(roomLabelFromText("7"), null)
  assert.equal(roomLabelFromText(""), null)
  assert.equal(roomLabelFromText("NORTH"), null)
  assert.equal(roomLabelFromText("SEE STRUCTURAL DRAWINGS FOR HEADER SIZES"), null)
})

// ---------------------------------------------------------------------------
// Arc detection
// ---------------------------------------------------------------------------

test("detectDoorArcs finds a sampled quarter circle and rejects a corner", () => {
  const chords = []
  let prev = [3, 0]
  for (let i = 1; i <= 8; i++) {
    const angle = (Math.PI / 2) * (i / 8)
    const point = [3 * Math.cos(angle), 3 * Math.sin(angle)]
    chords.push({ x0: prev[0], y0: prev[1], x1: point[0], y1: point[1] })
    prev = point
  }
  const arcs = detectDoorArcs(chords)
  assert.equal(arcs.length, 1)
  assert.ok(Math.abs(arcs[0].radius - 3) < 0.15)
  assert.ok(Math.hypot(arcs[0].cx, arcs[0].cy) < 0.15)

  const corner = [
    { x0: 0, y0: 0, x1: 1, y1: 0 },
    { x0: 1, y0: 0, x1: 1, y1: 1 },
  ]
  assert.deepEqual(detectDoorArcs(corner), [])
})

// ---------------------------------------------------------------------------
// Sheet selection
// ---------------------------------------------------------------------------

test("selectFloorplanSheets requires both a plan title and traceable rooms", () => {
  const selected = selectFloorplanSheets([
    { sheetVersionId: "a", sheetNumber: "A2.1", sheetTitle: "First Floor Plan", discipline: "A", pageIndex: 4, roomSizedLoopCount: 12, hasVectors: true },
    { sheetVersionId: "b", sheetNumber: "A2.2", sheetTitle: "Second Floor Plan", discipline: "A", pageIndex: 5, roomSizedLoopCount: 9, hasVectors: true },
    { sheetVersionId: "c", sheetNumber: "A3.1", sheetTitle: "Exterior Elevations", discipline: "A", pageIndex: 6, roomSizedLoopCount: 8, hasVectors: true },
    { sheetVersionId: "d", sheetNumber: "A2.4", sheetTitle: "Reflected Ceiling Plan", discipline: "A", pageIndex: 7, roomSizedLoopCount: 11, hasVectors: true },
    { sheetVersionId: "e", sheetNumber: "S1.1", sheetTitle: "Foundation Plan", discipline: "S", pageIndex: 2, roomSizedLoopCount: 6, hasVectors: true },
    { sheetVersionId: "f", sheetNumber: "A2.3", sheetTitle: "Roof Plan", discipline: "A", pageIndex: 8, roomSizedLoopCount: 5, hasVectors: true },
    { sheetVersionId: "g", sheetNumber: "A2.0", sheetTitle: "First Floor Plan", discipline: "A", pageIndex: 3, roomSizedLoopCount: 1, hasVectors: true },
    { sheetVersionId: "h", sheetNumber: "A2.5", sheetTitle: "Main Level Plan", discipline: "A", pageIndex: 9, roomSizedLoopCount: 10, hasVectors: false },
  ])

  assert.deepEqual(
    selected.map((sheet) => sheet.sheetVersionId),
    ["a", "b"],
  )
  assert.deepEqual(
    selected.map((sheet) => sheet.levelName),
    ["First Floor", "Second Floor"],
  )
  assert.deepEqual(selected.map((sheet) => sheet.order), [0, 1])
})

test("selectFloorplanSheets returns nothing rather than guessing", () => {
  assert.deepEqual(selectFloorplanSheets([]), [])
  assert.deepEqual(
    selectFloorplanSheets([
      { sheetVersionId: "x", sheetNumber: "A1", sheetTitle: "Cover Sheet", discipline: "A", pageIndex: 0, roomSizedLoopCount: 0, hasVectors: true },
    ]),
    [],
  )
})

// ---------------------------------------------------------------------------
// Model geometry
// ---------------------------------------------------------------------------

test("extractRoomPolygons finds four cells in a two-by-two grid", () => {
  const walls = [
    ["w1", 0, 0, 20, 0],
    ["w2", 0, 20, 20, 20],
    ["w3", 0, 0, 0, 20],
    ["w4", 20, 0, 20, 20],
    ["w5", 10, 0, 10, 20],
    ["w6", 0, 10, 20, 10],
  ].map(([id, x0, y0, x1, y1]) => ({ id, x0, y0, x1, y1, thicknessFt: 0.5, confidence: 1, source: "paired" }))

  const polygons = extractRoomPolygons(walls)
  assert.equal(polygons.length, 4)
  for (const polygon of polygons) {
    assert.ok(Math.abs(polygonArea(polygon) - 100) < 0.01)
  }
})

test("extractRoomPolygons ignores a stub wall that encloses nothing", () => {
  const walls = [
    ["w1", 0, 0, 20, 0],
    ["w2", 0, 20, 20, 20],
    ["w3", 0, 0, 0, 20],
    ["w4", 20, 0, 20, 20],
    ["w5", 10, 0, 10, 6],
  ].map(([id, x0, y0, x1, y1]) => ({ id, x0, y0, x1, y1, thicknessFt: 0.5, confidence: 1, source: "paired" }))
  const polygons = extractRoomPolygons(walls)
  assert.equal(polygons.length, 1)
  assert.ok(Math.abs(polygonArea(polygons[0]) - 400) < 0.01)
})

test("wallSolidSpans splits a wall around its openings instead of subtracting", () => {
  const wall = { id: "w1", x0: 0, y0: 0, x1: 20, y1: 0, thicknessFt: 0.5, confidence: 1, source: "paired" }
  const openings = [
    { id: "o1", wallId: "w1", kind: "door", offsetFt: 5, widthFt: 3, sillFt: 0, headFt: 6.75, confidence: 1 },
    { id: "o2", wallId: "w1", kind: "window", offsetFt: 12, widthFt: 4, sillFt: 2.5, headFt: 6.75, confidence: 1 },
  ]
  const spans = wallSolidSpans(wall, openings, 9)

  // 0–5 solid, 5–8 header, 8–12 solid, 12–16 sill + header, 16–20 solid.
  assert.equal(spans.length, 6)
  const full = spans.filter((span) => span.bottomFt === 0 && span.topFt === 9)
  assert.equal(full.length, 3)
  const header = spans.find((span) => span.startFt === 5 && span.bottomFt === 6.75)
  assert.ok(header, "a door needs a header above it")
  assert.equal(header.topFt, 9)
  const sill = spans.find((span) => span.startFt === 12 && span.bottomFt === 0)
  assert.ok(sill, "a window needs a sill block below it")
  assert.equal(sill.topFt, 2.5)

  // Nothing is built inside an opening.
  const openArea = spans.some((span) => span.startFt >= 5 && span.endFt <= 8 && span.bottomFt < 6.75)
  assert.equal(openArea, false)
})

test("wallSolidSpans leaves a wall whole when it has no openings", () => {
  const wall = { id: "w1", x0: 0, y0: 0, x1: 12, y1: 0, thicknessFt: 0.5, confidence: 1, source: "paired" }
  assert.deepEqual(wallSolidSpans(wall, [], 9), [{ startFt: 0, endFt: 12, bottomFt: 0, topFt: 9 }])
})

test("model coordinates round-trip through the source sheet", () => {
  const level = interpretLevel(twoRoomHouse().input())
  const px = modelToImagePx(level.source, 10, 6)
  const back = imagePxToModel(level.source, px.x, px.y)
  assert.ok(Math.abs(back.x - 10) < 1e-6)
  assert.ok(Math.abs(back.y - 6) < 1e-6)
})

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

test("deleting a wall re-derives the rooms and carries labels across", () => {
  const level = interpretLevel(twoRoomHouse().input())
  const model = { version: 1, units: "feet", levels: [level], correctionCount: 0 }

  const partition = level.walls.find((wall) => wall.thicknessFt < 0.42)
  assert.ok(partition, "the fixture has a thinner interior partition")

  const edited = applyFloorplanEdit(model, { type: "wall.delete", levelId: level.id, wallId: partition.id })
  assert.equal(edited.correctionCount, 1)
  assert.equal(edited.levels[0].rooms.length, 1, "removing the partition merges the two rooms")
  assert.ok(
    ["KITCHEN", "BEDROOM"].includes(edited.levels[0].rooms[0].label),
    "the surviving room keeps one of the two names",
  )
  assert.equal(
    edited.levels[0].openings.some((opening) => opening.wallId === partition.id),
    false,
    "a deleted wall takes its openings with it",
  )
  assert.equal(model.levels[0].walls.length, level.walls.length, "the input model is never mutated")
})

test("drawing a wall splits a room in two", () => {
  const plan = new PlanBuilder()
  plan.wall(0, 0, 24, 0, { thickness: 0.5 })
  plan.wall(24, 0, 24, 16, { thickness: 0.5 })
  plan.wall(0, 16, 24, 16, { thickness: 0.5 })
  plan.wall(0, 0, 0, 16, { thickness: 0.5 })
  const level = interpretLevel(plan.input())
  assert.equal(level.rooms.length, 1)

  const model = { version: 1, units: "feet", levels: [level], correctionCount: 0 }
  const edited = applyFloorplanEdit(model, {
    type: "wall.add",
    levelId: level.id,
    x0: 12,
    y0: 0.25,
    x1: 12,
    y1: 15.75,
  })
  assert.equal(edited.levels[0].rooms.length, 2)
  assert.equal(edited.levels[0].walls.at(-1).source, "manual")
  assert.equal(edited.levels[0].walls.at(-1).confidence, 1)
})

test("opening kind, room label, ceiling height, and level name are editable", () => {
  const level = interpretLevel(twoRoomHouse().input())
  let model = { version: 1, units: "feet", levels: [level], correctionCount: 0 }

  const opening = level.openings[0]
  model = applyFloorplanEdit(model, { type: "opening.set", levelId: level.id, openingId: opening.id, kind: "cased" })
  const changed = model.levels[0].openings.find((item) => item.id === opening.id)
  assert.equal(changed.kind, "cased")
  assert.equal(changed.headFt, 6.75)

  const room = model.levels[0].rooms[0]
  model = applyFloorplanEdit(model, { type: "room.label", levelId: level.id, roomId: room.id, label: "  Great Room  " })
  assert.equal(model.levels[0].rooms.find((item) => item.id === room.id).label, "Great Room")

  model = applyFloorplanEdit(model, { type: "level.height", levelId: level.id, ceilingHeightFt: 10 })
  assert.equal(model.levels[0].ceilingHeightFt, 10)

  model = applyFloorplanEdit(model, { type: "level.name", levelId: level.id, name: "Main Level" })
  assert.equal(model.levels[0].name, "Main Level")
  assert.equal(model.correctionCount, 4)
})

test("ceiling height is clamped to something buildable", () => {
  const level = interpretLevel(twoRoomHouse().input())
  const model = { version: 1, units: "feet", levels: [level], correctionCount: 0 }
  assert.equal(applyFloorplanEdit(model, { type: "level.height", levelId: level.id, ceilingHeightFt: 200 }).levels[0].ceilingHeightFt, 20)
  assert.equal(applyFloorplanEdit(model, { type: "level.height", levelId: level.id, ceilingHeightFt: 1 }).levels[0].ceilingHeightFt, 6)
})

test("a stale edit is a no-op that returns the same model", () => {
  const level = interpretLevel(twoRoomHouse().input())
  const model = { version: 1, units: "feet", levels: [level], correctionCount: 0 }
  assert.equal(applyFloorplanEdit(model, { type: "wall.delete", levelId: level.id, wallId: "nope" }), model)
  assert.equal(applyFloorplanEdit(model, { type: "wall.delete", levelId: "nope", wallId: "w1" }), model)
  assert.equal(
    applyFloorplanEdit(model, { type: "wall.add", levelId: level.id, x0: 0, y0: 0, x1: 0.1, y1: 0 }),
    model,
    "a two-inch wall is a mis-click, not a wall",
  )
})

// ---------------------------------------------------------------------------
// Whole-model plumbing
// ---------------------------------------------------------------------------

test("interpretFloorplan stacks levels and scores the model", () => {
  const first = twoRoomHouse().input()
  const second = twoRoomHouse().input({
    sheetVersionId: "sv-2",
    name: "Second Floor",
    order: 1,
    sheetTitle: "Second Floor Plan",
  })
  const model = interpretFloorplan([first, second])

  assert.equal(model.version, 1)
  assert.equal(model.units, "feet")
  assert.equal(model.levels.length, 2)
  assert.notEqual(model.levels[0].id, model.levels[1].id)
  assert.equal(model.correctionCount, 0)
  const score = modelConfidence(model)
  assert.ok(score > 0.6 && score <= 1, `model confidence ${score} should be usable`)
})

test("room centroids fall inside their own polygon", () => {
  const level = interpretLevel(twoRoomHouse().input())
  for (const room of level.rooms) {
    let sx = 0
    let sy = 0
    for (const [x, y] of room.polygon) {
      sx += x
      sy += y
    }
    const centroid = [sx / room.polygon.length, sy / room.polygon.length]
    assert.ok(pointInPolygon(centroid, room.polygon), `centroid outside room ${room.id}`)
  }
})

// ---------------------------------------------------------------------------
// Text runs
// ---------------------------------------------------------------------------

test("text runs round-trip and reject malformed payloads", () => {
  const runs = [{ text: "KITCHEN", x: 0.25, y: 0.5, w: 0.05, h: 0.01 }]
  assert.deepEqual(parseTextRuns(encodeTextRuns(runs)), runs)

  assert.deepEqual(parseTextRuns("not json"), [])
  assert.deepEqual(parseTextRuns(JSON.stringify({ version: 99, runs })), [])
  assert.deepEqual(parseTextRuns(JSON.stringify({ version: 1, runs: "nope" })), [])
  assert.deepEqual(
    parseTextRuns(JSON.stringify({ version: 1, runs: [{ text: "", x: 0, y: 0, w: 1, h: 1 }, { text: "OK", x: 0 }] })),
    [],
  )
})

// ---------------------------------------------------------------------------
// Anchors
//
// A model belongs either to a plan version (production: one interpretation
// serves every lot) or to a project (residential: a custom home has no plan).
// The validator is what makes "both" and "neither" unrepresentable at the edge,
// mirroring the check constraint in the database.
// ---------------------------------------------------------------------------

const { floorplanTargetSchema } = require("../lib/validation/floorplan")

const UUID_A = "11111111-1111-4111-8111-111111111111"
const UUID_B = "22222222-2222-4222-8222-222222222222"

test("a target is exactly one anchor", () => {
  assert.deepEqual(floorplanTargetSchema.parse({ kind: "plan", housePlanVersionId: UUID_A }), {
    kind: "plan",
    housePlanVersionId: UUID_A,
  })
  assert.deepEqual(floorplanTargetSchema.parse({ kind: "project", projectId: UUID_B }), {
    kind: "project",
    projectId: UUID_B,
  })
})

test("a target carrying the wrong id, no kind, or a bad uuid is rejected", () => {
  // A project anchor holding a plan id would write a row the check constraint
  // rejects — catching it here turns a 500 into a validation message.
  assert.throws(() => floorplanTargetSchema.parse({ kind: "project", housePlanVersionId: UUID_A }))
  assert.throws(() => floorplanTargetSchema.parse({ kind: "plan", projectId: UUID_B }))
  assert.throws(() => floorplanTargetSchema.parse({ housePlanVersionId: UUID_A }))
  assert.throws(() => floorplanTargetSchema.parse({ kind: "lot", lotId: UUID_A }))
  assert.throws(() => floorplanTargetSchema.parse({ kind: "plan", housePlanVersionId: "not-a-uuid" }))
  assert.throws(() => floorplanTargetSchema.parse(null))
})

test("extra keys are stripped, so a target never smuggles a second anchor through", () => {
  const parsed = floorplanTargetSchema.parse({
    kind: "project",
    projectId: UUID_B,
    housePlanVersionId: UUID_A,
  })
  assert.deepEqual(parsed, { kind: "project", projectId: UUID_B })
})
