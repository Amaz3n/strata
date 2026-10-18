const assert = require("node:assert/strict")
const test = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")
const { stubModule, freshRequire } = require("./support/modules")

const USER = "00000000-0000-4000-8000-000000000001"
const MEMBER_ORG = "00000000-0000-4000-8000-000000000002"
const OTHER_ORG = "00000000-0000-4000-8000-000000000003"

/** A render-time request: the org cookie can be read but never written. */
function loadContext({ cookieOrgId }) {
  const supabase = createFakeSupabase({
    memberships: [
      {
        id: "membership",
        org_id: MEMBER_ORG,
        user_id: USER,
        role_id: "role",
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        roles: { key: "project_manager" },
        orgs: { product_tier: "production" },
      },
    ],
    platform_memberships: [],
  })
  supabase.auth = { getUser: async () => ({ data: { user: { id: USER } } }) }
  const cookieWrites = []
  stubModule("next/headers", {
    cookies: async () => ({
      get: (name) => (name === "org_id" && cookieOrgId ? { value: cookieOrgId } : undefined),
      set: (name) => {
        cookieWrites.push(name)
        throw new Error("Cookies can only be modified in a Server Action or Route Handler")
      },
    }),
  })
  // Request-scoped Next APIs; the cache directive itself is inert outside Next.
  stubModule("next/cache", { cacheLife() {} })
  stubModule("next/server", { after() {}, connection: async () => {} })
  stubModule("@/lib/supabase/server", {
    createServerSupabaseClient: async () => supabase,
    createServiceSupabaseClient: () => supabase,
  })
  return { context: freshRequire("lib/auth/context.ts"), cookieWrites }
}

test("a member resolves their organization during a render without writing cookies", async () => {
  const { context, cookieWrites } = loadContext({ cookieOrgId: MEMBER_ORG })
  const resolved = await context.requireOrgMembership()
  assert.equal(resolved.orgId, MEMBER_ORG)
  assert.equal(resolved.membership.org_product_tier, "production")
  assert.deepEqual(cookieWrites, [])
})

test("a stale org cookie falls back to the user's active organization", async () => {
  const { context } = loadContext({ cookieOrgId: OTHER_ORG })
  assert.equal((await context.requireOrgMembership()).orgId, MEMBER_ORG)
})

test("an explicit organization without membership is refused, never substituted", async () => {
  const { context } = loadContext({ cookieOrgId: MEMBER_ORG })
  await assert.rejects(context.requireOrgMembership(OTHER_ORG), /no longer have access/)
})
