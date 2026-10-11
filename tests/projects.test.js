"use strict"

/**
 * `lib/services/projects.ts` — creating a project and the billing contract it
 * opens with.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { createProject, listProjectSummaries, searchVisibleProjects, prepareProjectOpeningContract } = freshRequire("lib/services/projects.ts")

describe("createProject", () => {
  const harness = () =>
    createServiceHarness({
      permissions: ["project.manage"],
      tables: { projects: [], contracts: [], project_financial_settings: [], accounting_entity_map: [], orgs: [] },
    })
  const create = (service, input) => service.run(() => createProject({ input: { name: "Lot 12", status: "planning", ...input } }))

  test("a production home opens without a contract, so its purchase agreement is its only revenue contract", async () => {
    const service = harness()
    await create(service, { property_type: "production" })
    assert.equal(service.db.contracts.length, 0)
    assert.equal(service.db.project_financial_settings.length, 1)
  })

  test("a production home given billing terms opens the contract those terms describe", async () => {
    const service = harness()
    await create(service, { property_type: "production", billing_model: "cost_plus_percent", markup_percent: 12 })
    assert.equal(service.db.contracts.length, 1)
    assert.equal(service.db.contracts[0].contract_type, "cost_plus")
  })

  test("a custom home and a commercial job each open with their project contract", async () => {
    for (const property_type of ["residential", "commercial"]) {
      const service = harness()
      await create(service, { property_type })
      assert.equal(service.db.contracts.length, 1, property_type)
      assert.equal(service.db.contracts[0].status, "active", property_type)
    }
  })
})

describe("createProject under a restricted membership", () => {
  const NORTH = id(701)
  const SOUTH = id(702)
  const OTHER = id(703)
  const PM_ROLE = id(710)
  const scoped = (access) =>
    createServiceHarness({
      permissions: ["project.manage"],
      ...access,
      tables: {
        projects: [], contracts: [], project_financial_settings: [], accounting_entity_map: [], orgs: [],
        divisions: [NORTH, SOUTH].map((divisionId) => ({ id: divisionId, org_id: ORG })),
        roles: [{ id: PM_ROLE, key: "pm", scope: "project" }],
        project_members: [],
      },
    })
  const create = (service, input = {}) =>
    service.run(() => createProject({ input: { name: "Lot 12", status: "planning", property_type: "production", ...input } }))

  test("a member held to one division files the project there without choosing", async () => {
    const service = scoped({ divisions: [NORTH] })
    const project = await create(service)
    assert.equal(project.division_id, NORTH)
    assert.equal(service.db.projects[0].division_id, NORTH)
  })

  test("a member held to several divisions must choose one of theirs", async () => {
    const service = scoped({ divisions: [NORTH, SOUTH] })
    await assert.rejects(create(service), /choose a division.*2 divisions/i)
    await assert.rejects(create(service, { division_id: OTHER }), /only create projects in the divisions you are assigned to/i)
    assert.equal(service.db.projects.length, 0)
    assert.equal((await create(service, { division_id: SOUTH })).division_id, SOUTH)
  })

  test("a member assigned to no division cannot create a project", async () => {
    const service = scoped({ divisions: [] })
    await assert.rejects(create(service), /not assigned to any division/i)
    assert.equal(service.db.projects.length, 0)
  })

  test("an org-wide member may file under any division of the org, but not one that is not the org's", async () => {
    const service = scoped({})
    assert.equal((await create(service, { division_id: SOUTH })).division_id, SOUTH)
    await assert.rejects(create(service, { division_id: OTHER }), /division not found/i)
    assert.equal((await create(service)).division_id, null)
  })

  test("a member who only reaches assigned projects is made a member of the one they create", async () => {
    const service = scoped({ projects: [id(799)] })
    const project = await create(service)
    const member = service.db.project_members.find((row) => row.project_id === project.id)
    assert.deepEqual([member.user_id, member.role_id, member.status], [service.userId, PM_ROLE, "active"])
  })

  test("an org-wide member gets no project_members row", async () => {
    const service = scoped({})
    await create(service)
    assert.equal(service.db.project_members.length, 0)
  })
})

describe("prepareProjectOpeningContract", () => {
  const open = (productTier, callerInput) =>
    prepareProjectOpeningContract({ callerInput, input: { name: "Lot 9", ...callerInput }, productTier, orgId: "org", projectId: "project", projectName: "Lot 9" })

  test("a production home opens no contract in any org tier, so a sale's purchase agreement is its revenue contract", () => {
    for (const tier of ["residential", "commercial", "production"]) {
      assert.equal(open(tier, { property_type: "production" }), null, tier)
    }
  })

  test("a production home given billing terms, a custom home and a commercial job each open their contract", () => {
    assert.equal(open("production", { property_type: "production", billing_model: "cost_plus_percent" }).contract_type, "cost_plus")
    assert.equal(open("production", { property_type: "residential" }).project_id, "project")
    assert.equal(open("residential", { property_type: "commercial" }).project_id, "project")
  })
})

describe("listProjectSummaries", () => {
  const projects = (count) =>
    Array.from({ length: count }, (_, index) => ({
      id: id(1000 + index),
      org_id: ORG,
      name: `Lot ${index}`,
      status: "active",
      phase: "delivery",
      property_type: "production",
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }))
  const harness = (count) =>
    createServiceHarness({ permissions: ["project.read"], tables: { projects: projects(count) }, maxRows: 1000 })

  test("reads past PostgREST's row cap instead of stopping silently at it", async () => {
    const page = await harness(1500).run(() => listProjectSummaries())
    assert.equal(page.projects.length, 1500)
    assert.equal(page.truncated, false)
  })

  test("a caller-resolved scope is read in id chunks and never widens past what the caller may see", async () => {
    const service = harness(250)
    const scope = projects(250).map((row) => row.id)
    const page = await service.run(() => listProjectSummaries(undefined, undefined, { projectIds: [...scope, id(9999)] }))
    assert.equal(page.projects.length, 250)
    assert.equal(page.total, 250)
    const empty = await service.run(() => listProjectSummaries(undefined, undefined, { projectIds: [] }))
    assert.deepEqual(empty, { projects: [], total: 0, truncated: false })
  })
})

describe("searchVisibleProjects", () => {
  const rows = [
    { id: id(901), org_id: ORG, name: "Maple House", status: "active", property_type: "residential", location: { address: "12 Oak Lane" } },
    { id: id(902), org_id: ORG, name: "Birch House", status: "active", property_type: "residential", location: { formatted: "7 Elm Court, Austin" } },
    { id: id(903), org_id: ORG, name: "Cedar House", status: "active", property_type: "residential", location: null },
  ]
  const search = (term) => {
    const service = createServiceHarness({ permissions: ["project.read"], tables: { projects: rows, memberships: [], project_members: [] } })
    return service.run(async () => (await searchVisibleProjects({ search: term })).projects.map((project) => project.name))
  }

  test("a project is found by name, street address, or the formatted address it falls back to", async () => {
    assert.deepEqual(await search("maple"), ["Maple House"])
    assert.deepEqual(await search("oak lane"), ["Maple House"])
    assert.deepEqual(await search("elm court"), ["Birch House"])
    assert.deepEqual(await search("nowhere"), [])
  })

  test("quotes in the search cannot rewrite the filter", async () => {
    assert.deepEqual(await search('x"),name.ilike.(*'), [])
  })

  test("a page past the last project is empty, not an error, and the total stays true", async () => {
    const service = createServiceHarness({ strictRanges: true, permissions: ["project.read"], tables: { projects: rows, memberships: [], project_members: [] } })
    const page = await service.run(() => searchVisibleProjects({ page: 2, pageSize: 3 }))
    assert.deepEqual([page.projects, page.total], [[], 3])
  })
})
