require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const {
  getDefaultProjectPropertyType,
  getProjectPosture,
  normalizeProductTier,
  shouldShowCustomBuildNavigation,
  shouldShowProductionOrgNavigation,
} = require("../lib/product-tier")
const { ORG } = require("./support/service")
const { terminology } = require("../lib/terminology")
const { PROJECT_MODULES, isProjectModuleEnabled } = require("../lib/project-modules")

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

test("a mixed org gives each project its own vocabulary and modules", () => {
  const orgTier = "production"
  const home = getProjectPosture("residential", orgTier)
  const lot = getProjectPosture("production", orgTier)

  assert.equal(terminology(home).owner, "Client")
  assert.equal(terminology(home).projects, "Projects")
  assert.equal(terminology(lot).owner, "Buyer")
  assert.equal(terminology(lot).projects, "Homes")

  const inspections = PROJECT_MODULES.find((module) => module.key === "inspections")
  const enabled = (posture) =>
    isProjectModuleEnabled({ moduleKey: "inspections", posture, postures: inspections.postures })
  assert.equal(enabled(home), false)
  assert.equal(enabled(lot), true)
})

test("an org's navigation follows its projects, not only its tier", async () => {
  const { createServiceHarness, id } = require("./support/service")
  const { freshRequire } = require("./support/modules")
  const { orgHasProductionProjects, orgHasActiveNonProductionProjects } =
    freshRequire("lib/services/production-desk-scope.ts")

  const mixed = createServiceHarness({
    tables: {
      projects: [
        { id: id(1), org_id: ORG, property_type: "production", status: "active" },
        { id: id(2), org_id: ORG, property_type: "residential", status: "active" },
      ],
    },
    permissions: ["org.member"],
  })
  assert.equal(await mixed.run(() => orgHasProductionProjects()), true)
  assert.equal(await mixed.run(() => orgHasActiveNonProductionProjects()), true)

  const productionOnly = createServiceHarness({
    tables: {
      projects: [
        { id: id(1), org_id: ORG, property_type: "production", status: "active" },
        { id: id(2), org_id: ORG, property_type: "residential", status: "completed" },
        { id: id(3), org_id: id(900099), property_type: "residential", status: "active" },
      ],
    },
    permissions: ["org.member"],
  })
  assert.equal(await productionOnly.run(() => orgHasActiveNonProductionProjects()), false)

  assert.equal(shouldShowCustomBuildNavigation("production", false), false)
  assert.equal(shouldShowCustomBuildNavigation("production", true), true)
  assert.equal(shouldShowCustomBuildNavigation("residential", false), true)
  assert.equal(shouldShowProductionOrgNavigation("residential", true), true)
})
