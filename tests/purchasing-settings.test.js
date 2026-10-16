const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  getPurchasingSettings,
  resolvePayOnPo,
  setVarianceReasonCodeActive,
  updatePurchasingSettings,
  upsertVarianceReasonCode,
} = freshRequire("lib/services/purchasing-settings.ts")

const BACKCHARGE = id(1)
const OVERAGE = id(2)
const PROJECT = id(3)
const COMMUNITY = id(4)

const bands = [{ up_to_cents: 250_000, permission: "vpo.approve" }, { up_to_cents: null, permission: "vpo.approve_large" }]

function harness({ permissions = ["price_book.read", "purchasing_settings.write", "vpo.request"], settings = [] } = {}) {
  return createServiceHarness({
    permissions,
    tables: {
      purchasing_settings: settings,
      variance_reason_codes: [
        { id: BACKCHARGE, org_id: ORG, code: "back_charge", label: "Back-charge", is_backcharge: true, is_active: true, sort_order: 0 },
        { id: OVERAGE, org_id: ORG, code: "overage", label: "Overage", is_backcharge: false, is_active: true, sort_order: 1 },
      ],
      commitment_change_orders: [{ id: id(20), org_id: ORG, reason_code_id: OVERAGE }],
      lots: [],
      communities: [],
    },
  })
}

describe("who may change purchasing settings", () => {
  test("only the settings permission writes, and the change is audited as critical", async () => {
    const reader = harness({ permissions: ["price_book.read", "vpo.request"] })
    await assert.rejects(reader.run(() => updatePurchasingSettings({ pay_on_po_enabled: true })))
    assert.deepEqual(reader.writes("purchasing_settings"), [])

    const manager = harness()
    const saved = await manager.run(() => updatePurchasingSettings({ pay_on_po_enabled: true, vpo_approval_thresholds: bands }))
    assert.equal(saved.pay_on_po_enabled, true)
    assert.deepEqual(manager.db.purchasing_settings[0].vpo_approval_thresholds, bands)
    assert.equal(manager.audits.at(-1).critical, true)
    assert.equal(manager.events.at(-1).eventType, "purchasing_settings.updated")
  })

  test("a band naming an arbitrary permission is refused before anything is written", async () => {
    const manager = harness()
    await assert.rejects(manager.run(() => updatePurchasingSettings({ vpo_approval_thresholds: [{ up_to_cents: null, permission: "commitment.read" }] })))
    assert.deepEqual(manager.writes("purchasing_settings"), [])
  })

  test("reading never creates the settings row; an org that never saved runs on the defaults", async () => {
    const manager = harness()
    const settings = await manager.run(() => getPurchasingSettings())
    assert.equal(settings.pay_on_po_enabled, false)
    assert.equal(settings.po_completion_requires_inspection, false)
    assert.equal(settings.vpo_evidence_required_over_cents, 100_000)
    assert.deepEqual(manager.writes("purchasing_settings"), [])
  })

  test("evidence can be switched off entirely, and later changes keep what was not touched", async () => {
    const manager = harness()
    await manager.run(() => updatePurchasingSettings({ vpo_evidence_required_over_cents: null }))
    const second = await manager.run(() => updatePurchasingSettings({ po_completion_requires_inspection: true }))
    assert.equal(second.vpo_evidence_required_over_cents, null)
    assert.equal(second.po_completion_requires_inspection, true)
  })
})

describe("variance reasons", () => {
  test("a duplicate code is refused and a new reason is appended", async () => {
    const manager = harness()
    await assert.rejects(manager.run(() => upsertVarianceReasonCode({ code: "overage", label: "Again" })), /already exists/)
    const added = await manager.run(() => upsertVarianceReasonCode({ code: "storm_damage", label: "Storm damage" }))
    assert.equal(added.sort_order, 2)
    assert.equal(added.code, "storm_damage")
  })

  test("the back-charge flag cannot move under orders that already use the reason", async () => {
    const manager = harness()
    await assert.rejects(
      manager.run(() => upsertVarianceReasonCode({ id: OVERAGE, code: "overage", label: "Overage", is_backcharge: true })),
      /already use this reason/,
    )
    const relabelled = await manager.run(() => upsertVarianceReasonCode({ id: BACKCHARGE, code: "back_charge", label: "Trade back-charge", is_backcharge: true }))
    assert.equal(relabelled.label, "Trade back-charge")
  })

  test("a reason is retired, not deleted", async () => {
    const manager = harness()
    await manager.run(() => setVarianceReasonCodeActive(OVERAGE, false))
    assert.equal(manager.db.variance_reason_codes.find((row) => row.id === OVERAGE).is_active, false)
    assert.equal(manager.db.variance_reason_codes.length, 2)
  })
})

describe("pay-on-PO resolution", () => {
  const resolve = (tables) => {
    const service = createServiceHarness({ permissions: ["price_book.read"], tables })
    return service.run(() => resolvePayOnPo(service.client, ORG, PROJECT))
  }

  test("the community's own flag beats the org default, in both directions", async () => {
    const lot = (flag) => [{ org_id: ORG, project_id: PROJECT, community: { pay_on_po_enabled: flag } }]
    assert.equal((await resolve({ lots: lot(false), purchasing_settings: [{ org_id: ORG, pay_on_po_enabled: true }] })).enabled, false)
    assert.equal((await resolve({ lots: lot(true), purchasing_settings: [{ org_id: ORG, pay_on_po_enabled: false }] })).enabled, true)
  })

  test("a community with no override follows the org default, and no settings means off", async () => {
    const lots = [{ org_id: ORG, project_id: PROJECT, community: { pay_on_po_enabled: null } }]
    assert.equal((await resolve({ lots, purchasing_settings: [{ org_id: ORG, pay_on_po_enabled: true }] })).enabled, true)
    assert.equal((await resolve({ lots, purchasing_settings: [] })).enabled, false)
  })
})
