require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  decideAuthorization,
  intersectProjectReadScopes,
  wouldStrandOrgWithoutAdmin,
} = require("../lib/services/authorization-policy")

// Sensible defaults for an org-scoped check by an active member.
function decide(overrides = {}) {
  return decideAuthorization({
    permission: "invoice.read",
    hasProjectScope: false,
    hasResolvedOrg: true,
    permissionSet: [],
    orgPermissionSet: [],
    deniedPermissions: [],
    hasProjectMembership: false,
    hasOrgMembership: true,
    assignedOnly: false,
    ...overrides,
  })
}

test("grants a permission the role holds", () => {
  const d = decide({ permission: "invoice.read", permissionSet: ["invoice.read", "docs.read"] })
  assert.equal(d.allowed, true)
  assert.equal(d.reasonCode, "allow_permission")
})

test("denies a permission the role lacks", () => {
  const d = decide({ permission: "payment.release", permissionSet: ["invoice.read"] })
  assert.equal(d.allowed, false)
  assert.equal(d.reasonCode, "deny_missing_permission")
})

test("wildcard '*' grants everything", () => {
  const d = decide({ permission: "anything.at.all", permissionSet: ["*"] })
  assert.equal(d.allowed, true)
})

test("explicit deny override beats a grant of the same key", () => {
  const d = decide({
    permission: "budget.write",
    permissionSet: ["budget.write"],
    deniedPermissions: ["budget.write"],
  })
  assert.equal(d.allowed, false)
})

test("deny override is not defeated by a wildcard", () => {
  const d = decide({
    permission: "payment.release",
    permissionSet: ["*", "payment.release"],
    deniedPermissions: ["payment.release"],
  })
  assert.equal(d.allowed, false)
})

test("separation of duties: bookkeeper can write bills but not release payment", () => {
  const bookkeeper = ["bill.read", "bill.write", "invoice.read", "invoice.write", "report.read"]
  assert.equal(decide({ permission: "bill.write", permissionSet: bookkeeper }).allowed, true)
  assert.equal(decide({ permission: "payment.release", permissionSet: bookkeeper }).allowed, false)
  assert.equal(decide({ permission: "bill.approve", permissionSet: bookkeeper }).allowed, false)
})

// --- project scoping ---------------------------------------------------------

test("project-scoped check is blocked for a non-member without all-project access", () => {
  const d = decide({
    permission: "schedule.edit",
    hasProjectScope: true,
    hasProjectMembership: false,
    permissionSet: ["schedule.edit"],
    orgPermissionSet: ["schedule.edit"],
  })
  assert.equal(d.allowed, false)
  assert.equal(d.reasonCode, "deny_no_project_membership")
})

test("project-scoped check passes for an explicit project member", () => {
  const d = decide({
    permission: "schedule.edit",
    hasProjectScope: true,
    hasProjectMembership: true,
    permissionSet: ["schedule.edit"],
    orgPermissionSet: [],
  })
  assert.equal(d.allowed, true)
})

test("org-level project.read grants all-project access when scope is 'all'", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: false,
    assignedOnly: false,
    permissionSet: ["schedule.read", "project.read"],
    orgPermissionSet: ["schedule.read", "project.read"],
  })
  assert.equal(d.allowed, true)
})

test("assigned-only member is blocked from projects they don't belong to, even with project.read", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: false,
    assignedOnly: true,
    permissionSet: ["schedule.read", "project.read", "project.manage"],
    orgPermissionSet: ["schedule.read", "project.read", "project.manage"],
  })
  assert.equal(d.allowed, false)
  assert.equal(d.reasonCode, "deny_no_project_membership")
})

test("assigned-only member reaches projects they DO belong to", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: true,
    assignedOnly: true,
    permissionSet: ["schedule.read", "project.read"],
    orgPermissionSet: ["schedule.read", "project.read"],
  })
  assert.equal(d.allowed, true)
})

test("assigned-only does NOT restrict full admins (org.admin keeps all-project access)", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: false,
    assignedOnly: true,
    permissionSet: ["schedule.read", "org.admin"],
    orgPermissionSet: ["schedule.read", "org.admin"],
  })
  assert.equal(d.allowed, true)
})

test("assigned-only does NOT restrict wildcard/superadmin access", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: false,
    assignedOnly: true,
    permissionSet: ["*"],
    orgPermissionSet: ["*"],
  })
  assert.equal(d.allowed, true)
})

test("non-member of the org gets deny_no_org_membership", () => {
  const d = decide({
    permission: "invoice.read",
    hasOrgMembership: false,
    permissionSet: [],
  })
  assert.equal(d.allowed, false)
  assert.equal(d.reasonCode, "deny_no_org_membership")
})

// --- last-admin guard --------------------------------------------------------

test("last admin cannot be demoted", () => {
  assert.equal(
    wouldStrandOrgWithoutAdmin({ adminMembershipIds: ["m1"], membershipId: "m1", staysAdmin: false }),
    true,
  )
})

test("demoting an admin is fine when another admin remains", () => {
  assert.equal(
    wouldStrandOrgWithoutAdmin({ adminMembershipIds: ["m1", "m2"], membershipId: "m1", staysAdmin: false }),
    false,
  )
})

test("keeping the admin role is always fine", () => {
  assert.equal(
    wouldStrandOrgWithoutAdmin({ adminMembershipIds: ["m1"], membershipId: "m1", staysAdmin: true }),
    false,
  )
})

test("changing a non-admin never strands the org", () => {
  assert.equal(
    wouldStrandOrgWithoutAdmin({ adminMembershipIds: ["m1"], membershipId: "m2", staysAdmin: false }),
    false,
  )
})

test("division-scoped reads never widen membership authorization", () => {
  assert.deepEqual(
    intersectProjectReadScopes(["home-a", "home-b"], ["home-b", "home-c"]),
    ["home-b"],
  )
  assert.deepEqual(intersectProjectReadScopes([], ["home-a"]), [])
  assert.deepEqual(intersectProjectReadScopes(["home-a"], null), ["home-a"])
  assert.deepEqual(intersectProjectReadScopes(null, ["home-b"]), ["home-b"])
  assert.equal(intersectProjectReadScopes(null, null), null)
})

// --- Cron route authorization -------------------------------------------------
// Every /api/jobs/* route is publicly reachable, so this helper is the only thing
// standing between the open internet and the nightly projection, reconciliation,
// and payment jobs.

const { isAuthorizedCronRequest } = require("../lib/services/cron-auth")

function cronRequest(headers = {}) {
  return { headers: new Headers(headers) }
}

function withEnv(env, run) {
  const previous = { NODE_ENV: process.env.NODE_ENV, CRON_SECRET: process.env.CRON_SECRET }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("a production cron route without a configured secret denies everyone", () => {
  withEnv({ NODE_ENV: "production", CRON_SECRET: undefined }, () => {
    // `x-vercel-cron` is attacker-settable on a public route. Trusting it when no
    // secret is configured authenticated nothing at all.
    assert.equal(isAuthorizedCronRequest(cronRequest({ "x-vercel-cron": "1" })), false)
    assert.equal(isAuthorizedCronRequest(cronRequest()), false)
  })
})

test("a configured cron secret is required and sufficient", () => {
  withEnv({ NODE_ENV: "production", CRON_SECRET: "s3cret" }, () => {
    assert.equal(isAuthorizedCronRequest(cronRequest({ authorization: "Bearer s3cret" })), true)
    assert.equal(isAuthorizedCronRequest(cronRequest({ "x-cron-secret": "s3cret" })), true)
    assert.equal(isAuthorizedCronRequest(cronRequest({ authorization: "Bearer wrong" })), false)
    // Holding the header no longer substitutes for holding the secret.
    assert.equal(isAuthorizedCronRequest(cronRequest({ "x-vercel-cron": "1" })), false)
  })
})

test("local development stays open only while no secret is configured", () => {
  withEnv({ NODE_ENV: "development", CRON_SECRET: undefined }, () => {
    assert.equal(isAuthorizedCronRequest(cronRequest()), true)
  })
  withEnv({ NODE_ENV: "development", CRON_SECRET: "s3cret" }, () => {
    assert.equal(isAuthorizedCronRequest(cronRequest()), false)
    assert.equal(isAuthorizedCronRequest(cronRequest({ authorization: "Bearer s3cret" })), true)
  })
})

test("every cron route uses the shared gate rather than its own copy", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const apiDir = path.join(__dirname, "../app/api")
  const jobsDir = path.join(apiDir, "jobs")

  const missing = []
  for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const route = path.join(jobsDir, entry.name, "route.ts")
    if (!fs.existsSync(route)) continue
    if (!fs.readFileSync(route, "utf8").includes("isAuthorizedCronRequest")) missing.push(entry.name)
  }
  assert.deepEqual(missing, [], "cron routes with no authorization gate")

  // Fifteen routes had drifted into nine hand-rolled gates, four of which still
  // trusted the forgeable x-vercel-cron header. Reading CRON_SECRET anywhere but
  // the shared helper is how that happens again.
  const inlined = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === "route.ts" && /process\.env\.CRON_SECRET|x-vercel-cron/.test(fs.readFileSync(full, "utf8"))) {
        inlined.push(path.relative(apiDir, full))
      }
    }
  }
  walk(apiDir)
  assert.deepEqual(inlined, [], "API routes re-implementing the cron gate")
})

// ---------------------------------------------------------------------------
// Vendor payout setup: the person is the unit, the link is a field
// ---------------------------------------------------------------------------

test("a payout-setup link is bound to one contact, never mailed company-wide", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const root = path.resolve(__dirname, "..")
  const invitations = fs.readFileSync(path.join(root, "lib/services/vendor-payment-invitations.ts"), "utf8")

  // One token per contact, each carrying that contact's id. A contact-less row
  // is a bearer credential: whoever the URL reaches can register any email
  // against it and become the vendor's payout administrator.
  assert.match(invitations, /contact_id: input\.contactId/, "minted payout tokens must carry contact_id")
  assert.match(invitations, /\.eq\("contact_id", input\.contactId\)/, "token reuse must match on the contact, not just the company")
  // Each contact gets their own URL. `to: recipients.map(...)` was the shape
  // that mailed one shared bearer link to up to five people.
  assert.match(invitations, /to: \[contact\.email\]/, "each contact must receive their own link")
  assert.doesNotMatch(invitations, /to: recipients\.map/, "a single link must never be mailed to every contact")
})

test("payout setup checks who the link is for and what it is for, not just that it resolves", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const root = path.resolve(__dirname, "..")
  const identities = fs.readFileSync(path.join(root, "lib/services/vendor-payment-identities.ts"), "utf8")

  const gate = identities.slice(
    identities.indexOf("export async function requireVendorPayoutPortalAccess"),
    identities.indexOf("async function resolveOrCreateIdentity"),
  )
  assert.ok(gate.length > 0, "the payout token gate must exist")
  // 1. bound to a person
  assert.match(gate, /!access\.contact_id/, "a contact-less token must not authorize payout setup")
  // 2. that person belongs to the company the token is scoped to
  assert.match(gate, /contact\.primary_company_id !== access\.company_id/)
  // 3. the capability is explicit — an RFI token for a company nobody invited
  //    to payments is not a payout-authorization credential
  assert.match(gate, /vendor_payment_relationships/)
  assert.match(gate, /PAYOUT_INVITED_RELATIONSHIP_STATUSES/)
  // 4. and the signed-in identity still has to hold a live grant on this token
  assert.match(gate, /hasExternalPortalGrantForToken/)
})

test("a missing invitation binding fails closed, it does not skip the check", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const identities = fs.readFileSync(
    path.resolve(__dirname, "../lib/services/vendor-payment-identities.ts"),
    "utf8",
  )
  // Comments quote the defect they fixed, so absence has to be asserted against
  // code only — otherwise the explanation of a hole reads as the hole.
  const code = identities.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  // The fail-open escape: `!input.invitationEmail || …` meant a link with no
  // bound contact skipped the invited-email check entirely, so any address that
  // could reach the token became the vendor's payout administrator.
  assert.doesNotMatch(code, /!input\.invitationEmail \|\|/, "the invitation-email check must not be skippable")
  assert.match(
    identities,
    /input\.invitationEmail\.trim\(\)\.toLowerCase\(\) !== normalizedEmail/,
    "the bound invitation email must be compared, unconditionally",
  )
  // Typed as required, so a caller cannot reintroduce the hole by passing null.
  assert.match(identities, /invitationEmail: string\b/, "invitationEmail must be non-nullable")
})

test("identity matching is exact — `_` in an email is a character, not a wildcard", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const identities = fs.readFileSync(
    path.resolve(__dirname, "../lib/services/vendor-payment-identities.ts"),
    "utf8",
  )

  assert.match(identities, /\.eq\("email", normalizedEmail\)/, "identity lookup must use .eq")
  assert.doesNotMatch(identities, /\.ilike\("email"/, "identity lookup must never use .ilike")

  // Why it matters, demonstrated on the operator itself. PostgREST passes the
  // ilike value through as a LIKE pattern, where `_` matches any single
  // character — so registering `bob_smith@acme.com` matched and ADOPTED the
  // existing identity `bob.smith@acme.com`, inheriting its vendor entities,
  // payout accounts and cross-builder payment history.
  const likeMatches = (pattern, value) => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`^${escaped.replace(/_/g, ".").replace(/%/g, ".*")}$`, "i").test(value)
  }
  assert.equal(likeMatches("bob_smith@acme.com", "bob.smith@acme.com"), true, "the wildcard collision is real")
  assert.equal("bob_smith@acme.com" === "bob.smith@acme.com", false, "equality does not collide")
})

test("a revoked vendor claim or relationship cannot resurrect itself through the claim path", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const identities = fs.readFileSync(
    path.resolve(__dirname, "../lib/services/vendor-payment-identities.ts"),
    "utf8",
  )

  // Same rule `upsertGrant` holds for portal grants: withdrawn access is
  // terminal, and re-following the link is not a way back in.
  assert.match(identities, /existingClaim\?\.status === "rejected" \|\| existingClaim\?\.status === "revoked"/)
  assert.match(identities, /existingRelationship\?\.status === "suspended" \|\| existingRelationship\?\.status === "revoked"/)
  // And a live relationship is not downgraded on the way past: the blanket
  // `status: "onboarding"` clobbered `active` back to onboarding.
  assert.match(identities, /nextRelationshipStatus = existingRelationship\?\.status === "active" \? "active" : "onboarding"/)
  assert.doesNotMatch(identities, /status: "onboarding",\n      accepted_by_identity_id/)
})

test("a Stripe onboarding return path cannot leave the origin", () => {
  const { portalReturnPathSchema, startVendorPayoutSetupSchema } = require("../lib/validation/fintech-payments")

  // `startsWith("/")` accepted every one of these, and `new URL(value, base)`
  // resolves the first two off-origin before handing them to Stripe.
  for (const hostile of ["//evil.com", "//evil.com/path", "/\\evil.com", "https://evil.com", "http://evil.com", "evil.com", ""]) {
    assert.equal(portalReturnPathSchema.safeParse(hostile).success, false, `${JSON.stringify(hostile)} must be rejected`)
  }
  for (const safe of ["/access", "/s/abc/payments", "/access?payments=return", "/"]) {
    assert.equal(portalReturnPathSchema.safeParse(safe).success, true, `${safe} must be accepted`)
  }

  // The whole action input, not just the field in isolation.
  assert.equal(
    startVendorPayoutSetupSchema.safeParse({ portal_token: "t", legal_name: "Acme", return_path: "//evil.com" }).success,
    false,
  )
  // No default. `/access` is a router that redirects to the most recent thing
  // the vendor touched, so defaulting to it stranded anybody coming back from
  // Stripe: the caller has to say where the vendor should land.
  assert.equal(
    startVendorPayoutSetupSchema.safeParse({ portal_token: "t", legal_name: "Acme" }).success,
    false,
  )
  assert.equal(
    startVendorPayoutSetupSchema.safeParse({
      portal_token: "t",
      legal_name: "Acme",
      return_path: "/s/abc/payments",
    }).success,
    true,
  )

  // And the resolution itself: proof that the rejected shape really does leave
  // the origin, so the regex is guarding something real.
  assert.equal(new URL("//evil.com", "https://arcnaples.com").origin, "https://evil.com")
  assert.equal(new URL("/access", "https://arcnaples.com").origin, "https://arcnaples.com")
})
