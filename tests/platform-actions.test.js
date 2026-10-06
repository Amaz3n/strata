const assert = require("node:assert/strict")
const test = require("node:test")
const { isRedirectError } = require("next/dist/client/components/redirect-error")

const { stubModule, freshRequire } = require("./support/modules")

const ORG = "00000000-0000-4000-8000-000000000001"

function loadActions({ permitted = true } = {}) {
  const selected = []
  // revalidatePath needs a request's static generation store; redirect is real.
  stubModule("next/cache", { revalidatePath() {} })
  stubModule("@/lib/auth/context", { requireAuth: async () => ({ user: { id: "user" } }) })
  stubModule("@/lib/services/platform-access", {
    requireAnyPlatformPermission: async () => {
      if (!permitted) throw new Error("Platform access required")
    },
  })
  stubModule("@/lib/services/platform-session", {
    setPlatformOrgContext: async (orgId, reason) => selected.push({ orgId, reason }),
  })
  return { actions: freshRequire("app/(app)/platform/actions.ts"), selected }
}

function switchForm(orgId = ORG) {
  const form = new FormData()
  form.set("orgId", orgId)
  form.set("reason", "support ticket")
  return form
}

test("switching organization redirects home instead of returning an action result", async () => {
  const { actions, selected } = loadActions()
  await assert.rejects(actions.enterOrgContextAction(switchForm()), (error) => {
    assert.ok(isRedirectError(error))
    assert.match(error.digest, /;\/;/)
    return true
  })
  assert.deepEqual(selected, [{ orgId: ORG, reason: "support ticket" }])
})

test("switching organization without platform access returns an error and selects nothing", async () => {
  const { actions, selected } = loadActions({ permitted: false })
  const result = await actions.enterOrgContextAction(switchForm())
  assert.deepEqual(result, { success: false, error: "Platform access required" })
  assert.deepEqual(selected, [])
})

test("switching to a malformed organization id is refused before any lookup", async () => {
  const { actions, selected } = loadActions()
  const result = await actions.enterOrgContextAction(switchForm("not-an-org"))
  assert.deepEqual(result, { success: false, error: "Invalid organization id" })
  assert.deepEqual(selected, [])
})
