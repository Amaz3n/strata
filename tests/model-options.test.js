require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { applyModelOptions, priceModelOption, priceModelChange, wallsOfRoom } = require("../lib/drawings/model-options")

function wall(id, x0, y0, x1, y1) {
  return { id, x0, y0, x1, y1, thicknessFt: 0.5, confidence: 1, source: "paired" }
}
// Two rooms side by side: a 12x16 bedroom and a 12x16 living room.
const model = {
  version: 1,
  units: "feet",
  correctionCount: 0,
  levels: [
    {
      id: "L0",
      name: "First",
      order: 0,
      ceilingHeightFt: 9,
      walls: [wall("n", 0, 0, 24, 0), wall("e", 24, 0, 24, 16), wall("s", 24, 16, 0, 16), wall("w", 0, 16, 0, 0), wall("mid", 12, 0, 12, 16)],
      openings: [],
      rooms: [
        { id: "bed", polygon: [[0, 0], [12, 0], [12, 16], [0, 16]], label: "BEDROOM 2", areaSqft: 192, confidence: 1 },
        { id: "liv", polygon: [[12, 0], [24, 0], [24, 16], [12, 16]], label: "LIVING", areaSqft: 192, confidence: 1 },
      ],
      confidence: { walls: 1, openings: 1, rooms: 1 },
    },
  ],
}

test("floor finish prices off the matched rooms' floor area", () => {
  const priced = priceModelChange(model, { kind: "floor_finish", finish: "oak", rooms: ["bedroom"], unitPriceCents: 850 })
  assert.deepEqual([priced.quantity, priced.uom, priced.totalCents, priced.rooms], [192, "sf", 192 * 850, ["BEDROOM 2"]])
})

test("wall finish prices perimeter × ceiling height; an empty room list means every room", () => {
  const priced = priceModelChange(model, { kind: "wall_finish", finish: "walnut", rooms: [], unitPriceCents: 100 })
  assert.equal(priced.quantity, 2 * (12 + 16) * 2 * 9)
  assert.equal(priced.totalCents, priced.quantity * 100)
})

test("an option's total is the sum of its changes, and furniture is per piece", () => {
  const option = {
    id: "opt",
    name: "Furnished living",
    modelChanges: [
      { kind: "furniture", modelId: "sofa_02", rooms: ["living"], priceCents: 180000 },
      { kind: "floor_finish", finish: "walnut", rooms: ["living"], unitPriceCents: 1000 },
    ],
  }
  assert.equal(priceModelOption(model, option).totalCents, 180000 + 192 * 1000)
})

test("walls of a room are the ones on its outline", () => {
  const ids = wallsOfRoom(model.levels[0], model.levels[0].rooms[0]).map((w) => w.id).sort()
  assert.deepEqual(ids, ["mid", "n", "s", "w"])
})

test("applying options never edits the saved model and is repeatable", () => {
  const option = {
    id: "opt",
    name: "Oak + sofa",
    modelChanges: [
      { kind: "floor_finish", finish: "oak", rooms: ["bedroom"], unitPriceCents: 1 },
      { kind: "wall_finish", finish: "walnut", rooms: ["living"], unitPriceCents: 1 },
      { kind: "furniture", modelId: "sofa_02", rooms: ["living"], priceCents: 1 },
    ],
  }
  const before = JSON.stringify(model)
  const a = applyModelOptions(model, [option])
  const b = applyModelOptions(model, [option])
  assert.equal(JSON.stringify(model), before)
  assert.deepEqual(a, b)
  const level = a.levels[0]
  assert.equal(level.rooms[0].finish.pattern, "wood")
  assert.equal(level.rooms[1].finish, undefined)
  assert.deepEqual(level.walls.filter((w) => w.finish).map((w) => w.id).sort(), ["e", "mid", "n", "s"])
  assert.equal(level.objects.length, 1)
  assert.equal(level.objects[0].modelId, "sofa_02")
  assert.equal(level.objects[0].id, "option:opt:2:liv")
  assert.equal(applyModelOptions(model, []), model)
})

const { DESIGN_PALETTES, paletteEdits } = require("../lib/drawings/design-palettes")
const { FINISH_PRESETS } = require("../lib/drawings/architectural-model")

test("a palette's specific rules win over its broad ones, and unchanged rooms are skipped", () => {
  const house = {
    levels: [
      {
        id: "L0",
        rooms: [
          { id: "b", label: "PRIMARY BATH", polygon: [], areaSqft: 80 },
          { id: "k", label: "KITCHEN", polygon: [], areaSqft: 200 },
          { id: "r", label: "BEDROOM 2", polygon: [], areaSqft: 140, finish: { ...FINISH_PRESETS.carpet } },
        ],
      },
    ],
  }
  const edits = paletteEdits(house, DESIGN_PALETTES.find((palette) => palette.id === "warm-oak"))
  assert.deepEqual(edits.map((edit) => [edit.roomId, edit.changes.finish.pattern]), [["b", "tile"], ["k", "wood"]])
  for (const palette of DESIGN_PALETTES) for (const change of palette.changes) assert.ok(FINISH_PRESETS[change.finish], change.finish)
})
