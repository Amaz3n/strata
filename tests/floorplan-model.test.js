require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { selectFloorplanSheets } = require("../lib/drawings/floorplan-sheets")
const { roomLabelFromText } = require("../lib/drawings/room-names")
const {
  applyFloorplanEdit,
  extractRoomPolygons,
  wallSolidSpans,
  modelToImagePx,
  imagePxToModel,
  polygonArea,
} = require("../lib/drawings/floorplan-model")
const { encodeTextRuns, parseTextRuns } = require("../lib/drawings/text-runs")

// ---------------------------------------------------------------------------
// Fixture: a 24' x 16' box split by a thinner partition at x = 12, with a
// door through the partition. Hand-built in model feet, so these tests cover
// the model and its edit reducer, not any interpreter.
// ---------------------------------------------------------------------------

function wall(id, x0, y0, x1, y1, thicknessFt = 0.5) {
  return { id, x0, y0, x1, y1, thicknessFt, confidence: 1, source: "paired" }
}

function twoRoomLevel() {
  return {
    id: "L0",
    name: "First Floor",
    order: 0,
    ceilingHeightFt: 9,
    source: {
      sheetVersionId: "sv-1",
      sheetNumber: "A2.1",
      sheetTitle: "First Floor Plan",
      imageWidth: 2400,
      imageHeight: 1800,
      feetPerImagePx: 0.02,
      originPxX: 200,
      originPxY: 150,
      scaleConfirmed: true,
    },
    walls: [
      wall("w1", 0, 0, 24, 0),
      wall("w2", 24, 0, 24, 16),
      wall("w3", 24, 16, 0, 16),
      wall("w4", 0, 16, 0, 0),
      wall("w5", 12, 0, 12, 16, 0.375),
    ],
    openings: [
      { id: "o1", wallId: "w5", kind: "door", offsetFt: 6, widthFt: 3, sillFt: 0, headFt: 6.75, confidence: 1 },
    ],
    rooms: [
      { id: "r1", polygon: [[0, 0], [12, 0], [12, 16], [0, 16]], label: "KITCHEN", areaSqft: 192, confidence: 1 },
      { id: "r2", polygon: [[12, 0], [24, 0], [24, 16], [12, 16]], label: "BEDROOM", areaSqft: 192, confidence: 1 },
    ],
    confidence: { walls: 1, openings: 1, rooms: 1 },
  }
}

function modelOf(level) {
  return { version: 1, units: "feet", levels: [level], correctionCount: 0 }
}

// ---------------------------------------------------------------------------
// Sheet selection and room labels
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
  const { source } = twoRoomLevel()
  const px = modelToImagePx(source, 10, 6)
  const back = imagePxToModel(source, px.x, px.y)
  assert.ok(Math.abs(back.x - 10) < 1e-6)
  assert.ok(Math.abs(back.y - 6) < 1e-6)
})

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

test("deleting a wall re-derives the rooms and carries labels across", () => {
  const level = twoRoomLevel()
  const model = modelOf(level)

  const edited = applyFloorplanEdit(model, { type: "wall.delete", levelId: level.id, wallId: "w5" })
  assert.equal(edited.correctionCount, 1)
  assert.equal(edited.levels[0].rooms.length, 1, "removing the partition merges the two rooms")
  assert.ok(
    ["KITCHEN", "BEDROOM"].includes(edited.levels[0].rooms[0].label),
    "the surviving room keeps one of the two names",
  )
  assert.equal(
    edited.levels[0].openings.some((opening) => opening.wallId === "w5"),
    false,
    "a deleted wall takes its openings with it",
  )
  assert.equal(model.levels[0].walls.length, 5, "the input model is never mutated")
})

test("drawing a wall splits a room in two", () => {
  const level = twoRoomLevel()
  level.walls = level.walls.filter((w) => w.id !== "w5")
  level.openings = []
  level.rooms = [{ id: "r1", polygon: [[0, 0], [24, 0], [24, 16], [0, 16]], label: null, areaSqft: 384, confidence: 1 }]

  const edited = applyFloorplanEdit(modelOf(level), {
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
  const level = twoRoomLevel()
  let model = modelOf(level)

  model = applyFloorplanEdit(model, { type: "opening.set", levelId: level.id, openingId: "o1", kind: "cased" })
  const changed = model.levels[0].openings.find((item) => item.id === "o1")
  assert.equal(changed.kind, "cased")
  assert.equal(changed.headFt, 6.75)

  model = applyFloorplanEdit(model, { type: "room.label", levelId: level.id, roomId: "r1", label: "  Great Room  " })
  assert.equal(model.levels[0].rooms.find((item) => item.id === "r1").label, "Great Room")

  model = applyFloorplanEdit(model, { type: "level.height", levelId: level.id, ceilingHeightFt: 10 })
  assert.equal(model.levels[0].ceilingHeightFt, 10)

  model = applyFloorplanEdit(model, { type: "level.name", levelId: level.id, name: "Main Level" })
  assert.equal(model.levels[0].name, "Main Level")
  assert.equal(model.correctionCount, 4)
})

test("ceiling height is clamped to something buildable", () => {
  const level = twoRoomLevel()
  const model = modelOf(level)
  assert.equal(applyFloorplanEdit(model, { type: "level.height", levelId: level.id, ceilingHeightFt: 200 }).levels[0].ceilingHeightFt, 20)
  assert.equal(applyFloorplanEdit(model, { type: "level.height", levelId: level.id, ceilingHeightFt: 1 }).levels[0].ceilingHeightFt, 6)
})

test("a stale edit is a no-op that returns the same model", () => {
  const level = twoRoomLevel()
  const model = modelOf(level)
  assert.equal(applyFloorplanEdit(model, { type: "wall.delete", levelId: level.id, wallId: "nope" }), model)
  assert.equal(applyFloorplanEdit(model, { type: "wall.delete", levelId: "nope", wallId: "w1" }), model)
  assert.equal(
    applyFloorplanEdit(model, { type: "wall.add", levelId: level.id, x0: 0, y0: 0, x1: 0.1, y1: 0 }),
    model,
    "a two-inch wall is a mis-click, not a wall",
  )
})

test("the site orients the whole model without unreviewing a level", () => {
  const level = { ...twoRoomLevel(), reviewed: true }
  const model = modelOf(level)
  const next = applyFloorplanEdit(model, { type: "site.set", site: { northDeg: 30, latitudeDeg: 41 } })
  assert.deepEqual(next.site, { northDeg: 30, latitudeDeg: 41 })
  assert.equal(next.levels[0], model.levels[0], "levels are untouched")
  assert.equal(next.correctionCount, 1)
  assert.equal(applyFloorplanEdit(next, { type: "site.set", site: { northDeg: 30, latitudeDeg: 41 } }), next, "the same site is a no-op")
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
