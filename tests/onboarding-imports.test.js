const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

test("NAHB catalog has six parents and 180 unique child codes", () => {
  const source = read("lib/data/nahb-cost-codes.ts")
  const groups = [...source.matchAll(/group: "(\d{4})"/g)].map((match) => match[1])
  const children = [...source.matchAll(/\["(\d{4})", "[^"]+"(?:, "[^"]+")?\]/g)].map((match) => match[1])
  assert.equal(groups.length, 6)
  assert.equal(children.length, 180)
  assert.equal(new Set([...groups, ...children]).size, 186)
  assert.match(source, /NAHB_COST_CODE_ROW_COUNT/)
})
test("all seven importers share staged validation and deterministic natural keys", () => {
  const definitions = read("lib/services/import-definitions.ts")
  const service = read("lib/services/imports.ts")
  for (const importer of ["cost_codes", "plan_library", "option_catalog", "price_book", "communities_lots", "open_wip", "team"]) {
    assert.match(definitions, new RegExp(`\\b${importer}: \\{`))
  }
  assert.match(service, /MAX_ROWS = 10_000/)
  assert.match(service, /INSERT_CHUNK = 500/)
  assert.match(service, /duplicate_natural_key/)
  assert.match(service, /budget_total_mismatch/)
  assert.match(service, /status: "committing"/)
})

test("Open-WIP cutover imports current state without historical financial rows", () => {
  const service = read("lib/services/imports.ts")
  assert.match(service, /remaining_cents/)
  assert.match(service, /imported_open_wip: true/)
  assert.match(service, /completed_at_cutover/)
  for (const forbidden of ["invoices", "vendor_bills", "payments", "draws"]) {
    assert.doesNotMatch(service, new RegExp(`\\.from\\("${forbidden}"\\)`))
  }
})

test("org imports are permission-gated and team imports never email", () => {
  const service = read("lib/services/imports.ts")
  assert.match(service, /requirePermission\("import\.manage"/)
  assert.match(service, /Open-WIP cutover is restricted to the platform/)
  assert.match(service, /sendEmail: false/)
  assert.match(read("supabase/migrations/20260719022535_onboarding_and_import_staging.sql"), /has_org_permission\(org_id, 'import\.manage'\)/)
})

test("pilot gate requires all fifteen audited surfaces and an Arc-native start", () => {
  const audit = read("lib/data/onboarding-readiness.ts")
  const onboarding = read("lib/services/onboarding.ts")
  assert.equal([...audit.matchAll(/^  \["/gm)].length, 15)
  assert.match(onboarding, /expectedKeys\.size/)
  assert.match(onboarding, /arc_native_project_id/)
  assert.match(onboarding, /status", "released"/)
})

test("sample community is idempotent, notification-silent, and reset-guarded", () => {
  const seed = read("lib/services/demo-community-seed.ts")
  assert.match(seed, /contains\("metadata", \{ is_sample: true \}\)\.maybeSingle/)
  assert.match(seed, /Only a marked sample community can be removed/)
  assert.doesNotMatch(seed, /sendEmail|notification/i)
  assert.match(seed, /sample-buyer-%@example\.invalid/)
  assert.match(seed, /release_house_plan_version/)
})
