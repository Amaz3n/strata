const assert = require("node:assert/strict")
const test = require("node:test")

const { PORTAL_COMPANY, markPinEntered, portalLink, usePortalDatabase } = require("./support/portal")
const { validatePortalToken, assertPortalActionAccess } = require("../lib/services/portal-access.ts")

const PAST = "2020-01-01T00:00:00Z"
const FUTURE = "2999-01-01T00:00:00Z"

test("a usable link resolves to its access record", async () => {
  const link = portalLink({ expires_at: FUTURE, max_access_count: 5, access_count: 4 })
  usePortalDatabase({ portal_access_tokens: [link.row] })

  const access = await validatePortalToken(link.token)

  assert.equal(access.id, link.row.id)
  assert.equal(access.token, link.token)
  assert.equal(access.portal_type, "client")
})

test("unknown, revoked, expired, paused and used-up links open nothing", async () => {
  const cases = {
    revoked: portalLink({ revoked_at: PAST }),
    expired: portalLink({ expires_at: PAST }),
    paused: portalLink({ paused_at: PAST }),
    exhausted: portalLink({ max_access_count: 3, access_count: 3 }),
  }
  usePortalDatabase({ portal_access_tokens: Object.values(cases).map((link) => link.row) })

  assert.equal(await validatePortalToken("never-issued"), null)
  for (const [reason, link] of Object.entries(cases)) {
    assert.equal(await validatePortalToken(link.token), null, reason)
  }
})

test("an action is refused for an unusable link", async () => {
  const link = portalLink({ revoked_at: PAST })
  usePortalDatabase({ portal_access_tokens: [link.row] })

  await assert.rejects(assertPortalActionAccess(link.token), /Invalid or expired portal access/)
})

test("a link cannot reach a different kind of portal", async () => {
  const buyer = portalLink({ portal_type: "client" })
  usePortalDatabase({ portal_access_tokens: [buyer.row] })

  await assert.rejects(
    assertPortalActionAccess(buyer.token, { portalType: "sub" }),
    /cannot access that resource/,
  )
  await assert.rejects(
    assertPortalActionAccess(buyer.token, { portalType: ["sub", "reviewer"] }),
    /cannot access that resource/,
  )
  const access = await assertPortalActionAccess(buyer.token, { portalType: ["client", "reviewer"] })
  assert.equal(access.id, buyer.row.id)
})

test("a vendor surface refuses a link with no company behind it", async () => {
  const link = portalLink({ portal_type: "sub", company_id: null })
  usePortalDatabase({ portal_access_tokens: [link.row] })

  await assert.rejects(
    assertPortalActionAccess(link.token, { portalType: "sub", requireCompany: true }),
    /missing subcontractor access/,
  )
})

test("a project surface refuses a link that addresses no project", async () => {
  const vendorAccount = portalLink({ portal_type: "sub", company_id: PORTAL_COMPANY, project_id: null })
  usePortalDatabase({ portal_access_tokens: [vendorAccount.row] })

  await assert.rejects(
    assertPortalActionAccess(vendorAccount.token, { portalType: "sub", requireProject: true }),
    /not scoped to a project/,
  )
  const account = await assertPortalActionAccess(vendorAccount.token, { portalType: "sub", requireCompany: true })
  assert.equal(account.project_id, null)
})

test("a link without the section's permission is refused", async () => {
  const link = portalLink({ can_approve_change_orders: false, can_view_warranty: false })
  usePortalDatabase({ portal_access_tokens: [link.row] })

  for (const permission of ["can_approve_change_orders", "can_view_warranty", "can_pay_invoices"]) {
    await assert.rejects(
      assertPortalActionAccess(link.token, { portalType: "client", permission }),
      /does not have permission/,
      permission,
    )
  }
})

test("a PIN-protected link is refused until the PIN has been entered", async () => {
  const link = portalLink({ pin_required: true })
  usePortalDatabase({ portal_access_tokens: [link.row] })

  await assert.rejects(assertPortalActionAccess(link.token), /PIN verification is required/)

  await markPinEntered(link.token)
  const access = await assertPortalActionAccess(link.token)
  assert.equal(access.id, link.row.id)
})

test("a PIN entered for one link does not open another", async () => {
  const entered = portalLink({ pin_required: true })
  const other = portalLink({ pin_required: true })
  usePortalDatabase({ portal_access_tokens: [entered.row, other.row] })

  await markPinEntered(entered.token)

  await assert.rejects(assertPortalActionAccess(other.token), /PIN verification is required/)
})

test("an account-only link is refused to someone who is not signed in", async () => {
  const link = portalLink({ require_account: true })
  usePortalDatabase({ portal_access_tokens: [link.row] })

  await assert.rejects(assertPortalActionAccess(link.token), /Account access is required/)
})
