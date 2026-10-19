require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const COMMUNITY = id(1)
const DIVISION = id(2)
const UNKNOWN_COMMUNITY = id(3)

// The ambient desk scope comes from the request's cookies.
stubModule("@/lib/services/desk-context", {
  getAmbientDeskContext: async () => ({
    communities: [{ id: COMMUNITY, name: "Test community" }],
    communityId: COMMUNITY,
    divisionId: DIVISION,
  }),
})

const { loadProjectDirectory } = freshRequire("lib/services/project-directory.ts")

/** A member with `access`; every directory page request is recorded in `pages`. */
function member(access = {}) {
  const pages = []
  const service = createServiceHarness({
    permissions: ["project.read", "schedule.read"],
    ...access,
    rpc: {
      get_project_directory_page: (args) => {
        pages.push(args)
        return { data: [], error: null }
      },
    },
  })
  return { service, pages, load: (query = {}) => service.run(() => loadProjectDirectory(query)) }
}

test("the directory page is read for the verified actor with their real scope", async () => {
  const everything = member()
  await everything.load()
  assert.equal(everything.pages.length, 1)
  assert.equal(everything.pages[0].p_org_id, ORG)
  assert.equal(everything.pages[0].p_user_id, ACTOR)
  assert.equal(everything.pages[0].p_all_projects, true)
  assert.equal(everything.pages[0].p_division_ids, null)
  assert.equal(everything.pages[0].p_community_id, COMMUNITY)
  assert.equal(everything.pages[0].p_division_id, DIVISION)

  const assigned = member({ projects: [id(10)], divisions: [DIVISION] })
  await assigned.load()
  assert.equal(assigned.pages[0].p_all_projects, false)
  assert.deepEqual(assigned.pages[0].p_division_ids, [DIVISION])

  const noProjectRead = member({ permissions: ["schedule.read"] })
  await noProjectRead.load()
  assert.equal(noProjectRead.pages[0].p_all_projects, false)
})

test("an unresolvable scope never widens to the whole org", async () => {
  const failing = member()
  // The directory's own project-scope read fails; the RBAC lookups in
  // authorization.ts read the same row and are left alone.
  failing.service.tamper("memberships", (result) =>
    new Error().stack.includes("authorization.ts") ? result : replies.error("database unavailable")(result),
  )
  await assert.rejects(failing.load(), /Unable to resolve project scope/)
  assert.deepEqual(failing.pages, [])

  const noDivisions = member({ divisions: [] })
  assert.deepEqual((await noDivisions.load()).page.rows, [])
  assert.deepEqual(noDivisions.pages, [])
})

test("All communities overrides the ambient default; an unknown community matches nothing", async () => {
  const directory = member()
  await directory.load({ community: "all" })
  assert.equal(directory.pages[0].p_community_id, null)

  assert.deepEqual((await directory.load({ community: UNKNOWN_COMMUNITY })).page.rows, [])
  assert.equal(directory.pages.length, 1)
})

test("an invalid sort or cursor never reaches the database", async () => {
  const directory = member()
  await assert.rejects(directory.load({ sort: "arbitrary SQL" }))
  await assert.rejects(directory.load({ cursor: "invalid" }))
  assert.deepEqual(directory.pages, [])
})
