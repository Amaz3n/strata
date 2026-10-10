require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { agreementStructuralSelections, assertOneStructuralOptionPerCategory } = require("../lib/sales/agreement-selections")

const garage = { id: "garage", name: "Extended garage bay", categoryId: "structure", costCents: 11_000_00 }
const lanai = { id: "lanai", name: "Covered lanai", categoryId: "structure", costCents: 6_000_00 }

test("each signed structural option carries its agreed price and its cost", () => {
  const pricing = { structuralOptions: [{ optionId: "garage", label: "Extended garage bay", priceCents: 18_500_00 }] }
  assert.deepEqual(agreementStructuralSelections(pricing, [garage]), [
    { optionId: "garage", categoryId: "structure", priceCents: 18_500_00, costCents: 11_000_00 },
  ])
})

test("two structural options in one category are refused, never silently dropped", () => {
  const pricing = { structuralOptions: [
    { optionId: "garage", label: "Extended garage bay", priceCents: 18_500_00 },
    { optionId: "lanai", label: "Covered lanai", priceCents: 9_000_00 },
  ] }
  assert.throws(() => agreementStructuralSelections(pricing, [garage, lanai]), /same category/)
  assert.throws(() => assertOneStructuralOptionPerCategory([garage, lanai]), /same category/)
  assert.doesNotThrow(() => assertOneStructuralOptionPerCategory([garage, { ...lanai, categoryId: "outdoor" }]))
})

test("a signed option missing from the catalog is refused", () => {
  const pricing = { structuralOptions: [{ optionId: "garage", label: "Extended garage bay", priceCents: 18_500_00 }] }
  assert.throws(() => agreementStructuralSelections(pricing, []), /could not be found/)
})
