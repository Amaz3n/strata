require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { saveBusinessProfile } = freshRequire("lib/services/business-profile.ts")

const TRADE = { kind: "trade", specialty: "Electrical" }
const SEEN = "2026-10-01T00:00:00+00:00"

function company(permissions = ["org.admin"]) {
  return createServiceHarness({
    permissions,
    tables: { org_settings: [{ org_id: ORG, settings: { preserved: "keep me" }, updated_at: SEEN }] },
  })
}

test("only an org admin can change the company experience", async () => {
  const service = company(["org.member"])
  await assert.rejects(service.run(() => saveBusinessProfile(TRADE)))
  assert.deepEqual(service.writes(), [])
  assert.deepEqual(service.db.org_settings[0].settings, { preserved: "keep me" })
})

test("saving the profile keeps every other setting and is recorded", async () => {
  const service = company()
  await service.run(() => saveBusinessProfile(TRADE))
  const { settings } = service.db.org_settings[0]
  assert.equal(settings.preserved, "keep me")
  assert.equal(settings.business_profile.kind, "trade")
  assert.equal(service.events.length, 1)
  assert.equal(service.audits.length, 1)
  assert.deepEqual(service.audits[0].before, { preserved: "keep me" })
})

test("a concurrent settings change is refused rather than overwritten", async () => {
  const service = company()
  // Someone else saved between this read and the write.
  service.tamper("org_settings", replies.patch({ updated_at: "2026-09-30T00:00:00+00:00" }), { on: "select", times: 1 })
  await assert.rejects(service.run(() => saveBusinessProfile(TRADE)), /changed/)
  assert.deepEqual(service.db.org_settings[0].settings, { preserved: "keep me" })
  assert.deepEqual(service.events, [])
})
