"use strict"

/**
 * The org-wide cost-coding default (`lib/services/cost-coding-settings.ts`), the
 * settings action that saves it, and how a project resolves its own flag
 * against it (`lib/financials/cost-codes-enabled.ts`).
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { stubModule, freshRequire } = require("./support/modules")

// This service resolves its caller through `requireOrgMembership()` (the
// request scope) rather than `requireOrgContext()`; answer it with the
// harness's actor and client.
let current = null
stubModule("@/lib/auth/context", {
  requireOrgMembership: async () => ({
    orgId: current.orgId,
    user: { id: current.userId },
    supabase: current.client,
    membership: { org_product_tier: "residential" },
  }),
  hasActivePlatformMembership: async () => false,
})
const revalidated = []
stubModule("next/cache", { revalidatePath: (path) => revalidated.push(path) })

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")

const { getCostCodingSettings, updateCostCodesEnabled } = freshRequire("lib/services/cost-coding-settings.ts")
const { updateCostCodesEnabledAction } = freshRequire("app/(app)/settings/cost-coding/actions.ts")
const { getProjectCostCodesEnabled } = freshRequire("lib/financials/cost-codes-enabled.ts")

const PROJECT = id(1)
const OTHER_SETTINGS = { fiscal_calendar: "original", billing: { approval: "dual" } }

/** An org whose settings already hold other keys; `reply` overrides what the merge RPC answers. */
function org({ permissions = ["org.admin"], reply, rpcError } = {}) {
  const service = createServiceHarness({
    tables: {
      org_settings: [{ org_id: ORG, settings: { cost_codes_enabled: true, ...OTHER_SETTINGS } }],
      project_financial_settings: [],
    },
    permissions,
    rpc: {
      merge_org_settings: ({ p_org_id, p_patch, p_delete_keys }, store) => {
        const row = store.org_settings.find((entry) => entry.org_id === p_org_id)
        row.settings = { ...row.settings, ...p_patch }
        for (const key of p_delete_keys) delete row.settings[key]
        return { data: reply === undefined ? structuredClone(row.settings) : reply, error: rpcError ?? null }
      },
    },
  })
  current = service
  return service
}

const storedSettings = (service) => service.db.org_settings[0].settings

test("an admin turns the default off and on without touching other settings", async () => {
  for (const enabled of [false, true]) {
    const service = org()
    assert.deepEqual(await service.run(() => updateCostCodesEnabled(enabled)), { costCodesEnabled: enabled })
    assert.deepEqual(storedSettings(service), { cost_codes_enabled: enabled, ...OTHER_SETTINGS })
    const [audit] = service.audits
    assert.equal(audit.actorId, ACTOR)
    assert.equal(audit.orgId, ORG)
    assert.deepEqual(audit.after, { cost_codes_enabled: enabled })
  }
})

test("a non-boolean value or a non-admin caller is refused before anything is written", async () => {
  for (const input of ["false", "true", 0, 1, null, undefined, {}, []]) {
    const service = org()
    await assert.rejects(service.run(() => updateCostCodesEnabled(input)), JSON.stringify(input))
    assert.deepEqual(service.writes(), [], JSON.stringify(input))
  }

  const member = org({ permissions: [] })
  await assert.rejects(member.run(() => updateCostCodesEnabled(false)), /Missing permission/)
  assert.deepEqual(member.writes(), [])
  assert.equal(storedSettings(member).cost_codes_enabled, true)
  assert.deepEqual(member.audits, [])
})

test("a save the database cannot confirm is never reported or audited as done", async () => {
  const cases = [
    { reply: null },
    { reply: {} },
    { reply: [] },
    { reply: { cost_codes_enabled: "false" } },
    { reply: { cost_codes_enabled: true } },
    { rpcError: { message: "unavailable" } },
  ]
  for (const options of cases) {
    const service = org(options)
    await assert.rejects(service.run(() => updateCostCodesEnabled(false)), /Reload settings|unavailable/)
    assert.deepEqual(service.audits, [], JSON.stringify(options))
    assert.deepEqual(service.events, [], JSON.stringify(options))
  }
})

test("any member reads the default, and is told whether they may change it", async () => {
  assert.deepEqual(await org({ permissions: [] }).run(() => getCostCodingSettings()), {
    costCodesEnabled: true,
    canManage: false,
  })
  assert.deepEqual(await org().run(() => getCostCodingSettings()), { costCodesEnabled: true, canManage: true })
})

test("the settings action reports a refused save as a failure and revalidates only on success", async () => {
  revalidated.length = 0
  const member = org({ permissions: [] })
  const refused = await member.run(() => updateCostCodesEnabledAction(false))
  assert.equal(refused.success, false)
  assert.match(refused.error, /Missing permission/)
  assert.deepEqual(revalidated, [])

  const admin = org()
  assert.deepEqual(await admin.run(() => updateCostCodesEnabledAction(false)), {
    success: true,
    data: { costCodesEnabled: false },
  })
  assert.deepEqual(revalidated, ["/settings/cost-coding"])
})

test("a project follows its override, inherits the org default without one, and surfaces a failed read", async () => {
  const service = org()
  storedSettings(service).cost_codes_enabled = false
  assert.equal(await getProjectCostCodesEnabled(service.client, ORG, PROJECT), false)

  service.db.project_financial_settings.push({ org_id: ORG, project_id: PROJECT, cost_codes_enabled: true })
  assert.equal(await getProjectCostCodesEnabled(service.client, ORG, PROJECT), true)

  service.tamper("project_financial_settings", replies.error("policy unavailable"))
  await assert.rejects(getProjectCostCodesEnabled(service.client, ORG, PROJECT), /policy unavailable/)
})
