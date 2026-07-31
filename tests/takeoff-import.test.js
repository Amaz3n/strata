require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { parseTakeoffPaste } = require("../lib/plans/takeoff-import")
const { buildBill } = require("../lib/plans/bill")

const costCodes = [
  { id: "code-frame", code: "06100", name: "Wall framing", division: "06", unit: "sf", default_unit_cost_cents: 215, cost_type: "subcontractor" },
  { id: "code-truss", code: "06200", name: "Roof trusses", division: "06", unit: "ea", default_unit_cost_cents: null, cost_type: "material" },
  { id: "code-permit", code: "01010", name: "Permits", division: "01", unit: "ea", default_unit_cost_cents: 50000, cost_type: "other" },
  { id: "div-06", code: "06", name: "Wood & Plastics", division: "06", category: "csi-division" },
]
const elevations = [{ id: "elev-b", code: "B" }]

const parse = (text, headerMode) => parseTakeoffPaste({ text, costCodes, elevations, headerMode })

test("a tab-delimited paste with a header row maps columns by name in any order", () => {
  const result = parse("description\tcost code\tqty\tuom\tunit cost\nWall framing\t06100\t1650\tsf\t2.15")
  assert.equal(result.delimiter, "tab")
  assert.equal(result.hasHeader, true)
  assert.deepEqual(result.rows[0].line, {
    costCodeId: "code-frame",
    costType: "subcontractor",
    description: "Wall framing",
    quantity: "1650",
    uom: "sf",
    unitCostDollars: "2.15",
    elevationId: "base",
  })
})

test("money and quantities survive dollar signs, thousands separators, and quoted cells", () => {
  const result = parse('cost code,description,quantity,uom,unit cost\n06100,"Framing, walls","1,650",sf,"$2.15"')
  assert.equal(result.delimiter, "comma")
  assert.equal(result.rows[0].error, null)
  assert.equal(result.rows[0].line.description, "Framing, walls")
  assert.equal(result.rows[0].line.quantity, "1650")
  assert.equal(result.rows[0].line.unitCostDollars, "2.15")
})

test("a headerless paste leading with an elevation keeps the documented Arc column order", () => {
  const result = parse("B, 06100, Wall framing, 40, sf, 2.15\nbase, 06200, Roof trusses, 38, ea, 412.50")
  assert.equal(result.hasHeader, false)
  assert.deepEqual(result.fields, ["elevation", "costCode", "description", "quantity", "uom", "unitCost"])
  assert.equal(result.rows[0].line.elevationId, "elev-b")
  assert.equal(result.rows[1].line.elevationId, "base")
})

test("a headerless paste leading with a cost code is read without an elevation column", () => {
  const result = parse("06100, Wall framing, 40, sf, 2.15")
  assert.deepEqual(result.fields, ["costCode", "description", "quantity", "uom", "unitCost"])
  assert.equal(result.rows[0].line.description, "Wall framing")
  assert.equal(result.rows[0].line.quantity, "40")
})

test("cost codes resolve by id, by code, and by punctuation-insensitive name", () => {
  const byId = parse("cost code,description\ncode-truss,Trusses")
  const byLooseCode = parse("cost code,description\n06-100,Framing")
  const byName = parse("cost code,description\nroof trusses,Trusses")
  assert.equal(byId.rows[0].line.costCodeId, "code-truss")
  assert.equal(byLooseCode.rows[0].line.costCodeId, "code-frame")
  assert.equal(byName.rows[0].line.costCodeId, "code-truss")
})

test("blanks fall back to the cost code's own name, unit, and a quantity of one", () => {
  const result = parse("cost code,description,quantity,uom,unit cost\n01010,,,,")
  assert.equal(result.rows[0].line.description, "Permits")
  assert.equal(result.rows[0].line.uom, "ea")
  assert.equal(result.rows[0].line.quantity, "1")
  assert.equal(result.rows[0].line.unitCostDollars, "")
})

test("a bad row is named and skipped without costing the rows around it", () => {
  const result = parse(
    "cost code,description,quantity,uom,unit cost\n" +
      "06100,Wall framing,10,sf,2.15\n" +
      "NOPE,Mystery,1,ls,500\n" +
      "06200,Trusses,abc,ea,400\n" +
      "06100,Elevation ghost,1,sf,1\n" +
      "06200,Negative,-4,ea,400",
  )
  assert.equal(result.readyCount, 2)
  assert.equal(result.errorCount, 3)
  assert.match(result.rows[1].error, /NOPE/)
  assert.match(result.rows[2].error, /not a number/)
  assert.match(result.rows[4].error, /negative/)
})

test("an unknown elevation is an error rather than a silent base-plan line", () => {
  const result = parse("elevation,cost code,description\nZ,06100,Framing")
  assert.equal(result.readyCount, 0)
  assert.match(result.rows[0].error, /Elevation/)
})

test("a named header that never mentions a cost code fails as a whole, not row by row", () => {
  const result = parse("description,quantity,uom\nWall framing,10,sf")
  assert.equal(result.hasHeader, true)
  assert.equal(result.rows.length, 0)
  assert.match(result.fatal, /cost code/)
})

test("unrecognisable columns still read positionally, so the failure names the bad code", () => {
  const result = parse("name,notes\nsomething,else")
  assert.equal(result.fatal, null)
  assert.equal(result.readyCount, 0)
  assert.match(result.rows[0].error, /“name” was not found/)
})

const billLine = (overrides = {}) => ({
  uid: "u1",
  index: 0,
  costCodeId: "code-frame",
  description: "Wall framing",
  uom: "sf",
  quantity: 1650,
  elevationId: null,
  unitCostCents: 215,
  amountCents: 354750,
  pricingSource: "takeoff_manual",
  vendorName: null,
  lumpSum: false,
  invalid: false,
  ...overrides,
})

test("the bill keys rows by draft identity so duplicate descriptions cannot collide", () => {
  const bill = buildBill({
    lines: [billLine(), billLine({ uid: "u2", index: 1, description: "Wall framing" })],
    comparisonLines: null,
    costCodes,
  })
  const keys = bill.divisions.flatMap((division) => division.rows.map((row) => row.key))
  assert.deepEqual(keys, ["u1", "u2"])
  assert.equal(bill.lineCount, 2)
})

test("lines sharing a cost code hold the order they were entered in", () => {
  const bill = buildBill({
    lines: [
      billLine({ uid: "a", index: 0, description: "First" }),
      billLine({ uid: "b", index: 1, description: "Second" }),
      billLine({ uid: "c", index: 2, description: "Third" }),
    ],
    comparisonLines: null,
    costCodes,
  })
  assert.deepEqual(
    bill.divisions[0].rows.map((row) => row.description),
    ["First", "Second", "Third"],
  )
})

test("a line dropped since the released edition stays in the document as a removal", () => {
  const bill = buildBill({
    lines: [billLine()],
    comparisonLines: [
      { id: "l1", elevation_id: null, cost_code_id: "code-frame", cost_type: null, description: "Wall framing", quantity: 1650, uom: "sf", unit_cost_cents: 200, sort_order: 0 },
      { id: "l2", elevation_id: null, cost_code_id: "code-truss", cost_type: null, description: "Roof trusses", quantity: 38, uom: "ea", unit_cost_cents: 41250, sort_order: 1 },
    ],
    costCodes,
  })
  const rows = bill.divisions.flatMap((division) => division.rows)
  const removed = rows.find((row) => row.status === "removed")
  assert.equal(removed.description, "Roof trusses")
  assert.equal(removed.amountCents, 0)
  assert.equal(removed.deltaCents, -1567500)
  assert.equal(bill.lineCount, 1)
  assert.equal(rows.find((row) => row.uom === "sf").status, "changed")
})

test("invalid drafts are counted so saving can refuse instead of dropping them", () => {
  const bill = buildBill({
    lines: [billLine(), billLine({ uid: "u2", index: 1, description: "", invalid: true })],
    comparisonLines: null,
    costCodes,
  })
  assert.equal(bill.invalidCount, 1)
})
