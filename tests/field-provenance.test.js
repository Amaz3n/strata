require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  normalizeRegion,
  collectFieldProvenance,
  padRegion,
  PROVENANCE_FIELDS,
} = require("../lib/ai/field-provenance")

const GOOD = { page: 1, x0: 0.62, y0: 0.81, x1: 0.88, y1: 0.85 }

test("a well-formed box survives unchanged", () => {
  assert.deepEqual(normalizeRegion(GOOD), GOOD)
})

test("a transposed box is repaired rather than discarded", () => {
  const region = normalizeRegion({ page: 1, x0: 0.88, y0: 0.85, x1: 0.62, y1: 0.81 })
  assert.deepEqual(region, GOOD)
})

test("coordinates outside the page are clamped, not rejected", () => {
  const region = normalizeRegion({ page: 1, x0: -0.2, y0: 0.4, x1: 1.4, y1: 0.5 })
  assert.equal(region.x0, 0)
  assert.equal(region.x1, 1)
})

test("a zero-area box is rejected", () => {
  assert.equal(normalizeRegion({ page: 1, x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5 }), null)
  assert.equal(normalizeRegion({ page: 1, x0: 0.2, y0: 0.5, x1: 0.8, y1: 0.5 }), null)
})

test("a box too small to point at anything is rejected", () => {
  assert.equal(normalizeRegion({ page: 1, x0: 0.5, y0: 0.5, x1: 0.5005, y1: 0.5005 }), null)
})

test("a whole-page box is rejected — a shrug is not provenance", () => {
  assert.equal(normalizeRegion({ page: 1, x0: 0, y0: 0, x1: 1, y1: 1 }), null)
  assert.equal(normalizeRegion({ page: 1, x0: 0.01, y0: 0.01, x1: 0.99, y1: 0.99 }), null)
})

test("a plausibly large but not whole-page box is kept", () => {
  // A wide line-items table is legitimately big.
  const region = normalizeRegion({ page: 1, x0: 0.05, y0: 0.3, x1: 0.95, y1: 0.75 })
  assert.ok(region)
})

test("missing or non-finite coordinates yield null", () => {
  assert.equal(normalizeRegion(null), null)
  assert.equal(normalizeRegion(undefined), null)
  assert.equal(normalizeRegion({ page: 1, x0: 0.1, y0: 0.1, x1: 0.4 }), null)
  assert.equal(normalizeRegion({ page: 1, x0: Number.NaN, y0: 0.1, x1: 0.4, y1: 0.4 }), null)
})

test("page defaults to 1 and must be positive", () => {
  assert.equal(normalizeRegion({ x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 }).page, 1)
  assert.equal(normalizeRegion({ page: 0, x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 }), null)
  assert.equal(normalizeRegion({ page: -3, x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 }), null)
})

test("a page beyond the document is rejected when the page count is known", () => {
  const raw = { page: 9, x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 }
  assert.equal(normalizeRegion(raw, { pageCount: 3 }), null)
  assert.ok(normalizeRegion(raw, { pageCount: 12 }))
  // Unknown page count must not reject — most callers do not have one.
  assert.ok(normalizeRegion(raw))
})

test("collect keeps only known fields", () => {
  const result = collectFieldProvenance([
    { field: "total", ...GOOD },
    { field: "not_a_field", x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 },
  ])
  assert.deepEqual(Object.keys(result), ["total"])
})

test("collect keeps the first claim when a field is named twice", () => {
  const result = collectFieldProvenance([
    { field: "total", page: 1, x0: 0.6, y0: 0.8, x1: 0.9, y1: 0.85 },
    { field: "total", page: 2, x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.2 },
  ])
  assert.equal(result.total.page, 1)
})

test("collect drops a field whose only box is unusable", () => {
  const result = collectFieldProvenance([
    { field: "tax", page: 1, x0: 0, y0: 0, x1: 1, y1: 1 },
    { field: "total", ...GOOD },
  ])
  assert.equal(result.tax, undefined)
  assert.ok(result.total)
})

test("every declared field name is accepted by collect", () => {
  const entries = PROVENANCE_FIELDS.map((field) => ({ field, ...GOOD }))
  const result = collectFieldProvenance(entries)
  assert.equal(Object.keys(result).length, PROVENANCE_FIELDS.length)
})

test("padding grows the box but never leaves the page", () => {
  const padded = padRegion({ page: 1, x0: 0, y0: 0.5, x1: 1, y1: 0.55 }, 0.01)
  assert.equal(padded.x0, 0)
  assert.equal(padded.x1, 1)
  assert.ok(padded.y0 < 0.5)
  assert.ok(padded.y1 > 0.55)
  assert.equal(padded.page, 1)
})
