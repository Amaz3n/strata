const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { completeInspection, createInspection, createPunchItemFromInspectionItem, mutateInspectionObligation, seedChecklistTemplates, setChecklistTemplateActive } = freshRequire("lib/services/inspections.ts")

const TEMPLATE = id(1)
const FOREIGN_ORG = id(2)

describe("checklist template activation", () => {
  function harness({ templates = [{ id: TEMPLATE, org_id: ORG, is_active: true }], permissions = ["inspection.write"] } = {}) {
    return createServiceHarness({ permissions, tables: { structured_form_templates: templates } })
  }

  test("malformed input is refused before any permission check or query", async () => {
    for (const [templateId, flag] of [
      [TEMPLATE, "false"],
      [TEMPLATE, 0],
      [TEMPLATE, null],
      ["not-a-uuid", true],
    ]) {
      const service = harness()
      await assert.rejects(service.run(() => setChecklistTemplateActive(templateId, flag)))
      assert.deepEqual(service.queries, [], JSON.stringify([templateId, flag]))
    }
  })

  test("a member without inspection.write changes nothing", async () => {
    const service = harness({ permissions: ["inspection.read"] })
    await assert.rejects(
      service.run(() => setChecklistTemplateActive(TEMPLATE, false)),
      /Missing permission: inspection.write/,
    )
    assert.deepEqual(service.writes(), [])
    assert.equal(service.db.structured_form_templates[0].is_active, true)
  })

  test("another organization's template is reported unavailable, not changed", async () => {
    const service = harness({ templates: [{ id: TEMPLATE, org_id: FOREIGN_ORG, is_active: true }] })

    await assert.rejects(service.run(() => setChecklistTemplateActive(TEMPLATE, false)), /unavailable or changed/)

    assert.equal(service.db.structured_form_templates[0].is_active, true)
    assert.deepEqual(service.audits, [])
  })

  test("a confirmed change is saved and audited as the actor did it", async () => {
    for (const flag of [false, true]) {
      const service = harness({ templates: [{ id: TEMPLATE, org_id: ORG, is_active: !flag }] })

      await service.run(() => setChecklistTemplateActive(TEMPLATE, flag))

      assert.equal(service.db.structured_form_templates[0].is_active, flag)
      assert.equal(service.audits.length, 1)
      assert.equal(service.audits[0].actorId, ACTOR)
      assert.equal(service.audits[0].orgId, ORG)
      assert.deepEqual(service.audits[0].after, { is_active: flag })
    }
  })
})

describe("seeding starter checklists", () => {
  function harness(templates = []) {
    return createServiceHarness({ tables: { structured_form_templates: templates, structured_form_items: [] } })
  }

  test("an unverifiable library count seeds nothing", async () => {
    const answers = [{ count: null }, { count: -1 }, { count: 1.5 }, { count: 0, error: { message: "unavailable" } }]
    for (const answer of answers) {
      const service = harness()
      service.tamper("structured_form_templates", (result) => ({ ...result, ...answer }), { on: "select" })

      await assert.rejects(service.run(() => seedChecklistTemplates()), /Unable to verify/, JSON.stringify(answer))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("an org that already has checklists is left alone", async () => {
    const service = harness([{ id: TEMPLATE, org_id: ORG, is_active: false }])
    assert.equal(await service.run(() => seedChecklistTemplates()), 0)
    assert.deepEqual(service.writes(), [])
  })

  test("an empty library gets the starter templates, each with its own items", async () => {
    // Another org's library does not count toward this one.
    const service = harness([{ id: TEMPLATE, org_id: FOREIGN_ORG, is_active: true }])

    const seeded = await service.run(() => seedChecklistTemplates())

    const templates = service.db.structured_form_templates.filter((row) => row.org_id === ORG)
    const items = service.db.structured_form_items
    assert.ok(seeded > 0)
    assert.equal(templates.length, seeded)
    assert.ok(items.length > seeded)
    for (const template of templates) {
      assert.ok(items.some((item) => item.template_id === template.id), template.name)
    }
    assert.ok(items.every((item) => item.org_id === ORG && templates.some((t) => t.id === item.template_id)))
  })
})

describe("corrective work from a failed inspection", () => {
  const PROJECT = id(10)
  const INSPECTION = id(11)
  const FAILED = id(12)
  const PASSED = id(13)
  const PHOTO = id(14)
  const COMPANY = id(15)
  const OTHER_COMPANY = id(16)

  function harness({ companyId = COMPANY, items } = {}) {
    const service = createServiceHarness({
      permissions: ["project.read", "inspection.write", "punch.read"],
      // Completion is the atomic attempt receipt in SQL; here it records the
      // result the checklist proves, as the database function does.
      rpc: {
        complete_inspection_attempt: async ({ p_id }) => {
          const inspection = service.db.inspections.find((row) => row.id === p_id)
          const existing = inspection.status === "completed"
          const checklist = service.db.inspection_items.filter((row) => row.inspection_id === p_id)
          const failed = checklist.some((row) => row.is_deficient || (row.response_type === "pass_fail" && row.response === "fail"))
          Object.assign(inspection, { status: "completed", result: failed ? "fail" : "pass" })
          return { data: { inspectionId: p_id, result: inspection.result, existing, awaitingReview: false }, error: null }
        },
        // Corrective work, its link on the failed item and the photo are one transaction in SQL.
        raise_inspection_corrective_work: async ({ p_org, p_home, p_item, p_punch }) => {
          const item = service.db.inspection_items.find((row) => row.id === p_item)
          const inspection = service.db.inspections.find((row) => row.id === item?.inspection_id)
          if (!inspection || inspection.project_id !== p_home || p_org !== ORG) return { data: null, error: { message: "Inspection item belongs to another home or is unavailable" } }
          if (item.punch_item_id) return { data: null, error: { message: "This item already has a punch item" } }
          if (!p_punch.assigned_company_id && !p_punch.assigned_to) return { data: null, error: { message: "Choose the company or person responsible for this corrective work" } }
          const punch = { id: id(100 + service.db.punch_items.length), org_id: p_org, project_id: p_home, status: "open", verification_required: true, created_from_inspection: true, ...p_punch }
          service.db.punch_items.push(punch)
          item.punch_item_id = punch.id
          if (item.photo_file_id) service.db.file_links.push({ org_id: p_org, file_id: item.photo_file_id, entity_type: "punch_item", entity_id: punch.id, link_role: "before" })
          return { data: { punchItemId: punch.id, inspectionItemId: item.id }, error: null }
        },
      },
      tables: {
        projects: [{ id: PROJECT, org_id: ORG }],
        companies: [
          { id: COMPANY, org_id: ORG, name: "Framing Co" },
          { id: OTHER_COMPANY, org_id: ORG, name: "Drywall Co" },
        ],
        inspections: [
          { id: INSPECTION, org_id: ORG, project_id: PROJECT, inspection_number: 1, kind: "quality", title: "Framing", status: "in_progress", result: null, company_id: companyId, location: "Level 1", location_id: null, schedule_item_id: null, template_id: null, notes: null, inspector_name: null, metadata: {} },
        ],
        inspection_items: items ?? [
          { id: FAILED, org_id: ORG, inspection_id: INSPECTION, section: null, prompt: "Blocking at rail", response_type: "pass_fail", response: "fail", is_deficient: true, note: "Missing", photo_file_id: PHOTO, punch_item_id: null, observation_id: null, sort_order: 1,
            inspection: { id: INSPECTION, project_id: PROJECT, title: "Framing", location: "Level 1", location_id: null, kind: "quality" } },
          { id: PASSED, org_id: ORG, inspection_id: INSPECTION, section: null, prompt: "Anchor bolts", response_type: "pass_fail", response: "pass", is_deficient: false, note: null, photo_file_id: null, punch_item_id: null, observation_id: null, sort_order: 2 },
        ],
        punch_items: [],
        file_links: [],
      },
    })
    return service
  }

  test("recording a failure raises owned, evidence-gated corrective work for each failed item", async () => {
    const service = harness()

    const completed = await service.run(() => completeInspection(INSPECTION))

    assert.equal(completed.result, "fail")
    assert.equal(service.db.punch_items.length, 1)
    const [punch] = service.db.punch_items
    assert.equal(punch.assigned_company_id, COMPANY)
    assert.equal(punch.verification_required, true)
    assert.equal(punch.created_from_inspection, true)
    assert.equal(completed.items.find((item) => item.id === FAILED).punch_item_id, punch.id)
    assert.equal(completed.items.find((item) => item.id === PASSED).punch_item_id, null)
    assert.equal(service.db.file_links.length, 1, "the failure photo travels with the work")
    assert.equal(service.db.file_links[0].link_role, "before")
  })

  test("recording the same inspection again raises nothing twice", async () => {
    const service = harness()
    await service.run(() => completeInspection(INSPECTION))

    await service.run(() => completeInspection(INSPECTION))

    assert.equal(service.db.punch_items.length, 1)
  })

  test("a passing inspection raises no corrective work", async () => {
    const service = harness({ items: [{ id: PASSED, org_id: ORG, inspection_id: INSPECTION, section: null, prompt: "Anchor bolts", response_type: "pass_fail", response: "pass", is_deficient: false, note: null, photo_file_id: null, punch_item_id: null, sort_order: 1 }] })

    await service.run(() => completeInspection(INSPECTION))

    assert.deepEqual(service.db.punch_items, [])
  })

  test("without a responsible company the inspector owns the work", async () => {
    const service = harness({ companyId: null })

    await service.run(() => completeInspection(INSPECTION))

    assert.equal(service.db.punch_items[0].assigned_to, ACTOR)
    assert.equal(service.db.punch_items[0].assigned_company_id, null)
  })

  test("a manual request names the company, or falls back to the inspection's, and never leaves work unowned", async () => {
    const chosen = harness({ companyId: null })
    await chosen.run(() => createPunchItemFromInspectionItem(FAILED, { company_id: OTHER_COMPANY }))
    assert.equal(chosen.db.punch_items[0].assigned_company_id, OTHER_COMPANY)

    const inherited = harness()
    await inherited.run(() => createPunchItemFromInspectionItem(FAILED, {}))
    assert.equal(inherited.db.punch_items[0].assigned_company_id, COMPANY)

    const unowned = harness({ companyId: null })
    await assert.rejects(unowned.run(() => createPunchItemFromInspectionItem(FAILED, {})), /responsible/)
    assert.deepEqual(unowned.db.punch_items, [])
  })
})

describe("an inspection started from a schedule link", () => {
  const PROJECT = id(20)
  const OTHER_PROJECT = id(21)
  const SCHEDULED = id(22)
  const FOREIGN_SCHEDULED = id(23)

  function harness() {
    return createServiceHarness({
      permissions: ["project.read", "inspection.write"],
      rpc: { next_inspection_number: async () => ({ data: 1, error: null }) },
      tables: {
        projects: [{ id: PROJECT, org_id: ORG }, { id: OTHER_PROJECT, org_id: ORG }],
        schedule_items: [
          { id: SCHEDULED, org_id: ORG, project_id: PROJECT },
          { id: FOREIGN_SCHEDULED, org_id: ORG, project_id: OTHER_PROJECT },
        ],
        project_locations: [],
        inspections: [],
        inspection_items: [],
        app_users: [{ id: ACTOR, full_name: "Inspector" }],
      },
    })
  }

  test("a schedule item from another project is refused and nothing is created", async () => {
    const service = harness()

    await assert.rejects(
      service.run(() => createInspection({ project_id: PROJECT, kind: "quality", title: "Framing", schedule_item_id: FOREIGN_SCHEDULED })),
      /Scheduled item not found for this project/,
    )

    assert.deepEqual(service.db.inspections, [])
  })

  test("a schedule item of the project is linked to the new inspection", async () => {
    const service = harness()

    await service.run(() => createInspection({ project_id: PROJECT, kind: "quality", title: "Framing", schedule_item_id: SCHEDULED }))

    assert.equal(service.db.inspections[0].schedule_item_id, SCHEDULED)
    assert.equal(service.db.inspections[0].project_id, PROJECT)
  })

  test("a lifecycle request whose reviewed source is another home is refused before any write", async () => {
    const service = harness()
    const { inspectionReviewSource } = freshRequire("lib/inspections/lifecycle.ts")
    const source = inspectionReviewSource({ id: id(31), project_id: OTHER_PROJECT, title: "Framing", kind: "quality", template_id: null, location_id: null, company_id: null, schedule_item_id: null, notes: null, location: null, inspector_name: null, inspection_number: 1, metadata: {}, items: [] })
    const request = { key: id(30), request: { operation: "create", inspectionId: id(31), source } }

    await assert.rejects(service.run(() => mutateInspectionObligation(PROJECT, request)), /belongs to another home or attempt/)

    assert.deepEqual(service.writes(), [])
  })
})
