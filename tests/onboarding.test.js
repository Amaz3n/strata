// Platform onboarding of a customer org: support.read inspects, support.write
// changes, and nothing is ever authorized by a tenant grant.

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { id, ORG, ACTOR } = require("./support/service")
const { platformActor, dataQueries } = require("./support/platform")
const { freshRequire, stubModule } = require("./support/modules")

const reached = []
stubModule("next/cache", { ...require("next/cache"), revalidatePath: () => reached.push("revalidate") })
stubModule("@/lib/services/import-mapping", {
  suggestImportColumnMapping: async () => {
    reached.push("ai provider")
    return { mappings: [] }
  },
})

const onboarding = freshRequire("lib/services/onboarding.ts")
const sample = freshRequire("lib/services/demo-community-seed.ts")
const actions = freshRequire("app/(app)/admin/customers/[orgId]/onboarding/actions.ts")

const RUN = id(1)
const COMMUNITY = id(2)
const FORGED_ACTOR = id(3)

const READ = ["platform.support.read"]
const WRITE = ["platform.support.read", "platform.support.write"]

function operator(platform) {
  reached.length = 0
  return platformActor({ platform, tables: { orgs: [{ id: ORG, name: "Builder", product_tier: "production" }] } })
}

test("a read-only operator cannot change an onboarding run", async () => {
  for (const [name, call] of [
    ["createOnboardingRun", () => onboarding.createOnboardingRun({ orgId: ORG })],
    ["updateOnboardingRun", () => onboarding.updateOnboardingRun({ runId: RUN, notes: "Changed" })],
    ["completeOnboardingStage", () => onboarding.completeOnboardingStage({ runId: RUN, stageKey: "org_shell" })],
    ["skipOnboardingStage", () => onboarding.skipOnboardingStage({ runId: RUN, stageKey: "accounting", reason: "Documented skip" })],
    ["markRunLive", () => onboarding.markRunLive(RUN)],
  ]) {
    const reader = operator(READ)
    await assert.rejects(reader.run(call), /platform\.support\.write/, name)
    assert.deepEqual(dataQueries(reader), [], name)
  }
})

test("a read-only operator can open the customer's run", async () => {
  const reader = operator(READ)
  assert.equal((await reader.run(() => onboarding.getOnboardingRun(ORG))).org.id, ORG)
})

test("tenant grants, a revoked platform role or a failed lookup do not open onboarding", async () => {
  const cases = [
    ["tenant owner", platformActor({ tenant: ["*", "billing.manage"] }), /platform\.support\.read/],
    ["revoked role", operator(READ), /platform\.support\.read/],
    ["lookup failure", operator(READ), /Platform lookup unavailable/],
  ]
  cases[1][1].db.platform_memberships[0].status = "revoked"
  cases[2][1].tamper("platform_memberships", (result) => ({ ...result, data: null, error: { message: "Platform lookup unavailable" } }))
  for (const [name, service, error] of cases) {
    await assert.rejects(service.run(() => onboarding.getOnboardingRun(ORG)), error, name)
    assert.deepEqual(dataQueries(service), [], name)
  }
})

test("a permitted operator opens a run in the customer org under their own name", async () => {
  const writer = operator(WRITE)
  const run = await writer.run(() => onboarding.createOnboardingRun({ orgId: ORG, notes: "Pilot" }))
  assert.equal(run.org_id, ORG)
  assert.equal(run.created_by, ACTOR)
  for (const entry of [...writer.audits, ...writer.events]) {
    assert.equal(entry.actorId, ACTOR)
    assert.equal(entry.orgId, ORG)
  }
})

test("the sample community refuses a read-only operator and a forged operator id", async () => {
  for (const [name, platform, actor, error] of [
    ["read-only", READ, ACTOR, /platform\.support\.write/],
    ["forged", WRITE, FORGED_ACTOR, /Platform actor mismatch/],
  ]) {
    for (const [call, run] of [
      ["seed", () => sample.seedSampleCommunity(ORG, actor)],
      ["delete", () => sample.deleteSampleCommunity(ORG, COMMUNITY, actor)],
    ]) {
      const service = operator(platform)
      await assert.rejects(service.run(run), error, `${name} ${call}`)
      assert.deepEqual(dataQueries(service), [], `${name} ${call}`)
    }
  }
})

test("onboarding actions refuse a read-only operator before any read, sample work or AI call", async () => {
  const resetForm = new FormData()
  resetForm.set("orgId", ORG)
  for (const [name, call] of [
    ["resetSampleCommunityAction", () => actions.resetSampleCommunityAction(resetForm)],
    ["previewImportAction", () => actions.previewImportAction({ orgId: ORG, importer: "cost_codes", csvText: "code,name\n2000,Scope" })],
  ]) {
    const reader = operator(READ)
    const result = await reader.run(call)
    assert.equal(result.success, false, name)
    assert.match(result.error, /platform\.support\.write/, name)
    assert.deepEqual(dataQueries(reader), [], name)
    assert.deepEqual(reached, [], name)
  }
})
