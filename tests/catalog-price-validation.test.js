require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { catalogPriceSchema, catalogPricePublicationSchema } = require("../lib/validation/selections")
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`
const cell = { housePlanVersionId: id(1), priceCents: 100, expectedPrice: null }
test("single and bulk catalog prices require exactly one reviewed target", () => {
  for (const target of [{ optionId: id(2) }, { packageId: id(3) }, {}, { optionId: id(2), packageId: id(3) }]) {
    const valid = Object.keys(target).length === 1
    assert.equal(catalogPriceSchema.safeParse({ ...cell, ...target }).success, valid)
    assert.equal(catalogPricePublicationSchema.safeParse({ publicationKey: id(4), items: [{ ...cell, ...target }] }).success, valid)
  }
})
test("bulk prices preserve duplicate-cell and database integer checks", () => {
  const item = { ...cell, optionId: id(2) }, publication = { publicationKey: id(4), items: [item] }
  assert.equal(catalogPricePublicationSchema.safeParse(publication).success, true)
  assert.throws(() => catalogPricePublicationSchema.parse({ ...publication, items: [item, item] }), /only once/)
  for (const field of ["priceCents", "costCents"]) assert.throws(() => catalogPricePublicationSchema.parse({ ...publication, items: [{ ...item, [field]: 2147483648 }] }))
  assert.throws(() => catalogPricePublicationSchema.parse({ items: [item] }))
})
