"use strict"

/**
 * Who may set up where a vendor is paid. A payout-setup link is one person's
 * access (lib/services/vendor-payment-invitations.ts), and claiming it
 * (lib/services/vendor-payment-identities.ts) needs that same person, a
 * confirmed address that matches it exactly, and access that has not been
 * withdrawn. Getting any of these wrong is a payout-destination takeover.
 *
 * Replaced boundaries: the external-portal session (cookies) and the invite
 * email. Everything else — token hashing, the gate, identity resolution and
 * the claim — is real, against the fake database.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

process.env.PORTAL_ACCESS_SECRET ??= "vendor-identity-test-secret-with-32-plus-chars"

const { createServiceHarness, id, ORG } = require("./support/service")
const { supportPostgrestFilters } = require("./support/billing")
const { freshRequire, stubModule } = require("./support/modules")

let world
stubModule("@/lib/services/external-portal-auth", {
  getCurrentExternalPortalSession: async () => world.session,
  externalIdentityHasOrgAccess: async () => true,
  hasExternalPortalGrantForToken: async () => world.hasGrant,
})
stubModule("@/lib/services/mailer", {
  sendVendorPaymentInviteEmail: async (message) => {
    if (world.emailFails) throw new Error("email provider unavailable")
    world.emails.push(message)
    return true
  },
})

const { decryptPortalToken, hashPortalToken } = require("@/lib/services/portal-credentials")
const { inviteCompanyToPaymentSetup } = freshRequire("lib/services/vendor-payment-invitations.ts")
const { claimVendorCompany, requireVendorPayoutPortalAccess } = freshRequire("lib/services/vendor-payment-identities.ts")

const COMPANY = id(1)
const ALEX = id(2)
const BLAKE = id(3)
const ACCOUNT = id(4)
const TOKEN_ROW = id(5)
const TOKEN = "payout-link-token"
const FUTURE = "2999-01-01T00:00:00Z"

/** A builder whose vendor has two contacts, each with their own address. */
function setup({
  contactEmail = "alex@acme.test",
  accountEmail = contactEmail,
  verified = true,
  relationship = "invited",
  claim = null,
  token = {},
  linked = true,
  identities = [],
} = {}) {
  const service = supportPostgrestFilters(
    createServiceHarness({
      permissions: ["payment.manage_rail"],
      tables: {
        payment_rail_policies: [{ id: id(90), org_id: ORG }],
        orgs: [{ id: ORG, name: "Builder", slug: "builder" }],
        companies: [{ id: COMPANY, org_id: ORG, name: "Acme Concrete" }],
        contact_company_links: [
          { org_id: ORG, company_id: COMPANY, contact_id: ALEX, is_primary: true, contact: { id: ALEX, email: contactEmail, full_name: "Alex" } },
          { org_id: ORG, company_id: COMPANY, contact_id: BLAKE, is_primary: false, contact: { id: BLAKE, email: "blake@acme.test", full_name: "Blake" } },
        ].filter((row) => linked || row.contact_id !== ALEX),
        portal_access_tokens: [
          {
            id: TOKEN_ROW,
            org_id: ORG,
            company_id: COMPANY,
            contact_id: ALEX,
            portal_type: "sub",
            purpose: "vendor_payout",
            token_hash: hashPortalToken(TOKEN),
            expires_at: FUTURE,
            contact: { id: ALEX, email: contactEmail },
            ...token,
          },
        ],
        vendor_payment_relationships: relationship ? [{ id: id(20), org_id: ORG, company_id: COMPANY, status: relationship }] : [],
        vendor_company_claims: claim ? [{ id: id(21), org_id: ORG, company_id: COMPANY, vendor_entity_id: id(22), status: claim }] : [],
        external_identities: [
          {
            id: ACCOUNT,
            email: accountEmail,
            status: "active",
            email_verified_at: verified ? "2026-09-01T00:00:00Z" : null,
            vendor_identity_id: null,
          },
        ],
        vendor_portal_identities: identities,
        vendor_entities: [],
        vendor_entity_memberships: [],
      },
    }),
  )
  world = {
    service,
    session: { identity: { id: ACCOUNT, email: accountEmail, full_name: "Alex" } },
    hasGrant: true,
    emailFails: false,
    emails: [],
  }
  return service
}

const claim = (service) => service.run(() => claimVendorCompany({ portal_token: TOKEN, legal_name: "Acme Concrete LLC" }))
const claimsGranted = (service) =>
  service.writes().filter((query) => ["vendor_company_claims", "vendor_payment_relationships"].includes(query.table))

// (1) A payout link belongs to one contact
test("each vendor contact is mailed their own link, bound to them", async () => {
  const service = setup({ relationship: null })
  service.db.portal_access_tokens = []

  const result = await service.run(() => inviteCompanyToPaymentSetup({ companyId: COMPANY }))

  assert.equal(result.recipients, 2)
  assert.deepEqual(world.emails.map((email) => email.to), [["alex@acme.test"], ["blake@acme.test"]])
  const tokens = service.db.portal_access_tokens
  assert.deepEqual(tokens.map((row) => row.contact_id).sort(), [ALEX, BLAKE].sort())
  for (const email of world.emails) {
    const sent = email.setupUrl.match(/\/s\/([^/]+)\/payments$/)[1]
    const row = tokens.find((candidate) => candidate.token_hash === hashPortalToken(sent))
    assert.equal(email.to[0], row.contact_id === ALEX ? "alex@acme.test" : "blake@acme.test", "each link opens its own recipient's row")
    assert.equal(decryptPortalToken(row.token_encrypted), sent)
  }
})

test("a link with no named contact, or for someone outside the vendor, cannot set up payouts", async () => {
  const unnamed = setup({ token: { contact_id: null, contact: null } })
  await assert.rejects(unnamed.run(() => requireVendorPayoutPortalAccess(TOKEN)), /not addressed to a named contact/)
  const outsider = setup({ linked: false })
  await assert.rejects(outsider.run(() => requireVendorPayoutPortalAccess(TOKEN)), /does not belong to the vendor company/)
})

// (2) The gate checks who, what and whether
test("the payout gate refuses dead links, uninvited vendors, and sessions without a grant", async () => {
  const refusals = {
    "a revoked link": [{ token: { revoked_at: "2026-01-01T00:00:00Z" } }, /no longer active/],
    "an expired link": [{ token: { expires_at: "2020-01-01T00:00:00Z" } }, /expired/],
    "a vendor never invited to payments": [{ relationship: null }, /not invited/],
    "a session with no grant on this link": [{}, /claim this vendor invitation/, false],
  }
  for (const [name, [options, error, hasGrant = true]] of Object.entries(refusals)) {
    const service = setup(options)
    world.hasGrant = hasGrant
    await assert.rejects(service.run(() => requireVendorPayoutPortalAccess(TOKEN)), error, name)
  }

  const open = setup()
  const access = await open.run(() => requireVendorPayoutPortalAccess(TOKEN))
  assert.deepEqual([access.companyId, access.contactId, access.contactEmail], [COMPANY, ALEX, "alex@acme.test"])
})

test("an unconfirmed address, or one other than the invited contact's, claims nothing", async () => {
  const cases = {
    "an unconfirmed address": [{ verified: false }, /Confirm your email address/],
    "a different person's address": [{ accountEmail: "mallory@evil.test" }, /email address that received this vendor invitation/],
  }
  for (const [name, [options, error]] of Object.entries(cases)) {
    const service = setup(options)
    await assert.rejects(claim(service), error, name)
    assert.deepEqual(claimsGranted(service), [], name)
    assert.deepEqual(service.db.vendor_portal_identities, [], name)
  }
})

// (3) Failing to send the invitation grants nothing
test("an invitation that cannot be emailed fails, and leaves the vendor with no payment access", async () => {
  const service = setup({ relationship: null })
  service.db.portal_access_tokens = []
  world.emailFails = true

  await assert.rejects(service.run(() => inviteCompanyToPaymentSetup({ companyId: COMPANY })), /email provider unavailable/)

  assert.ok(service.db.vendor_payment_relationships.every((row) => row.status === "invited"))
  assert.deepEqual(service.db.vendor_company_claims, [])
  assert.equal(service.audits.length, 0)
})

test("a claimed payout link is only as good as the invited contact's own address", async () => {
  // The address check has no bypass: a link whose contact has no email cannot be claimed at all.
  const service = setup({ token: { contact: { id: ALEX, email: null } } })
  await assert.rejects(claim(service), /not addressed to a named contact/)
  assert.deepEqual(claimsGranted(service), [])
})

// (4) Email identity is matched exactly
test("an address is matched exactly, so a look-alike never inherits another vendor identity", async () => {
  const existing = { id: id(30), email: "bob.smith@acme.test", status: "active", email_verified_at: "2026-01-01T00:00:00Z" }
  const service = setup({ contactEmail: "bob_smith@acme.test", identities: [existing] })

  const result = await claim(service)

  assert.notEqual(result.identityId, existing.id, "`_` is a character, not a wildcard")
  assert.deepEqual(
    service.db.vendor_portal_identities.map((row) => row.email).sort(),
    ["bob.smith@acme.test", "bob_smith@acme.test"],
  )
})

test("the same address in different case is the same person, but a partial address is not", async () => {
  const sameCase = setup({ contactEmail: "alex@acme.test", accountEmail: "Alex@ACME.test" })
  await claim(sameCase)
  assert.deepEqual(sameCase.db.vendor_portal_identities.map((row) => row.email), ["alex@acme.test"])

  const partial = setup({ contactEmail: "alex@acme.test", accountEmail: "lex@acme.test" })
  await assert.rejects(claim(partial), /email address that received this vendor invitation/)
})

// (5) Withdrawn access stays withdrawn
test("a rejected or revoked claim, or a suspended or revoked relationship, cannot be revived by claiming again", async () => {
  const cases = {
    "a rejected claim": { claim: "rejected", relationship: "onboarding" },
    "a revoked claim": { claim: "revoked", relationship: "onboarding" },
    "a suspended relationship": { relationship: "suspended" },
    "a revoked relationship": { relationship: "revoked" },
  }
  for (const [name, options] of Object.entries(cases)) {
    const service = setup(options)
    const before = structuredClone([service.db.vendor_company_claims, service.db.vendor_payment_relationships])
    await assert.rejects(claim(service), undefined, name)
    assert.deepEqual(claimsGranted(service), [], name)
    assert.deepEqual([service.db.vendor_company_claims, service.db.vendor_payment_relationships], before, name)
  }
})

test("claiming never downgrades a live relationship", async () => {
  const service = setup({ relationship: "active" })
  const result = await claim(service)
  assert.equal(result.status, "active")
  assert.equal(service.db.vendor_payment_relationships[0].status, "active")
})
