const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { status } = require("./support/mobile")

// Boundary: Supabase Auth validating the bearer token. "valid-token" is the
// actor's live session; anything else is expired or forged.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://supabase.test"
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "publishable-test-key"
const supabaseJs = require("@supabase/supabase-js")
stubModule("@supabase/supabase-js", {
  ...supabaseJs,
  createClient: () => ({
    auth: {
      async getUser(token) {
        if (token !== "valid-token") return { data: { user: null }, error: { message: "invalid JWT" } }
        return { data: { user: { id: ACTOR, email: "actor@example.test", user_metadata: {} } }, error: null }
      },
    },
  }),
})

const { listMobileOrganizations, requireMobileOrg } = freshRequire("lib/mobile/auth.ts")

const OTHER_ORG = id(1)

function harness({ orgStatus = "active", memberStatus = "active" } = {}) {
  const service = createServiceHarness({
    tables: {
      orgs: [
        { id: ORG, name: "Builder", slug: "builder", status: orgStatus, billing_model: "license", product_tier: "commercial" },
        { id: OTHER_ORG, name: "Someone else", status: "active", billing_model: "license" },
      ],
      subscriptions: [],
      platform_memberships: [],
    },
  })
  service.db.memberships[0].status = memberStatus
  return service
}

const request = (headers) => new Request("https://arc.test/api/mobile/v1/projects", { headers })
const signedIn = (orgId = ORG) => ({ authorization: "Bearer valid-token", "x-arc-organization-id": orgId })

describe("a mobile request's session", () => {
  test("a missing or malformed bearer token is unauthenticated", async () => {
    const service = harness()
    for (const headers of [{}, { authorization: "valid-token" }, { authorization: "Bearer " }]) {
      await assert.rejects(
        service.run(() => requireMobileOrg(request(headers))),
        (error) => error.status === 401 && error.code === "missing_access_token",
        JSON.stringify(headers),
      )
    }
  })

  test("an expired or forged token is unauthenticated", async () => {
    const service = harness()
    await assert.rejects(
      service.run(() => requireMobileOrg(request({ authorization: "Bearer forged", "x-arc-organization-id": ORG }))),
      (error) => error.status === 401 && error.code === "invalid_access_token",
    )
  })

  test("a session must name the organization it is acting in", async () => {
    const service = harness()
    await assert.rejects(service.run(() => requireMobileOrg(request({ authorization: "Bearer valid-token" }))), status(400))
  })
})

describe("organization scope", () => {
  test("an active member gets a context scoped to that org and its product tier", async () => {
    const service = harness()

    const context = await service.run(() => requireMobileOrg(request(signedIn())))

    assert.equal(context.orgId, ORG)
    assert.equal(context.user.id, ACTOR)
    assert.deepEqual(
      { orgId: context.serviceContext.orgId, userId: context.serviceContext.userId, productTier: context.serviceContext.productTier },
      { orgId: ORG, userId: ACTOR, productTier: "commercial" },
    )
  })

  test("another org, or a membership that is no longer active, is forbidden", async () => {
    const cases = [
      { service: () => harness(), orgId: OTHER_ORG },
      { service: () => harness({ memberStatus: "suspended" }), orgId: ORG },
    ]
    for (const { service, orgId } of cases) {
      const harnessed = service()
      await assert.rejects(
        harnessed.run(() => requireMobileOrg(request(signedIn(orgId)))),
        (error) => error.status === 403 && error.code === "organization_forbidden",
      )
    }
  })

  test("a suspended organization is locked", async () => {
    const service = harness({ orgStatus: "suspended" })
    await assert.rejects(service.run(() => requireMobileOrg(request(signedIn()))), status(423))
  })

  test("the organization list holds only the caller's active memberships", async () => {
    const service = harness()
    Object.assign(service.db.memberships[0], { org: { id: ORG, name: "Builder", slug: "builder" }, role: { key: "pm" } })
    service.db.memberships.push({ org_id: OTHER_ORG, user_id: ACTOR, status: "invited", org: { id: OTHER_ORG, name: "Someone else" } })

    const user = { id: ACTOR, email: "actor@example.test" }
    const orgs = await service.run(() =>
      listMobileOrganizations({ token: "valid-token", user, serviceSupabase: service.client, isPlatformAdmin: false }),
    )

    assert.deepEqual(orgs, [{
      id: ORG, name: "Builder", slug: "builder", logo_url: null, role: "pm",
      business_profile: { kind: "builder", specialty: "Electrical" },
      brand: "Arc Residential",
      terms: { project: "Project", projects: "Projects" },
    }])
  })
})
