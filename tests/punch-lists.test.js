const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { bulkAssignPunchCompany, createProjectPunchItem, createPunchItemFromInspection, updateProjectPunchItem } = freshRequire("lib/services/punch-lists.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const DIVISION = id(3)
const OTHER_DIVISION = id(4)
const ITEM = id(10)

const punchItem = (overrides = {}) => ({
  id: ITEM,
  org_id: ORG,
  project_id: PROJECT,
  title: "Touch up paint",
  status: "ready_for_review",
  verification_required: true,
  verified_at: null,
  verified_by: null,
  assigned_company_id: null,
  sub_completed_at: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...overrides,
})

function harness({ permissions = ["project.read", "punch.read", "punch.write"], projects, divisions, items = [punchItem()], links = [] } = {}) {
  return createServiceHarness({
    permissions,
    projects,
    divisions,
    tables: {
      projects: [
        { id: PROJECT, org_id: ORG, division_id: DIVISION },
        { id: OTHER_PROJECT, org_id: ORG, division_id: OTHER_DIVISION },
      ],
      punch_items: items,
      file_links: links,
      companies: [{ id: id(20), org_id: ORG, name: "Paint Co" }],
    },
  })
}

const afterPhoto = { id: id(30), org_id: ORG, project_id: PROJECT, file_id: id(31), entity_type: "punch_item", entity_id: ITEM, link_role: "after" }

describe("who may change a project's punch list", () => {
  test("a member without punch.write, or scoped to another project or division, changes nothing", async () => {
    const refused = [
      harness({ permissions: ["project.read", "punch.read"] }),
      harness({ projects: [OTHER_PROJECT] }),
      harness({ divisions: [OTHER_DIVISION] }),
    ]
    for (const service of refused) {
      await assert.rejects(service.run(() => createProjectPunchItem(PROJECT, { title: "Door sticks" })))
      await assert.rejects(service.run(() => updateProjectPunchItem(PROJECT, ITEM, { title: "Renamed" })))
      await assert.rejects(service.run(() => bulkAssignPunchCompany(PROJECT, [ITEM], id(20))))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("a member assigned to the project creates an open item, with an event and an audit", async () => {
    const service = harness({ projects: [PROJECT], divisions: [DIVISION], items: [] })

    const item = await service.run(() => createProjectPunchItem(PROJECT, { title: "Door sticks", verification_required: true }))

    assert.equal(item.status, "open")
    assert.equal(item.verification_required, true)
    assert.equal(service.db.punch_items[0].created_by, ACTOR)
    assert.equal(service.events[0].eventType, "punch_item_created")
    assert.equal(service.audits[0].action, "insert")
  })

  test("an inspection's corrective item is validated, flagged, and leaves an event and an audit", async () => {
    const service = harness({ permissions: ["project.read", "inspection.write"], items: [] })
    const context = { supabase: service.client, orgId: ORG, userId: ACTOR }

    await assert.rejects(service.run(() => createPunchItemFromInspection(context, PROJECT, { title: "  " }, id(40))))
    assert.deepEqual(service.writes(), [])

    const item = await service.run(() => createPunchItemFromInspection(context, PROJECT, { title: "Rail loose", assigned_company_id: null }, id(40)))

    assert.equal(item.status, "open")
    assert.equal(service.db.punch_items[0].created_from_inspection, true)
    assert.equal(service.db.punch_items[0].verification_required, false)
    assert.equal(service.events[0].payload.from_inspection, id(40))
    assert.equal(service.audits[0].action, "insert")
  })

  test("an assignee from outside the org's directory is refused", async () => {
    const service = harness({ items: [] })
    await assert.rejects(
      service.run(() => createProjectPunchItem(PROJECT, { title: "Door sticks", assigned_company_id: id(99) })),
      /Assigned company not found/,
    )
    assert.deepEqual(service.writes(), [])
  })
})

describe("closing an item that requires verification", () => {
  test("without an after photo it stays open and is not stamped verified", async () => {
    const service = harness()

    await assert.rejects(
      service.run(() => updateProjectPunchItem(PROJECT, ITEM, { status: "closed" })),
      /verification evidence/,
    )
    assert.equal(service.db.punch_items[0].status, "ready_for_review")
    assert.equal(service.db.punch_items[0].verified_at, null)
  })

  test("dropping the requirement in the same save does not skip the evidence", async () => {
    const service = harness()
    await assert.rejects(
      service.run(() => updateProjectPunchItem(PROJECT, ITEM, { status: "closed", verification_required: false })),
      /verification evidence/,
    )
    assert.deepEqual(service.writes(), [])
  })

  test("with an after photo the closer is recorded as the verifier", async () => {
    const service = harness({ links: [afterPhoto] })

    const item = await service.run(() => updateProjectPunchItem(PROJECT, ITEM, { status: "closed" }))

    assert.equal(item.status, "closed")
    assert.equal(item.verified_by, ACTOR)
    assert.ok(item.verified_at)
  })

  test("an item that does not require verification closes without being stamped verified", async () => {
    const service = harness({ items: [punchItem({ verification_required: false })] })

    const item = await service.run(() => updateProjectPunchItem(PROJECT, ITEM, { status: "closed" }))

    assert.equal(item.status, "closed")
    assert.equal(item.verified_at ?? null, null)
  })
})
