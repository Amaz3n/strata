require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const { getDefaultProjectPropertyType, getProjectPosture, normalizeProductTier } = require("../lib/product-tier")
const { terminology } = require("../lib/terminology")
const { isProjectModuleEnabled } = require("../lib/project-modules")

test("explicit project property type wins over org tier in a mixed org", () => {
  assert.equal(getProjectPosture("residential", "commercial"), "residential")
  assert.equal(getProjectPosture("commercial", "residential"), "commercial")
})

test("org tier supplies only the default when project posture is absent", () => {
  assert.equal(getProjectPosture(null, "commercial"), "commercial")
  assert.equal(getProjectPosture("production", "residential"), "production")
  assert.equal(getProjectPosture(null, "production"), "production")
  assert.equal(getDefaultProjectPropertyType("commercial"), "commercial")
  assert.equal(getDefaultProjectPropertyType("production"), "production")
  assert.equal(normalizeProductTier("unexpected"), "residential")
})

test("terminology remains centralized for every posture", () => {
  assert.equal(terminology("residential").owner, "Client")
  assert.equal(terminology("commercial").owner, "Owner")
  assert.equal(terminology("production").owner, "Buyer")
})

test("module overrides beat posture defaults without gating the route", () => {
  assert.equal(isProjectModuleEnabled({ moduleKey: "safety", posture: "residential", postures: ["commercial"] }), false)
  assert.equal(isProjectModuleEnabled({ moduleKey: "safety", posture: "production", postures: ["commercial"] }), false)
  assert.equal(isProjectModuleEnabled({ moduleKey: "safety", posture: "residential", postures: ["commercial"], overrides: { safety: true } }), true)
  assert.equal(isProjectModuleEnabled({ moduleKey: "safety", posture: "commercial", postures: ["commercial"], overrides: { safety: false } }), false)
})
