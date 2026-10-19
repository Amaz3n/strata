require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { portalReturnPathSchema, startVendorPayoutSetupSchema } = require("@/lib/validation/fintech-payments")

test("a Stripe onboarding return path cannot leave the origin", () => {
  // `new URL(value, base)` resolves the first two off-origin before they would
  // reach Stripe: `new URL("//evil.com", "https://arc.test").origin` is evil.com.
  for (const hostile of ["//evil.com", "//evil.com/path", "/\\evil.com", "https://evil.com", "http://evil.com", "evil.com", ""]) {
    assert.equal(portalReturnPathSchema.safeParse(hostile).success, false, JSON.stringify(hostile))
  }
  for (const safe of ["/access", "/s/abc/payments", "/access?payments=return", "/"]) {
    assert.equal(portalReturnPathSchema.safeParse(safe).success, true, safe)
  }
})

test("starting payout setup requires an on-origin return path, with no default", () => {
  const input = { portal_token: "t", legal_name: "Acme" }
  assert.equal(startVendorPayoutSetupSchema.safeParse({ ...input, return_path: "//evil.com" }).success, false)
  // `/access` is a router, so defaulting to it stranded vendors coming back
  // from Stripe: the caller has to say where the vendor lands.
  assert.equal(startVendorPayoutSetupSchema.safeParse(input).success, false)
  assert.equal(startVendorPayoutSetupSchema.safeParse({ ...input, return_path: "/s/abc/payments" }).success, true)
})
