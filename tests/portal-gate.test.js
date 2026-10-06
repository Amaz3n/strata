const assert = require("node:assert/strict")
const test = require("node:test")

const { PORTAL_COMPANY, markPinEntered, portalLink, usePortalDatabase } = require("./support/portal")
const { stubModule, freshRequire } = require("./support/modules")

// The gate's screens are presentation; what matters is which one it chooses.
function PortalAccountGate() {}
function PortalInvitationExpired() {}
function PortalPinGate() {}
stubModule("@/components/portal/account/portal-account-gate", { PortalAccountGate })
stubModule("@/components/portal/portal-invitation-expired", { PortalInvitationExpired })
stubModule("@/components/portal/portal-pin-gate", { PortalPinGate })

const { resolvePortalGate } = freshRequire("lib/portal/gate.tsx")

const PAST = "2020-01-01T00:00:00Z"

function gate(token, options = {}) {
  return resolvePortalGate({ token, portalType: "client", fallbackLabel: "Fixture home", ...options })
}

test("a usable link passes the gate with its access record", async () => {
  const link = portalLink()
  usePortalDatabase({ portal_access_tokens: [link.row] })

  const result = await gate(link.token, { requireProject: true })

  assert.equal(result.status, "ok")
  assert.equal(result.access.id, link.row.id)
})

test("an unknown or expired project link is indistinguishable from one that never existed", async () => {
  const expired = portalLink({ expires_at: PAST })
  const revoked = portalLink({ revoked_at: PAST })
  usePortalDatabase({ portal_access_tokens: [expired.row, revoked.row] })

  for (const token of ["never-issued", expired.token, revoked.token]) {
    assert.deepEqual(await gate(token), { status: "invalid" })
  }
})

test("an expired payout invitation explains itself instead of reading as missing", async () => {
  const invitation = portalLink({
    portal_type: "sub",
    purpose: "vendor_payout",
    project_id: null,
    company_id: PORTAL_COMPANY,
    expires_at: PAST,
  })
  usePortalDatabase({ portal_access_tokens: [invitation.row] })

  const result = await gate(invitation.token, { portalType: "sub", requireCompany: true })

  assert.equal(result.status, "blocked")
  assert.equal(result.element.type, PortalInvitationExpired)
  assert.equal(result.element.props.reason, "expired")
})

test("a link that addresses no project cannot open a project portal", async () => {
  const vendorAccount = portalLink({ portal_type: "sub", project_id: null, company_id: PORTAL_COMPANY })
  usePortalDatabase({ portal_access_tokens: [vendorAccount.row] })

  assert.deepEqual(
    await gate(vendorAccount.token, { portalType: "sub", requireProject: true }),
    { status: "invalid" },
  )
  assert.equal((await gate(vendorAccount.token, { portalType: "sub", requireCompany: true })).status, "ok")
})

test("a link for another kind of portal is reported as the wrong portal", async () => {
  const subcontractor = portalLink({ portal_type: "sub", company_id: PORTAL_COMPANY })
  const companyless = portalLink({ portal_type: "sub", company_id: null })
  usePortalDatabase({ portal_access_tokens: [subcontractor.row, companyless.row] })

  assert.equal((await gate(subcontractor.token, { portalType: "client" })).status, "wrong-portal")
  assert.equal((await gate(companyless.token, { portalType: "sub", requireCompany: true })).status, "wrong-portal")
})

test("a PIN-protected link shows the PIN screen until the PIN has been entered", async () => {
  const link = portalLink({ pin_required: true })
  usePortalDatabase({ portal_access_tokens: [link.row] })

  const blocked = await gate(link.token)
  assert.equal(blocked.status, "blocked")
  assert.equal(blocked.element.type, PortalPinGate)

  await markPinEntered(link.token)
  assert.equal((await gate(link.token)).status, "ok")
})

test("an account-only link sends someone who is not signed in to the account screen", async () => {
  const link = portalLink({ require_account: true, pin_required: true })
  usePortalDatabase({ portal_access_tokens: [link.row] })
  await markPinEntered(link.token)

  const result = await gate(link.token)

  assert.equal(result.status, "blocked")
  assert.equal(result.element.type, PortalAccountGate)
})

test("passing the gate does not spend one of the link's limited uses", async () => {
  const link = portalLink({ max_access_count: 2, access_count: 1 })
  const database = usePortalDatabase({ portal_access_tokens: [link.row] })

  await gate(link.token)
  await gate(link.token)

  assert.equal(database.store.portal_access_tokens[0].access_count, 1)
})
