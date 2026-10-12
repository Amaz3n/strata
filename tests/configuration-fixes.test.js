"use strict"

/**
 * Fix-it suggestions for option configurations that break a rule. The
 * suggester is pure (`lib/selections/configuration-fixes.ts`) and proves every
 * fix by re-running the rules on the configuration it would produce. The
 * service (`lib/services/configuration-rules.ts`) feeds it a home's or a
 * draft's real facts, including the locks a fix may not cross; the buyer
 * portal applies a fix only through the server, which refuses a blocked one.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

const PROJECT = id(1)
const COUNTERS = id(2)
const CABINETS = id(3)
const GRANITE = id(10)
const LAMINATE = id(11)
const STANDARD_BASE = id(12)
const UPGRADED_BASE = id(13)
const TILE_BACKSPLASH = id(14)
const COUNTERS_SELECTION = id(20)
const CABINETS_SELECTION = id(21)
const GROUP = id(30)

const CATEGORY_OF = { [GRANITE]: COUNTERS, [LAMINATE]: COUNTERS, [STANDARD_BASE]: CABINETS, [UPGRADED_BASE]: CABINETS, [TILE_BACKSPLASH]: COUNTERS }
const PRICE_OF = { [GRANITE]: 450000, [LAMINATE]: 0, [STANDARD_BASE]: 0, [UPGRADED_BASE]: 120000, [TILE_BACKSPLASH]: 80000 }

// Catalog pricing has its own suite; here every option is available at a fixed price in its category.
stubModule("@/lib/services/option-catalog", {
  resolveOptionPricing: async ({ items }) => items.map((item) => item.optionId
    ? { optionId: item.optionId, available: true, priceCents: PRICE_OF[item.optionId] ?? 0, categoryIds: [CATEGORY_OF[item.optionId]] }
    : { packageId: item.packageId, available: true, priceCents: 0, categoryIds: [] }),
})
let portalAccess = null
stubModule("@/lib/services/portal-access", { assertPortalActionAccess: async () => portalAccess })
// The selection mutation and its locks have their own suite. Here it records
// each write the portal asked for — one entry per write, holding every choice
// in it — and judges the configuration for real.
let selectionWrites = []
async function writeChoices(orgId, projectId, changes) {
  await assertProjectConfiguration(orgId, projectId, changes)
  for (const change of changes) {
    await createServiceSupabaseClient().from("project_selections").update({ selected_option_id: change.optionId }).eq("org_id", orgId).eq("id", change.selectionId)
  }
  selectionWrites.push(changes.map((change) => ({ selectionId: change.selectionId, optionId: change.optionId })))
}
stubModule("@/lib/services/selections", {
  selectProjectOption: (input) => writeChoices(input.orgId, input.projectId, [input]),
  selectProjectOptions: (input) => writeChoices(input.orgId, input.projectId, input.changes),
})

const { createServiceSupabaseClient } = require("@/lib/supabase/server")
const { suggestConfigurationFixes } = require("@/lib/selections/configuration-fixes")
const { ConfigurationViolationError, evaluateConfigurationRules } = require("@/lib/selections/configuration-rules")
const { actionError } = require("@/lib/action-result")
const {
  CONFIGURATION_RULES_FLAG,
  assertProjectConfiguration,
  getHomeConfigurationFixes,
  getSalesConfigurationFixes,
  resolveHomeConfigurationFix,
} = freshRequire("lib/services/configuration-rules.ts")
const { applyConfigurationFixAction, selectOptionAction } = freshRequire("app/p/[token]/selections/actions.ts")

const NAMES = { [GRANITE]: "Granite counters", [LAMINATE]: "Laminate counters", [STANDARD_BASE]: "Standard cabinet base", [UPGRADED_BASE]: "Upgraded cabinet base", [TILE_BACKSPLASH]: "Tile backsplash" }

function rule(ruleId, source, target, kind = "requires") {
  return { id: ruleId, sourceOptionId: source, targetOptionId: target, kind, sourceName: NAMES[source], targetName: NAMES[target] }
}

const GRANITE_NEEDS_BASE = rule("granite-needs-base", GRANITE, UPGRADED_BASE)

function meta(exclusive = false) {
  return Object.fromEntries(Object.keys(NAMES).map((optionId) => [optionId, { name: NAMES[optionId], categoryIds: [CATEGORY_OF[optionId]], parentOptionId: null, exclusive }]))
}

/** A home with one counters and one cabinets selection. */
function home({ counters = GRANITE, cabinets = STANDARD_BASE, rules = [GRANITE_NEEDS_BASE], locks } = {}) {
  const selected = [counters, cabinets].filter(Boolean)
  return {
    violations: evaluateConfigurationRules(selected, rules),
    rules,
    optionMeta: meta(),
    availableOptionIds: Object.keys(NAMES),
    prices: PRICE_OF,
    slots: [
      { selectionId: COUNTERS_SELECTION, categoryId: COUNTERS, optionId: counters },
      { selectionId: CABINETS_SELECTION, categoryId: CABINETS, optionId: cabinets },
    ],
    locks,
  }
}

/** A draft agreement with free-standing lines. */
function draft(optionIds, rules, { exclusive = false } = {}) {
  return {
    violations: evaluateConfigurationRules(optionIds, rules),
    rules,
    optionMeta: meta(exclusive),
    availableOptionIds: Object.keys(NAMES),
    prices: PRICE_OF,
    picks: optionIds.map((optionId) => ({ optionId, name: NAMES[optionId], optionIds: [optionId] })),
  }
}

const summary = (fixes) => fixes.map((fix) => [fix.kind, fix.label, fix.priceDeltaCents, fix.blockedBy])

describe("suggestConfigurationFixes", () => {
  test("a valid configuration needs no fixes", () => {
    assert.deepEqual(suggestConfigurationFixes(home({ cabinets: UPGRADED_BASE })), [])
  })

  test("a missing requirement is fixed by adding it or by dropping what needs it", () => {
    const fixes = suggestConfigurationFixes(draft([GRANITE], [GRANITE_NEEDS_BASE]))
    assert.deepEqual(summary(fixes), [
      ["add_option", "Add Upgraded cabinet base", 120000, null],
      ["swap_option", "Switch Granite counters to Tile backsplash", -370000, null],
      ["remove_option", "Remove Granite counters", -450000, null],
      ["swap_option", "Switch Granite counters to Laminate counters", -450000, null],
    ], "the smallest price change ranks first")
    for (const fix of fixes) {
      assert.deepEqual(fix.resultingViolations, [])
      assert.deepEqual(fix.resolves, ["granite-needs-base"])
      assert.equal(fix.applicable, true)
    }
  })

  test("on a home, every fix lands in a selection: the requirement swaps into its category", () => {
    const fixes = suggestConfigurationFixes(home())
    const upgrade = fixes.find((fix) => fix.add?.optionId === UPGRADED_BASE)
    assert.equal(upgrade.kind, "swap_option")
    assert.equal(upgrade.selectionId, CABINETS_SELECTION)
    assert.deepEqual(upgrade.remove, { optionId: STANDARD_BASE, name: "Standard cabinet base" })
    assert.equal(upgrade.label, "Switch Standard cabinet base to Upgraded cabinet base")
    assert.ok(fixes.every((fix) => fix.kind !== "remove_option"), "a home selection is replaced, never emptied")
  })

  test("an empty selection is filled rather than swapped", () => {
    const fixes = suggestConfigurationFixes(home({ cabinets: null }))
    const fill = fixes.find((fix) => fix.add?.optionId === UPGRADED_BASE)
    assert.equal(fill.kind, "add_option")
    assert.equal(fill.remove, null)
  })

  test("an exclusion is fixed by removing or swapping either side", () => {
    const excludes = rule("granite-excludes-tile", GRANITE, TILE_BACKSPLASH, "excludes")
    const fixes = suggestConfigurationFixes(draft([GRANITE, TILE_BACKSPLASH], [excludes]))
    assert.deepEqual(fixes.filter((fix) => fix.kind === "remove_option").map((fix) => fix.remove.optionId).sort(), [GRANITE, TILE_BACKSPLASH].sort())
    assert.ok(fixes.some((fix) => fix.kind === "swap_option" && fix.remove.optionId === GRANITE && fix.add.optionId === LAMINATE))
    assert.ok(fixes.every((fix) => fix.resultingViolations.length === 0))
  })

  test("a fix that would break another rule is not offered", () => {
    const laminateNeedsBase = rule("laminate-needs-base", LAMINATE, UPGRADED_BASE)
    const tileNeedsBase = rule("tile-needs-base", TILE_BACKSPLASH, UPGRADED_BASE)
    const fixes = suggestConfigurationFixes(home({ rules: [GRANITE_NEEDS_BASE, laminateNeedsBase, tileNeedsBase] }))
    assert.deepEqual(summary(fixes), [["swap_option", "Switch Standard cabinet base to Upgraded cabinet base", 120000, null]])
  })

  test("in a one-per-category draft, adding the requirement replaces its sibling", () => {
    const fixes = suggestConfigurationFixes(draft([GRANITE, STANDARD_BASE], [GRANITE_NEEDS_BASE], { exclusive: true }))
    const upgrade = fixes.find((fix) => fix.add?.optionId === UPGRADED_BASE)
    assert.equal(upgrade.kind, "swap_option")
    assert.equal(upgrade.remove.optionId, STANDARD_BASE)
  })

  test("a fix that touches a locked selection or a frozen structural option is blocked, not applicable", () => {
    const cutoff = suggestConfigurationFixes(home({ locks: { bySelectionId: { [CABINETS_SELECTION]: "cutoff" } } }))
    const upgrade = cutoff.find((fix) => fix.add?.optionId === UPGRADED_BASE)
    assert.equal(upgrade.blockedBy, "cutoff")
    assert.equal(upgrade.applicable, false)
    assert.ok(cutoff.filter((fix) => fix.selectionId === COUNTERS_SELECTION).every((fix) => fix.applicable))
    assert.ok(cutoff[0].applicable, "fixes that can be applied rank first")

    const structural = suggestConfigurationFixes(home({ locks: { structuralOptionIds: [UPGRADED_BASE] } }))
    assert.equal(structural.find((fix) => fix.add?.optionId === UPGRADED_BASE).blockedBy, "structural")
  })
})

function homeHarness({ cutoff = null, status = "selected", lockedAt = null, rules = [ruleRow()], tables = {}, permissions = ["selections.read", "selections.write"] } = {}) {
  portalAccess = { org_id: ORG, project_id: PROJECT, contact_id: null }
  selectionWrites = []
  const option = (optionId) => ({ id: optionId, org_id: ORG, name: NAMES[optionId], category_id: CATEGORY_OF[optionId], parent_option_id: null, community_id: null, option_scope: "design_studio", is_archived: false, is_available: true })
  return createServiceHarness({
    tables: {
      feature_flags: [{ org_id: ORG, flag_key: CONFIGURATION_RULES_FLAG, enabled: true, expires_at: null, updated_at: "2026-10-01T00:00:00Z" }],
      selection_configuration_rules: rules,
      selection_options: Object.keys(NAMES).map(option),
      selection_categories: [{ id: COUNTERS, org_id: ORG, parent_category_id: null }, { id: CABINETS, org_id: ORG, parent_category_id: null }],
      project_selections: [
        { id: COUNTERS_SELECTION, org_id: ORG, project_id: PROJECT, category_id: COUNTERS, selected_option_id: LAMINATE, status: "selected", group_id: null, locked_at: null, metadata: {} },
        { id: CABINETS_SELECTION, org_id: ORG, project_id: PROJECT, category_id: CABINETS, selected_option_id: STANDARD_BASE, status, group_id: GROUP, locked_at: lockedAt, metadata: {} },
      ],
      project_selection_groups: [{ org_id: ORG, project_id: PROJECT, group_id: GROUP, status: "open", cutoff_date: cutoff, group: { name: "Kitchen" } }],
      projects: [{ id: PROJECT, org_id: ORG, property_type: "production" }],
      orgs: [{ id: ORG, product_tier: "production" }],
      contracts: [],
      lots: [],
      ...tables,
    },
    permissions,
  })
}

function ruleRow() {
  return { id: id(500), org_id: ORG, source_option_id: GRANITE, target_option_id: UPGRADED_BASE, kind: "requires", source: { name: NAMES[GRANITE] }, target: { name: NAMES[UPGRADED_BASE] } }
}

const CHOOSE_GRANITE = { selectionId: COUNTERS_SELECTION, optionId: GRANITE }
const upgradeFix = (fixes) => fixes.find((fix) => fix.add?.optionId === UPGRADED_BASE)

describe("configuration failures are structured", () => {
  test("a refused configuration throws the violations, and an action returns them instead of a digest", async () => {
    const service = homeHarness()
    const error = await service.run(() => assertProjectConfiguration(ORG, PROJECT, [CHOOSE_GRANITE])).catch((caught) => caught)
    assert.ok(error instanceof ConfigurationViolationError)
    assert.equal(error.message, "Granite counters requires Upgraded cabinet base.")
    assert.deepEqual(error.violations.map((violation) => [violation.kind, violation.sourceOptionId, violation.targetOptionId]), [["requires", GRANITE, UPGRADED_BASE]])
    const result = actionError(error)
    assert.equal(result.success, false)
    assert.equal(result.code, "CONFIGURATION_VIOLATION")
    assert.equal(result.violations.length, 1)
  })

  test("a home's fixes are worked out against the proposed choice, read-only", async () => {
    const service = homeHarness()
    const issues = await service.run(() => getHomeConfigurationFixes(ORG, PROJECT, { portalAccess: true, changes: [CHOOSE_GRANITE] }))
    assert.deepEqual(issues.violations.map((violation) => violation.message), ["Granite counters requires Upgraded cabinet base."])
    const upgrade = upgradeFix(issues.fixes)
    assert.equal(upgrade.selectionId, CABINETS_SELECTION)
    assert.equal(upgrade.priceDeltaCents, 120000)
    assert.equal(upgrade.applicable, true)
    assert.deepEqual(service.writes(), [])
    assert.deepEqual(await service.run(() => getHomeConfigurationFixes(ORG, PROJECT, { portalAccess: true })), { violations: [], fixes: [] })
  })

  test("a choice the rules refuse comes back from the portal with its corrections", async () => {
    const service = homeHarness()
    const result = await service.run(() => selectOptionAction({ token: "token", ...CHOOSE_GRANITE }))
    assert.equal(result.success, false)
    assert.equal(result.violations[0].targetOptionId, UPGRADED_BASE)
    assert.ok(upgradeFix(result.fixes))
    assert.deepEqual(selectionWrites, [])
  })
})

describe("a draft agreement's fixes edit its lines", () => {
  test("the sales configurator gets the rules a draft breaks and the line changes that clear them", async () => {
    const LOT = id(40)
    const COMMUNITY = id(41)
    const service = homeHarness({
      permissions: ["sales.read"],
      tables: {
        lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, house_plan_version_id: id(42), project_id: null }],
        communities: [{ id: COMMUNITY, org_id: ORG, division_id: id(43) }],
      },
    })
    const issues = await service.run(() => getSalesConfigurationFixes({ lotId: LOT, optionItems: [{ optionId: GRANITE }] }))
    assert.deepEqual(issues.violations.map((violation) => violation.id), [id(500)])
    assert.deepEqual(issues.fixes.find((fix) => fix.kind === "add_option").add, { optionId: UPGRADED_BASE, name: "Upgraded cabinet base" })
    assert.deepEqual(issues.fixes.find((fix) => fix.kind === "remove_option").remove, { optionId: GRANITE, name: "Granite counters" })
    assert.deepEqual(service.writes(), [])
  })
})

describe("a correction cannot cross a lock", () => {
  test("an applicable correction lands in one write with the choice it clears", async () => {
    const service = homeHarness()
    const { fixes } = await service.run(() => getHomeConfigurationFixes(ORG, PROJECT, { portalAccess: true, changes: [CHOOSE_GRANITE] }))
    const result = await service.run(() => applyConfigurationFixAction({ token: "token", fixId: upgradeFix(fixes).id, proposal: CHOOSE_GRANITE }))
    assert.equal(result.success, true, result.error)
    assert.deepEqual(selectionWrites, [[{ selectionId: CABINETS_SELECTION, optionId: UPGRADED_BASE }, CHOOSE_GRANITE]])
  })

  for (const [lock, setup] of [
    ["cutoff", { cutoff: "2000-01-01" }],
    ["locked", { lockedAt: "2026-09-01T00:00:00Z" }],
    ["confirmed", { status: "confirmed" }],
  ]) {
    test(`a correction into a ${lock} selection is blocked and refused by the server`, async () => {
      const service = homeHarness(setup)
      const { fixes } = await service.run(() => getHomeConfigurationFixes(ORG, PROJECT, { portalAccess: true, changes: [CHOOSE_GRANITE] }))
      const upgrade = upgradeFix(fixes)
      assert.equal(upgrade.blockedBy, lock)

      const result = await service.run(() => applyConfigurationFixAction({ token: "token", fixId: upgrade.id, proposal: CHOOSE_GRANITE }))
      assert.equal(result.success, false)
      assert.equal(result.code, "CONFIGURATION_FIX_BLOCKED")
      assert.match(result.error, /change order/)
      assert.deepEqual(selectionWrites, [])
    })
  }

  test("a client cannot invent a correction the server did not suggest", async () => {
    const service = homeHarness({ cutoff: "2000-01-01" })
    await assert.rejects(
      service.run(() => resolveHomeConfigurationFix(ORG, PROJECT, { fixId: `swap_option:${CABINETS_SELECTION}::${UPGRADED_BASE}`, changes: [CHOOSE_GRANITE] }, { portalAccess: true })),
      /no longer applies/,
    )
  })
})
