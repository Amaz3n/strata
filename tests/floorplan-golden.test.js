require("../scripts/register-ts-node-test")

/**
 * Golden-fixture accuracy suite: measured wall recall and precision, the
 * gameplan's acceptance bar (recall ≥ 85%, precision ≥ 90%), enforced.
 *
 * Two sources of fixtures:
 *
 * 1. A realistic SYNTHETIC sheet authored below — a full single-story house
 *    with poché-filled exterior walls, door swings, glazing, dimension
 *    strings, witness ticks and a title block, i.e. the noise a real A-series
 *    sheet carries. It runs on every test run.
 * 2. REAL fixtures dropped into `tests/fixtures/floorplans/*.json` — exported
 *    sheet vectors with hand-labeled wall centerlines. Schema:
 *    `{ name, imageWidth, imageHeight, feetPerImagePx, segments, flags,
 *       textRuns, truth: { walls: [{x0,y0,x1,y1}] }, thresholds? }`
 *    where `segments` is the flat normalized array exactly as `vectors.bin`
 *    stores it and `truth.walls` is in recentered model feet. Any file that
 *    exists is enforced. (Exporting a customer sheet into the repo is a human
 *    decision — this harness just makes it one `git add` away.)
 */

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const { interpretLevel } = require("../lib/drawings/floorplan-interpret")

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function distanceToWall(x, y, wall) {
  const dx = wall.x1 - wall.x0
  const dy = wall.y1 - wall.y0
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-9) return Math.hypot(x - wall.x0, y - wall.y0)
  const t = Math.min(1, Math.max(0, ((x - wall.x0) * dx + (y - wall.y0) * dy) / lenSq))
  return Math.hypot(x - (wall.x0 + t * dx), y - (wall.y0 + t * dy))
}

/** Length-weighted share of `source` centerline lying within `tolFt` of `target`. */
function coverage(source, target, tolFt) {
  let covered = 0
  let total = 0
  for (const wall of source) {
    const length = Math.hypot(wall.x1 - wall.x0, wall.y1 - wall.y0)
    const steps = Math.max(2, Math.ceil(length / 0.25))
    for (let i = 0; i <= steps; i++) {
      const x = wall.x0 + ((wall.x1 - wall.x0) * i) / steps
      const y = wall.y0 + ((wall.y1 - wall.y0) * i) / steps
      total++
      if (target.some((candidate) => distanceToWall(x, y, candidate) <= tolFt)) covered++
    }
  }
  return total === 0 ? 0 : covered / total
}

function assertAccuracy(level, truthWalls, thresholds, label) {
  assert.ok(level.walls.length > 0, `${label}: no walls interpreted at all`)
  const recall = coverage(truthWalls, level.walls, 0.5)
  const precision = coverage(level.walls, truthWalls, 0.6)
  assert.ok(
    recall >= thresholds.recall,
    `${label}: wall recall ${(recall * 100).toFixed(1)}% < ${thresholds.recall * 100}%`,
  )
  assert.ok(
    precision >= thresholds.precision,
    `${label}: wall precision ${(precision * 100).toFixed(1)}% < ${thresholds.precision * 100}%`,
  )
  return { recall, precision }
}

// ---------------------------------------------------------------------------
// Synthetic golden sheet
// ---------------------------------------------------------------------------

const IMAGE = { width: 2400, height: 1800 }
/** 0.02 ft per rendered pixel → a 48' × 36' sheet area. */
const FEET_PER_PX = 0.02
const SHEET_W_FT = IMAGE.width * FEET_PER_PX
const SHEET_H_FT = IMAGE.height * FEET_PER_PX

class SheetBuilder {
  constructor() {
    this.segments = []
    this.flags = []
    this.textRuns = []
  }

  line(x0, y0, x1, y1, { dashed = false, filled = false } = {}) {
    this.segments.push(x0 / SHEET_W_FT, y0 / SHEET_H_FT, x1 / SHEET_W_FT, y1 / SHEET_H_FT)
    this.flags.push((dashed ? 1 : 0) | (filled ? 2 : 0))
  }

  /** A sampled arc, exactly as MuPDF flattening emits one: 8 chained chords. */
  arc(cx, cy, radius, fromRad, toRad) {
    const chords = 8
    for (let i = 0; i < chords; i++) {
      const a = fromRad + ((toRad - fromRad) * i) / chords
      const b = fromRad + ((toRad - fromRad) * (i + 1)) / chords
      this.line(
        cx + radius * Math.cos(a),
        cy + radius * Math.sin(a),
        cx + radius * Math.cos(b),
        cy + radius * Math.sin(b),
      )
    }
  }

  /**
   * A double-line wall: two faces at ±thickness/2, both broken at every gap —
   * which is how a drafter actually draws an opening.
   */
  wall(x0, y0, x1, y1, thickness, gaps = [], { filled = false } = {}) {
    const length = Math.hypot(x1 - x0, y1 - y0)
    const ux = (x1 - x0) / length
    const uy = (y1 - y0) / length
    const nx = (-uy * thickness) / 2
    const ny = (ux * thickness) / 2
    const spans = []
    let cursor = 0
    for (const [start, end] of [...gaps].sort((a, b) => a[0] - b[0])) {
      if (start > cursor) spans.push([cursor, start])
      cursor = end
    }
    if (cursor < length) spans.push([cursor, length])
    for (const [start, end] of spans) {
      for (const sign of [1, -1]) {
        this.line(
          x0 + ux * start + nx * sign,
          y0 + uy * start + ny * sign,
          x0 + ux * end + nx * sign,
          y0 + uy * end + ny * sign,
          { filled },
        )
      }
    }
  }

  /** Two thin glazing lines along a window gap. */
  glazing(x0, y0, x1, y1) {
    const length = Math.hypot(x1 - x0, y1 - y0)
    const ux = (x1 - x0) / length
    const uy = (y1 - y0) / length
    for (const offset of [-0.07, 0.07]) {
      this.line(x0 - uy * offset, y0 + ux * offset, x1 - uy * offset, y1 + ux * offset)
    }
  }

  text(value, xFt, yFt, wFt, hFt) {
    this.textRuns.push({
      text: value,
      x: xFt / SHEET_W_FT,
      y: yFt / SHEET_H_FT,
      w: wFt / SHEET_W_FT,
      h: hFt / SHEET_H_FT,
    })
  }

  input() {
    return {
      sheetVersionId: "sv-golden",
      sheetNumber: "A2.1",
      sheetTitle: "First Floor Plan",
      name: "First Floor",
      order: 0,
      imageWidth: IMAGE.width,
      imageHeight: IMAGE.height,
      feetPerImagePx: FEET_PER_PX,
      segments: this.segments,
      flags: this.flags,
      textRuns: this.textRuns,
    }
  }
}

/**
 * A 36' × 24' single-story house at sheet offset (6, 6): filled exterior
 * walls with a front door and five windows, three interior partitions with
 * swung doors, room tags — and the parts of a sheet that are NOT the plan.
 */
function buildGoldenSheet() {
  const sheet = new SheetBuilder()
  const OX = 6
  const OY = 6
  const EXT = 0.67
  const INT = 0.375

  // Exterior perimeter (centerlines local 0..36 × 0..24, y-down).
  // South: front door 16–19, windows 6–9.5 and 26–29.5.
  sheet.wall(OX + 0, OY + 0, OX + 36, OY + 0, EXT, [[6, 9.5], [16, 19], [26, 29.5]], { filled: true })
  // North: windows 4–8, 20–23, 30–33.
  sheet.wall(OX + 0, OY + 24, OX + 36, OY + 24, EXT, [[4, 8], [20, 23], [30, 33]], { filled: true })
  // West: window 8–11 (measured from the north end downward in y).
  sheet.wall(OX + 0, OY + 0, OX + 0, OY + 24, EXT, [[8, 11]], { filled: true })
  // East: window 14–17.5.
  sheet.wall(OX + 36, OY + 0, OX + 36, OY + 24, EXT, [[14, 17.5]], { filled: true })

  // Window glazing.
  sheet.glazing(OX + 6, OY + 0, OX + 9.5, OY + 0)
  sheet.glazing(OX + 26, OY + 0, OX + 29.5, OY + 0)
  sheet.glazing(OX + 4, OY + 24, OX + 8, OY + 24)
  sheet.glazing(OX + 20, OY + 24, OX + 23, OY + 24)
  sheet.glazing(OX + 30, OY + 24, OX + 33, OY + 24)
  sheet.glazing(OX + 0, OY + 8, OX + 0, OY + 11)
  sheet.glazing(OX + 36, OY + 14, OX + 36, OY + 17.5)

  // Front door swing: hinge at (16, 0), leaf 3', opening into the house (+y).
  sheet.arc(OX + 16, OY + 0, 3, 0, Math.PI / 2)

  // Interior partitions.
  // P1: vertical at x=14, doors at y 4–6.67 and y 18–20.67.
  sheet.wall(OX + 14, OY + 0, OX + 14, OY + 24, INT, [[4, 6.67], [18, 20.67]])
  sheet.arc(OX + 14, OY + 4, 2.67, Math.PI / 2, Math.PI)
  sheet.arc(OX + 14, OY + 18, 2.67, Math.PI / 2, Math.PI)
  // P2: horizontal at y=10 from x=14 to 36, door at 24–26.67 (x 38–40.67 local).
  sheet.wall(OX + 14, OY + 10, OX + 36, OY + 10, INT, [[10, 12.67]])
  sheet.arc(OX + 24, OY + 10, 2.67, Math.PI / 2, Math.PI)
  // P3: vertical at x=26 from y=10 to 24, door at y 15–17.67 (5–7.67 local).
  sheet.wall(OX + 26, OY + 10, OX + 26, OY + 24, INT, [[5, 7.67]])
  sheet.arc(OX + 26, OY + 15, 2.67, 0, Math.PI / 2)

  // Room tags, name over size, the way a plan annotates them.
  sheet.text("GREAT ROOM", OX + 4.5, OY + 11.5, 5, 0.55)
  sheet.text(`14'-0" x 24'-0"`, OX + 5, OY + 12.3, 4, 0.35)
  sheet.text("KITCHEN", OX + 23, OY + 4.5, 4, 0.55)
  sheet.text("BEDROOM 2", OX + 17.5, OY + 16.5, 4.5, 0.55)
  sheet.text("GARAGE", OX + 29.5, OY + 16.5, 3.5, 0.55)

  // --- Everything on the sheet that is not the plan -----------------------
  // Dimension strings with witness ticks, well clear of the walls.
  sheet.line(OX + 0, OY - 2.5, OX + 36, OY - 2.5)
  sheet.line(OX + 0, OY + 26.5, OX + 36, OY + 26.5)
  sheet.line(OX - 2.5, OY + 0, OX - 2.5, OY + 24)
  for (const x of [0, 14, 26, 36]) {
    sheet.line(OX + x, OY - 2.9, OX + x, OY - 2.1)
    sheet.line(OX + x - 0.3, OY - 2.9, OX + x + 0.3, OY - 2.1)
  }
  sheet.text(`36'-0"`, OX + 17, OY - 3, 2.5, 0.4)
  sheet.text(`24'-0"`, OX - 3.5, OY + 11.5, 2.5, 0.4)
  sheet.text(`SCALE: 1/4" = 1'-0"`, OX + 1, OY + 28, 5, 0.4)
  // Title block: single-line borders and rules (no wall-thickness pairs).
  sheet.line(44, 6, 47.5, 6)
  sheet.line(47.5, 6, 47.5, 30)
  sheet.line(47.5, 30, 44, 30)
  sheet.line(44, 30, 44, 6)
  for (let y = 9; y < 30; y += 3) sheet.line(44, y, 47.5, y)
  // Revision-cloud scallops in a corner: little arcs, radius far below a door.
  for (let i = 0; i < 6; i++) sheet.arc(2 + i * 0.8, 33, 0.42, Math.PI, 2 * Math.PI)
  // Dashed roof overhang just outside the envelope — dashed drafting must go.
  sheet.line(OX - 1.5, OY - 1.5, OX + 37.5, OY - 1.5, { dashed: true })
  sheet.line(OX + 37.5, OY - 1.5, OX + 37.5, OY + 25.5, { dashed: true })

  // Truth in recentered model feet: the interpreter recenters onto the wall
  // bbox min, which is the exterior FACE corner at (-EXT/2, -EXT/2) local.
  const shift = EXT / 2
  const truthWalls = [
    { x0: 0, y0: 0, x1: 36, y1: 0 },
    { x0: 0, y0: 24, x1: 36, y1: 24 },
    { x0: 0, y0: 0, x1: 0, y1: 24 },
    { x0: 36, y0: 0, x1: 36, y1: 24 },
    { x0: 14, y0: 0, x1: 14, y1: 24 },
    { x0: 14, y0: 10, x1: 36, y1: 10 },
    { x0: 26, y0: 10, x1: 26, y1: 24 },
  ].map((wall) => ({
    x0: wall.x0 + shift,
    y0: wall.y0 + shift,
    x1: wall.x1 + shift,
    y1: wall.y1 + shift,
  }))

  return { sheet, truthWalls }
}

test("golden synthetic sheet: wall recall ≥ 85%, precision ≥ 90%", () => {
  const { sheet, truthWalls } = buildGoldenSheet()
  const level = interpretLevel(sheet.input())
  assertAccuracy(level, truthWalls, { recall: 0.85, precision: 0.9 }, "golden")
})

test("golden synthetic sheet: rooms close and carry their names", () => {
  const { sheet } = buildGoldenSheet()
  const level = interpretLevel(sheet.input())
  assert.ok(level.rooms.length >= 4, `expected ≥ 4 rooms, got ${level.rooms.length}`)
  const labels = new Set(level.rooms.map((room) => room.label).filter(Boolean))
  for (const expected of ["GREAT ROOM", "KITCHEN", "BEDROOM 2", "GARAGE"]) {
    assert.ok(labels.has(expected), `room label "${expected}" missing (got ${[...labels].join(", ")})`)
  }
})

test("golden synthetic sheet: openings classify by their evidence", () => {
  const { sheet } = buildGoldenSheet()
  const level = interpretLevel(sheet.input())
  const kinds = level.openings.reduce((counts, opening) => {
    counts[opening.kind] = (counts[opening.kind] ?? 0) + 1
    return counts
  }, {})
  assert.ok((kinds.door ?? 0) >= 4, `expected ≥ 4 doors, got ${kinds.door ?? 0}`)
  assert.ok((kinds.window ?? 0) >= 5, `expected ≥ 5 windows, got ${kinds.window ?? 0}`)
})

// ---------------------------------------------------------------------------
// Real fixtures, when present
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, "fixtures", "floorplans")
const fixtureFiles = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((file) => file.endsWith(".json"))
  : []

for (const file of fixtureFiles) {
  test(`real fixture ${file}: meets its accuracy thresholds`, () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"))
    const level = interpretLevel({
      sheetVersionId: fixture.name ?? file,
      sheetNumber: fixture.sheetNumber ?? null,
      sheetTitle: fixture.sheetTitle ?? null,
      name: fixture.name ?? file,
      order: 0,
      imageWidth: fixture.imageWidth,
      imageHeight: fixture.imageHeight,
      feetPerImagePx: fixture.feetPerImagePx,
      segments: fixture.segments,
      flags: fixture.flags ?? null,
      textRuns: fixture.textRuns ?? [],
    })
    const thresholds = fixture.thresholds ?? { recall: 0.85, precision: 0.9 }
    assertAccuracy(level, fixture.truth.walls, thresholds, file)
  })
}
