require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")

const { FEATURE_FLAGS, FEATURE_FLAG_DEFINITIONS } = require("@/lib/feature-flags/registry")
const { isFeatureEnabledForOrg } = require("@/lib/services/feature-flags")

const ORG = "org-one"
const OFF_BY_DEFAULT = FEATURE_FLAGS.betaFeatures
const ON_BY_DEFAULT = FEATURE_FLAGS.unifiedEsign

function quietly(run) {
  const original = console.error
  console.error = () => {}
  return Promise.resolve(run()).finally(() => {
    console.error = original
  })
}

test("an unregistered flag is off even when the org has a row turning it on", async () => {
  const supabase = createFakeSupabase({ feature_flags: [{ org_id: ORG, flag_key: "made_up_flag", enabled: true }] })
  const enabled = await quietly(() =>
    isFeatureEnabledForOrg({ supabase, orgId: ORG, flagKey: "made_up_flag", defaultEnabled: true }),
  )
  assert.equal(enabled, false)
})

test("an org row decides a registered flag until it expires, then the registered default does", async () => {
  const later = new Date(Date.now() + 86_400_000).toISOString()
  const earlier = new Date(Date.now() - 86_400_000).toISOString()
  for (const [flagKey, row, expected] of [
    [OFF_BY_DEFAULT, null, false],
    [ON_BY_DEFAULT, null, true],
    [OFF_BY_DEFAULT, { enabled: true, expires_at: later }, true],
    [ON_BY_DEFAULT, { enabled: false, expires_at: null }, false],
    [OFF_BY_DEFAULT, { enabled: true, expires_at: earlier }, false],
  ]) {
    const rows = row ? [{ org_id: ORG, flag_key: flagKey, updated_at: earlier, ...row }] : []
    const supabase = createFakeSupabase({ feature_flags: rows })
    assert.equal(await isFeatureEnabledForOrg({ supabase, orgId: ORG, flagKey }), expected, JSON.stringify([flagKey, row]))
  }
})

test("another org's row never turns a flag on", async () => {
  const supabase = createFakeSupabase({ feature_flags: [{ org_id: "org-two", flag_key: OFF_BY_DEFAULT, enabled: true }] })
  assert.equal(await isFeatureEnabledForOrg({ supabase, orgId: ORG, flagKey: OFF_BY_DEFAULT }), false)
})

// Repository rule (docs/repository-health.md, "Lifecycle metadata"): every flag
// has an owner, a safe default, a review date and a deletion condition.
test("every registered flag carries its lifecycle metadata", () => {
  assert.deepEqual(Object.keys(FEATURE_FLAG_DEFINITIONS).sort(), Object.values(FEATURE_FLAGS).sort())
  for (const [key, definition] of Object.entries(FEATURE_FLAG_DEFINITIONS)) {
    assert.equal(definition.key, key)
    assert.ok(definition.owner, `${key} owner`)
    assert.equal(typeof definition.defaultEnabled, "boolean", `${key} default`)
    assert.match(definition.reviewAfter, /^\d{4}-\d{2}-\d{2}$/, `${key} review date`)
    assert.ok(definition.removalCondition.trim(), `${key} removal condition`)
  }
})
