const assert = require("node:assert/strict")
const test = require("node:test")
const { createServiceHarness, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")
const { evaluateConfigurationRules } = require("../lib/selections/configuration-rules")
const rule = { id: "rule", sourceOptionId: "a", targetOptionId: "b", kind: "requires", sourceName: "Chef kitchen", targetName: "Electrical upgrade" }

test("requirements and exclusions are evaluated against the complete proposed option set", () => {
  assert.equal(evaluateConfigurationRules(["a"], [rule])[0].message, "Chef kitchen requires Electrical upgrade.")
  assert.equal(evaluateConfigurationRules(["a", "b"], [rule]).length, 0)
  assert.equal(evaluateConfigurationRules(["b"], [rule]).length, 0)
  assert.equal(evaluateConfigurationRules(["a", "b"], [{ ...rule, kind: "excludes" }]).length, 1)
})

test("mutually required package options are valid when selected together", () => {
  assert.equal(evaluateConfigurationRules(["a", "b"], [rule, { ...rule, id: "reverse", sourceOptionId: "b", targetOptionId: "a" }]).length, 0)
})

const FLAG_KEY = "production_configuration_rules"
let pricingOverride = null
let pricingCalls = []
stubModule("@/lib/services/option-catalog", {
  resolveOptionPricing: async (args) => {
    pricingCalls.push(args)
    return pricingOverride ?? args.items.map((item) => ({ optionId: item.optionId, available: true, categoryIds: ["category"] }))
  },
})
const api = freshRequire("lib/services/configuration-rules.ts")

function failing(message, code) {
  return (result) => ({ ...result, data: null, error: { message, code } })
}

function service({ pricing = null, lot = null, lotError = false, denied = false, packageItems = [], flag = { enabled: true }, flagError = false, ruleError = null, rowCap, rules = [rule], options = [{ id: "a", parent_option_id: null }, { id: "b", parent_option_id: null }], selections = [{ id: "one", selected_option_id: "a" }, { id: "two", selected_option_id: null }] } = {}) {
  pricingOverride = pricing
  pricingCalls = []
  const harness = createServiceHarness({
    permissions: denied ? [] : ["selections.catalog.manage"],
    maxRows: rowCap,
    tables: {
      lots: lot ? [{ org_id: ORG, project_id: "project", ...lot }] : [],
      feature_flags: [{ org_id: ORG, flag_key: FLAG_KEY, ...flag }],
      selection_package_items: packageItems.map((row, i) => ({ id: `package-item-${String(i).padStart(5, "0")}`, org_id: ORG, ...row })),
      project_selections: selections.map((row) => ({ org_id: ORG, project_id: "project", category_id: "category", ...row })),
      selection_options: options.map((row) => ({ org_id: ORG, ...row })),
      selection_configuration_rules: rules.map((item) => ({
        id: item.id,
        org_id: ORG,
        kind: item.kind,
        source_option_id: item.sourceOptionId,
        target_option_id: item.targetOptionId,
        source: { name: item.sourceName },
        target: { name: item.targetName },
      })),
    },
  })
  if (flagError) harness.tamper("feature_flags", failing("offline"))
  if (lotError) harness.tamper("lots", failing("offline"))
  if (ruleError) harness.tamper("selection_configuration_rules", failing(ruleError.message, ruleError.code))
  const wrapped = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (...args) => harness.run(() => fn(...args))]))
  return {
    api: wrapped,
    get reads() { return harness.queries.filter((query) => query.action === "select").map((query) => query.table) },
    get pricingCalls() { return pricingCalls },
  }
}

test("rollout is disabled until activated, while flag lookup failures fail closed", async () => {
  const disabled = service({ flag: { enabled: false }, rules: [] })
  await disabled.api.assertProjectConfiguration(ORG, "project")
  assert.equal(disabled.reads.includes("project_selections"), false, "a disabled rollout does not read the home")
  await assert.rejects(service({ flagError: true }).api.assertProjectConfiguration(ORG, "project"), /offline/)
  await assert.rejects(service({ flag: { enabled: true, expires_at: "2020-01-01" } }).api.assertProjectConfiguration(ORG, "project"), /expiring flag/)
})

test("a proposed replacement is checked with the other selections before a mutation", async () => {
  await assert.rejects(service().api.assertProjectConfiguration(ORG, "project"), /requires Electrical upgrade/)
  await service().api.assertProjectConfiguration(ORG, "project", [{ selectionId: "two", optionId: "b" }])
  await assert.rejects(service().api.assertProjectConfiguration(ORG, "project", [{ selectionId: "foreign-selection", optionId: "b" }]), /does not belong/)
})

test("community option overrides inherit rules on their canonical parent", async () => {
  const instance = service({ options: [{ id: "override", parent_option_id: "a" }], selections: [{ id: "one", selected_option_id: "override" }] })
  await assert.rejects(instance.api.assertProjectConfiguration(ORG, "project"), /requires Electrical upgrade/)
})


test("rule management denies unauthorized users before any catalog or rule reads", async () => {
  const sourceId = "00000000-0000-4000-8000-000000000001"
  const instance = service({ denied: true })
  await assert.rejects(instance.api.listOptionConfigurationRules(sourceId), /permission/i)
  assert.equal(instance.reads.some((table) => ["selection_options", "selection_configuration_rules"].includes(table)), false)
})

test("disabled rule management reports deployment state after checking for existing rules", async () => {
  const sourceId = "00000000-0000-4000-8000-000000000001"
  const instance = service({ flag: { enabled: false }, rules: [], options: [{ id: sourceId, community_id: null }] })
  const result = await instance.api.listOptionConfigurationRules(sourceId)
  assert.equal(result.enabled, false)
  assert.equal(instance.reads.includes("selection_configuration_rules"), true)
})


test("sales configurations expand packages and reject missing requirements or empty packages", async () => {
  await service({ packageItems: [{ package_id: "package", option_id: "a" }, { package_id: "package", option_id: "b" }] }).api.assertSalesConfiguration(ORG, [{ packageId: "package" }])
  await assert.rejects(service({ packageItems: [{ package_id: "package", option_id: "a" }] }).api.assertSalesConfiguration(ORG, [{ packageId: "package" }]), /requires Electrical upgrade/)
  await assert.rejects(service().api.assertSalesConfiguration(ORG, [{ packageId: "empty" }]), /contains no options/)
})


test("rule target picker excludes unavailable, archived and community-only options from a global source", async () => {
  const sourceId = "00000000-0000-4000-8000-000000000001"
  const available = { community_id: null, is_archived: false, is_available: true }
  const instance = service({ options: [
    { ...available, id: sourceId },
    { ...available, id: "valid", name: "Available option" },
    { ...available, id: "unavailable", is_available: false },
    { ...available, id: "archived", is_archived: true },
    { ...available, id: "community-only", community_id: "community" },
  ] })
  const result = await instance.api.searchConfigurationTargets({ sourceId })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].id, "valid")
})


test("home preflight uses its pinned plan/community and rejects unavailable or recategorized selections", async () => {
  const instance = service({ rules: [], lot: { community_id: "community", house_plan_version_id: "pinned-version" } })
  await instance.api.assertProjectConfiguration(ORG, "project")
  assert.equal(instance.pricingCalls[0].communityId, "community")
  assert.equal(instance.pricingCalls[0].housePlanVersionId, "pinned-version")
  await assert.rejects(service({ pricing: [{ optionId: "a", available: false, categoryIds: ["category"] }] }).api.assertProjectConfiguration(ORG, "project"), /no longer available/)
  await assert.rejects(service({ pricing: [{ optionId: "a", available: true, categoryIds: ["different"] }] }).api.assertProjectConfiguration(ORG, "project"), /selection category/)
  await assert.rejects(service({ lotError: true }).api.assertProjectConfiguration(ORG, "project"), /configuration scope/)
  await assert.rejects(service({ pricing: [] }).api.assertProjectConfiguration(ORG, "project"), /complete home configuration/)
})

test("home preflight requires explicit adoption of a new override and validates its own rules", async () => {
  const options = [{ id: "override", parent_option_id: "a" }, { id: "b", parent_option_id: null }]
  const pricing = [{ optionId: "override", available: true, categoryIds: ["category"] }]
  await assert.rejects(service({ options, pricing }).api.assertProjectConfiguration(ORG, "project"), /explicitly update/)
  // Explicit changes use the effective override, including inherited requirements.
  await assert.rejects(service({ options, pricing }).api.assertProjectConfiguration(ORG, "project", [{ selectionId: "one", optionId: "a" }]), /requires Electrical upgrade/)
  await service({ options, pricing, rules: [] }).api.assertProjectConfiguration(ORG, "project", [{ selectionId: "one", optionId: "a" }])
})


test("configuration validation reads every rule when 100 sources reach the supported 200-rule limit", async () => {
  const options = Array.from({ length: 100 }, (_, i) => ({ id: `source-${i}`, parent_option_id: null }))
  const selections = options.map((option, i) => ({ id: `selection-${i}`, selected_option_id: option.id }))
  const rules = options.flatMap((option) => Array.from({ length: 200 }, (_, i) => ({ ...rule, id: `${option.id}-${i}`, sourceOptionId: option.id, targetOptionId: `unselected-${i}`, kind: "excludes" })))
  const instance = service({ options, selections, rules })
  await instance.api.assertProjectConfiguration(ORG, "project")
  assert.equal(instance.reads.filter((table) => table === "selection_configuration_rules").length, 41)
  // A violation on the final full page must not be silently truncated.
  rules[rules.length - 1] = { ...rules[rules.length - 1], targetOptionId: options[0].id }
  await assert.rejects(service({ options, selections, rules }).api.assertProjectConfiguration(ORG, "project"), /cannot be combined/)
})

test("malformed controls and disabled enforcement with existing rules cannot bypass preflight", async () => {
  for (const flag of [{ enabled: "true" }, { enabled: 0 }, { enabled: true, expires_at: "" }]) {
    await assert.rejects(service({ flag }).api.assertProjectConfiguration(ORG, "project"))
  }
  await assert.rejects(service({ flag: { enabled: false } }).api.assertProjectConfiguration(ORG, "project"), /Restore configuration enforcement/)
  await assert.rejects(service({ flag: { enabled: false }, ruleError: { message: "offline", code: "08006" } }).api.assertProjectConfiguration(ORG, "project"), /existing configuration controls/)
  for (const code of ["42P01", "PGRST205"]) {
    await service({ flag: { enabled: false }, rules: [], ruleError: { message: "Unapplied table", code } }).api.assertProjectConfiguration(ORG, "project")
  }
})

test("short provider pages do not hide a late configuration violation or package member", async () => {
  const rules = Array.from({ length: 15 }, (_, i) => ({ ...rule, id: `rule-${String(i).padStart(3, "0")}`, sourceOptionId: "a", targetOptionId: `absent-${i}`, kind: "excludes" }))
  rules[14] = { ...rules[14], targetOptionId: "b" }
  await assert.rejects(service({ rowCap: 2, rules, selections: [{ id: "one", selected_option_id: "a" }, { id: "two", selected_option_id: "b" }] }).api.assertProjectConfiguration(ORG, "project"), /cannot be combined/)
  const members = Array.from({ length: 5 }, (_, i) => ({ package_id: "package", option_id: i === 4 ? "b" : "a" }))
  await service({ rowCap: 2, packageItems: members }).api.assertSalesConfiguration(ORG, [{ packageId: "package" }])
})

test("sales validation rejects missing or malformed resolved option identities", async () => {
  for (const pricing of [[], [{ available: true }], [{ optionId: "a", available: true }, { optionId: "b", available: true }]]) {
    await assert.rejects(service({ pricing, rules: [] }).api.assertSalesConfiguration(ORG, [{ optionId: "a" }]), /complete sales configuration/)
  }
})
