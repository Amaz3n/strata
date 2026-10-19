"use strict"

/**
 * Option configuration rules: "the chef kitchen requires the electrical
 * upgrade", "the slab cannot be combined with the basement". The judgment is
 * pure (`lib/selections/configuration-rules.ts`); the service
 * (`lib/services/configuration-rules.ts`) decides WHICH options a home or a
 * sale is checked with, and fails closed whenever it cannot see the whole
 * picture — a flag it cannot read, a page it did not get, an option it cannot
 * resolve.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

// Catalog pricing has its own suite. Here it resolves every option as
// available in CATEGORY unless a test says otherwise.
let pricing = null
let pricingCalls = []
stubModule("@/lib/services/option-catalog", {
  resolveOptionPricing: async (args) => {
    pricingCalls.push(args)
    return pricing ?? args.items.map((item) => ({ optionId: item.optionId, available: true, categoryIds: [CATEGORY] }))
  },
})

const { evaluateConfigurationRules } = require("@/lib/selections/configuration-rules")
const {
  CONFIGURATION_RULES_FLAG,
  addOptionConfigurationRule,
  assertProjectConfiguration,
  assertSalesConfiguration,
  listOptionConfigurationRules,
  removeOptionConfigurationRule,
  searchConfigurationTargets,
} = freshRequire("lib/services/configuration-rules.ts")

const PROJECT = id(1)
const CATEGORY = id(2)
const KITCHEN = id(3)
const ELECTRICAL = id(4)
const OVERRIDE = id(5)
const COMMUNITY = id(6)
const PLAN_VERSION = id(7)
const PACKAGE = id(8)
const SELECTION_ONE = id(9)
const SELECTION_TWO = id(10)

const REQUIRES = /Chef kitchen requires Electrical upgrade/
const COMBINED = /cannot be combined/

/** KITCHEN requires ELECTRICAL, as the pure rule and as the stored row. */
const rule = {
  id: "rule",
  sourceOptionId: "a",
  targetOptionId: "b",
  kind: "requires",
  sourceName: "Chef kitchen",
  targetName: "Electrical upgrade",
}

function ruleRow(n, { source = KITCHEN, target = ELECTRICAL, kind = "requires" } = {}) {
  return {
    id: id(100000 + n),
    org_id: ORG,
    source_option_id: source,
    target_option_id: target,
    kind,
    source: { name: "Chef kitchen" },
    target: { name: "Electrical upgrade" },
  }
}

function option(optionId, overrides = {}) {
  return {
    id: optionId,
    org_id: ORG,
    name: "Option",
    parent_option_id: null,
    community_id: null,
    is_archived: false,
    is_available: true,
    ...overrides,
  }
}

function selection(selectionId, selected) {
  return { id: selectionId, org_id: ORG, project_id: PROJECT, category_id: CATEGORY, selected_option_id: selected }
}

function harness({
  flag = { enabled: true, expires_at: null },
  rules = [ruleRow(0)],
  options = [option(KITCHEN), option(ELECTRICAL)],
  selections = [selection(SELECTION_ONE, KITCHEN), selection(SELECTION_TWO, null)],
  lots = [],
  packageItems = [],
  permissions = ["selections.catalog.manage"],
  maxRows,
} = {}) {
  pricing = null
  pricingCalls = []
  return createServiceHarness({
    tables: {
      feature_flags: flag ? [{ org_id: ORG, flag_key: CONFIGURATION_RULES_FLAG, updated_at: "2026-10-01T00:00:00Z", ...flag }] : [],
      selection_configuration_rules: rules,
      selection_options: options,
      project_selections: selections,
      lots,
      communities: [{ id: COMMUNITY, org_id: ORG, division_id: id(40) }],
      selection_package_items: packageItems.map((member, n) => ({ id: id(200000 + n), org_id: ORG, ...member })),
    },
    permissions,
    maxRows,
  })
}

const checkHome = (service, changes) => service.run(() => assertProjectConfiguration(ORG, PROJECT, changes))
const checkSale = (service, items) => service.run(() => assertSalesConfiguration(ORG, items))

describe("evaluateConfigurationRules", () => {
  test("requirements and exclusions are judged against the whole proposed set", () => {
    assert.equal(evaluateConfigurationRules(["a"], [rule])[0].message, "Chef kitchen requires Electrical upgrade.")
    assert.deepEqual(evaluateConfigurationRules(["a", "b"], [rule]), [])
    assert.deepEqual(evaluateConfigurationRules(["b"], [rule]), [])
    assert.equal(evaluateConfigurationRules(["a", "b"], [{ ...rule, kind: "excludes" }]).length, 1)
  })

  test("options that require each other are valid together", () => {
    const reverse = { ...rule, id: "reverse", sourceOptionId: "b", targetOptionId: "a" }
    assert.deepEqual(evaluateConfigurationRules(["a", "b"], [rule, reverse]), [])
  })
})

describe("the enforcement flag fails closed", () => {
  test("with the flag off and no rules ever written, homes are not checked", async () => {
    const service = harness({ flag: { enabled: false }, rules: [] })
    await checkHome(service)
    assert.deepEqual(service.reads("project_selections"), [])
  })

  test("an unreadable, expiring or malformed flag stops the mutation", async () => {
    const unreadable = harness()
    unreadable.tamper("feature_flags", replies.error("offline"))
    await assert.rejects(checkHome(unreadable), /offline/)

    await assert.rejects(checkHome(harness({ flag: { enabled: true, expires_at: "2020-01-01" } })), /expiring flag/)
    for (const flag of [{ enabled: "true" }, { enabled: 0 }, { enabled: true, expires_at: "" }]) {
      await assert.rejects(checkHome(harness({ flag })), JSON.stringify(flag))
    }
  })

  test("switching the flag off cannot bypass rules that already exist", async () => {
    await assert.rejects(checkHome(harness({ flag: { enabled: false } })), /Restore configuration enforcement/)

    const unknown = harness({ flag: { enabled: false } })
    unknown.tamper("selection_configuration_rules", replies.error("offline"))
    await assert.rejects(checkHome(unknown), /existing configuration controls/)
  })

  test("an org whose rules table is not deployed yet is simply not enforced", async () => {
    for (const code of ["42P01", "PGRST205"]) {
      const service = harness({ flag: { enabled: false }, rules: [] })
      service.tamper("selection_configuration_rules", (result) => ({ ...result, data: null, error: { message: "Unapplied table", code } }))
      await checkHome(service)
    }
  })
})

describe("assertProjectConfiguration", () => {
  test("a home is checked with its proposed change applied to every other selection", async () => {
    await assert.rejects(checkHome(harness()), REQUIRES)
    await checkHome(harness(), [{ selectionId: SELECTION_TWO, optionId: ELECTRICAL }])
    await assert.rejects(checkHome(harness(), [{ selectionId: id(99), optionId: ELECTRICAL }]), /does not belong/)
  })

  test("a community override inherits the rules on its base option", async () => {
    const service = harness({
      options: [option(OVERRIDE, { parent_option_id: KITCHEN }), option(ELECTRICAL)],
      selections: [selection(SELECTION_ONE, OVERRIDE)],
    })
    await assert.rejects(checkHome(service), REQUIRES)
  })

  test("a home is priced in its own pinned plan and community", async () => {
    const service = harness({
      rules: [],
      lots: [{ org_id: ORG, project_id: PROJECT, community_id: COMMUNITY, house_plan_version_id: PLAN_VERSION }],
    })
    await checkHome(service)
    assert.deepEqual(
      pricingCalls.map(({ communityId, housePlanVersionId }) => ({ communityId, housePlanVersionId })),
      [{ communityId: COMMUNITY, housePlanVersionId: PLAN_VERSION }],
    )
  })

  test("an unavailable, recategorised or unresolvable selection stops the check", async () => {
    for (const [resolved, message] of [
      [[{ optionId: KITCHEN, available: false, categoryIds: [CATEGORY] }], /no longer available/],
      [[{ optionId: KITCHEN, available: true, categoryIds: [id(98)] }], /selection category/],
      [[], /complete home configuration/],
    ]) {
      const service = harness({ rules: [] })
      pricing = resolved
      await assert.rejects(checkHome(service), message)
    }
    const lotDown = harness({ rules: [] })
    lotDown.tamper("lots", replies.error("offline"))
    await assert.rejects(checkHome(lotDown), /configuration scope/)
  })

  test("a newly authored override is never adopted silently; an explicit change uses it", async () => {
    const options = [option(OVERRIDE, { parent_option_id: KITCHEN }), option(ELECTRICAL)]
    const resolvedToOverride = [{ optionId: OVERRIDE, available: true, categoryIds: [CATEGORY] }]
    const explicit = [{ selectionId: SELECTION_ONE, optionId: KITCHEN }]

    const silent = harness({ options })
    pricing = resolvedToOverride
    await assert.rejects(checkHome(silent), /explicitly update/)

    const withRules = harness({ options })
    pricing = resolvedToOverride
    await assert.rejects(checkHome(withRules, explicit), REQUIRES)

    const noRules = harness({ options, rules: [] })
    pricing = resolvedToOverride
    await checkHome(noRules, explicit)
  })

  test("a violation on the last of many short pages is still found", async () => {
    const rules = Array.from({ length: 15 }, (_, n) => ruleRow(n, { target: id(300 + n), kind: "excludes" }))
    rules[14] = ruleRow(14, { target: ELECTRICAL, kind: "excludes" })
    const service = harness({
      rules,
      selections: [selection(SELECTION_ONE, KITCHEN), selection(SELECTION_TWO, ELECTRICAL)],
      maxRows: 2,
    })
    await assert.rejects(checkHome(service), COMBINED)
  })
})

describe("assertSalesConfiguration", () => {
  const members = (...optionIds) => optionIds.map((optionId) => ({ package_id: PACKAGE, option_id: optionId }))

  test("a package counts as every option in it", async () => {
    await checkSale(harness({ packageItems: members(KITCHEN, ELECTRICAL) }), [{ packageId: PACKAGE }])
    await assert.rejects(checkSale(harness({ packageItems: members(KITCHEN) }), [{ packageId: PACKAGE }]), REQUIRES)
    await assert.rejects(checkSale(harness(), [{ packageId: PACKAGE }]), /contains no options/)
  })

  test("a package member on a late short page still counts", async () => {
    const service = harness({ packageItems: members(KITCHEN, KITCHEN, KITCHEN, KITCHEN, ELECTRICAL), maxRows: 2 })
    await checkSale(service, [{ packageId: PACKAGE }])
  })

  test("an option the catalog cannot resolve stops the sale", async () => {
    for (const resolved of [
      [],
      [{ available: true }],
      [{ optionId: KITCHEN, available: true }, { optionId: ELECTRICAL, available: true }],
    ]) {
      const service = harness({ rules: [] })
      pricing = resolved
      await assert.rejects(checkSale(service, [{ optionId: KITCHEN }]), /complete sales configuration/)
    }
  })
})

describe("managing rules", () => {
  test("a caller who cannot manage the catalog reads nothing", async () => {
    const service = harness({ permissions: [] })
    await assert.rejects(service.run(() => listOptionConfigurationRules(KITCHEN)), /selections\.catalog\.manage/)
    assert.deepEqual(service.queries.filter((query) => query.table.startsWith("selection_")), [])
  })

  test("with enforcement off the editor says so, after checking no rules exist", async () => {
    const service = harness({ flag: { enabled: false }, rules: [] })
    assert.deepEqual(await service.run(() => listOptionConfigurationRules(KITCHEN)), { enabled: false, rules: [] })
    assert.equal(service.reads("selection_configuration_rules").length, 1)
  })

  test("a global option can only target available, unarchived global options", async () => {
    const service = harness({
      options: [
        option(KITCHEN),
        option(id(31), { name: "Available option" }),
        option(id(32), { is_available: false }),
        option(id(33), { is_archived: true }),
        option(id(34), { community_id: COMMUNITY }),
      ],
    })
    const result = await service.run(() => searchConfigurationTargets({ sourceId: KITCHEN }))
    assert.deepEqual(result.items.map((item) => item.id), [id(31)])
  })
})

describe("authoring rules", () => {
  const author = (service, input) =>
    service.run(() => addOptionConfigurationRule({ sourceId: KITCHEN, targetId: ELECTRICAL, kind: "requires", ...input }))
  const saved = (service) => service.db.selection_configuration_rules

  test("a rule between two available options is saved and audited", async () => {
    const service = harness({ rules: [] })
    const { id: ruleId } = await author(service, { kind: "excludes" })

    assert.deepEqual(
      saved(service).map((row) => [row.id, row.source_option_id, row.target_option_id, row.kind, row.created_by]),
      [[ruleId, KITCHEN, ELECTRICAL, "excludes", service.userId]],
    )
    assert.deepEqual(service.audits.map((audit) => [audit.entityType, audit.entityId, audit.action]), [["selection_configuration_rule", ruleId, "insert"]])
  })

  test("a rule on a community override is authored against the override and may target a global option", async () => {
    const service = harness({
      rules: [],
      options: [option(KITCHEN), option(OVERRIDE, { parent_option_id: KITCHEN, community_id: COMMUNITY }), option(ELECTRICAL)],
    })
    await author(service, { sourceId: OVERRIDE })
    assert.deepEqual(saved(service).map((row) => row.source_option_id), [OVERRIDE])
  })

  test("archived, unavailable, self-referencing and out-of-scope rules are refused before anything is saved", async () => {
    const cases = [
      ["an archived target", { options: [option(KITCHEN), option(ELECTRICAL, { is_archived: true })] }, {}, /Restore archived options/],
      ["an unavailable source", { options: [option(KITCHEN, { is_available: false }), option(ELECTRICAL)] }, {}, /Restore unavailable options/],
      ["an option and its own community override", { options: [option(KITCHEN), option(OVERRIDE, { parent_option_id: KITCHEN, community_id: COMMUNITY })] }, { sourceId: OVERRIDE, targetId: KITCHEN }, /cannot require or exclude itself/],
      ["a community target for a global source", { options: [option(KITCHEN), option(ELECTRICAL, { community_id: COMMUNITY })] }, {}, /community scope/],
      ["an option that does not exist", { options: [option(KITCHEN)] }, {}, /Catalog option not found/],
    ]
    for (const [name, setup, input, message] of cases) {
      const service = harness({ rules: [], ...setup })
      await assert.rejects(author(service, input), message, name)
      assert.deepEqual(saved(service), [], name)
      assert.deepEqual(service.audits, [], name)
    }
  })

  test("a rule cannot be authored while enforcement is off or by someone who cannot manage the catalog", async () => {
    const off = harness({ flag: { enabled: false }, rules: [] })
    await assert.rejects(author(off), /not enabled/)
    const reader = harness({ rules: [], permissions: [] })
    await assert.rejects(author(reader), /selections\.catalog\.manage/)
    for (const service of [off, reader]) assert.deepEqual(service.writes("selection_configuration_rules"), [])
  })

  test("removing a rule deletes only that option's rule and records what was removed", async () => {
    const service = harness({ rules: [ruleRow(0), ruleRow(1, { source: ELECTRICAL, target: KITCHEN, kind: "excludes" })] })
    await service.run(() => removeOptionConfigurationRule({ sourceId: KITCHEN, ruleId: id(100000) }))

    assert.deepEqual(saved(service).map((row) => row.id), [id(100001)])
    assert.deepEqual(service.audits.map((audit) => [audit.action, audit.entityId, audit.before.kind]), [["delete", id(100000), "requires"]])

    await assert.rejects(service.run(() => removeOptionConfigurationRule({ sourceId: KITCHEN, ruleId: id(100001) })), /Rule changed/)
    assert.equal(saved(service).length, 1)
  })
})
