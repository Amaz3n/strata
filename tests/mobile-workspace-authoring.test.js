const assert = require("node:assert/strict")
const { beforeEach, describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, recordingService, status } = require("./support/mobile")

// The document services the native composer hands off to (their own suites).
const created = []
const answer = () => ({ id: id(500) })
stubModule("lib/services/transmittals.ts", recordingService(created, { createTransmittal: answer }))
stubModule("lib/services/change-orders.ts", recordingService(created, { createChangeOrder: answer }))
stubModule("lib/services/commitments.ts", recordingService(created, { createCommitment: answer }))
stubModule("lib/services/bids.ts", recordingService(created, { createBidPackage: answer }))

const { createWorkspaceDocument, parseWorkspaceRows } = freshRequire("lib/mobile/workspace-authoring.ts")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const FILE = id(10)
const COMPANY = id(20)

function harness({ permissions = ["project.read", "docs.read"], files } = {}) {
  const service = createServiceHarness({
    permissions,
    tables: {
      projects: [
        { id: PROJECT, org_id: ORG },
        { id: OTHER_PROJECT, org_id: ORG },
      ],
      files: files ?? [{ id: FILE, org_id: ORG, project_id: PROJECT, archived_at: null }],
      project_vendors: [{ org_id: ORG, project_id: PROJECT, company_id: COMPANY, company: { name: "Framing Co" } }],
    },
  })
  const context = mobileContext(service)
  service.create = (moduleId, input, projectId = PROJECT) =>
    service.run(() => createWorkspaceDocument(context, moduleId, projectId, input))
  return service
}

beforeEach(() => {
  created.length = 0
})

const createdInput = () => created[0][1]

describe("transmittals", () => {
  const transmittal = {
    subject: "Plans for review",
    purpose: "for_review",
    items: JSON.stringify([{ description: "Plans", copies: "2", file_id: FILE, entity_id: PROJECT }]),
    recipients: JSON.stringify([{ display_name: "Test Recipient", email: "test@example.com" }]),
  }

  test("an enclosure from this project is sent; client-chosen links and workflow state are dropped", async () => {
    const service = harness()

    await service.create("transmittals", { ...transmittal, status: "sent", sent_at: "now" })

    const input = createdInput()
    assert.equal(input.project_id, PROJECT)
    assert.equal(input.items[0].copies, 2)
    assert.equal(input.items[0].file_id, FILE)
    assert.equal(input.items[0].entity_id, undefined)
    assert.equal(input.sent_at, undefined)
    assert.equal(created[0][2], ORG)
  })

  test("an enclosure from another project, archived, or unreadable is refused", async () => {
    const cases = [
      { files: [{ id: FILE, org_id: ORG, project_id: OTHER_PROJECT, archived_at: null }], refusal: 422 },
      { files: [{ id: FILE, org_id: ORG, project_id: PROJECT, archived_at: "2026-10-01T00:00:00Z" }], refusal: 422 },
      { files: [{ id: FILE, org_id: id(99), project_id: PROJECT, archived_at: null }], refusal: 422 },
      { permissions: ["project.read"], refusal: 403 },
    ]
    for (const { refusal, ...options } of cases) {
      const service = harness(options)
      await assert.rejects(service.create("transmittals", transmittal), status(refusal), JSON.stringify(options))
    }
    assert.deepEqual(created, [])
  })

  test("an invalid recipient is refused", async () => {
    const recipients = JSON.stringify([{ email: "invalid", display_name: "Name" }])
    await assert.rejects(harness().create("transmittals", { ...transmittal, recipients }))
    assert.deepEqual(created, [])
  })
})

test("a change order is always a private draft without source links or internal costs", async () => {
  await harness().create("change-orders", {
    title: "Scope change",
    summary: "Additional work",
    status: "approved",
    client_visible: true,
    lines: JSON.stringify([
      { description: "Site visit", quantity: "2", unit_cost: "125.50", budget_line_id: FILE, internal_cost_cents: "1" },
    ]),
  })

  const { input } = createdInput()
  assert.equal(input.status, "draft")
  assert.equal(input.lifecycle, "draft")
  assert.equal(input.client_visible, false)
  assert.equal(input.lines[0].unit_cost, 125.5)
  assert.equal(input.lines[0].budget_line_id, undefined)
  assert.equal(input.lines[0].internal_cost_cents, undefined)
})

describe("commitments", () => {
  const commitment = {
    title: "Trade contract",
    company_id: COMPANY,
    total: "125.25",
    status: "approved",
    start_date: "2026-10-01",
    end_date: "2026-10-31",
  }

  test("a commitment is a draft priced in cents", async () => {
    await harness().create("commitments", commitment)

    assert.equal(createdInput().input.total_cents, 12525)
    assert.equal(createdInput().input.status, "draft")
  })

  test("a company not on the project, reversed dates or a non-number total are refused", async () => {
    for (const invalid of [{ company_id: FILE }, { end_date: "2026-09-01" }, { total: "NaN" }]) {
      await assert.rejects(harness().create("commitments", { ...commitment, ...invalid }), undefined, JSON.stringify(invalid))
    }
    assert.deepEqual(created, [])
  })
})

test("no document is created without a project", async () => {
  for (const moduleId of ["bids", "commitments", "transmittals", "change-orders"]) {
    await assert.rejects(harness().create(moduleId, {}, null), status(422), moduleId)
  }
  assert.deepEqual(created, [])
})

test("repeated form rows must be a bounded, non-empty JSON list of strings", () => {
  const tooMany = JSON.stringify(Array(101).fill({ description: "x" }))
  for (const value of ["{", "[]", '[{"quantity":2}]', tooMany, " ".repeat(10001)]) {
    assert.throws(() => parseWorkspaceRows(value), undefined, value.slice(0, 20))
  }
  assert.deepEqual(parseWorkspaceRows('[{"description":"Plans"}]'), [{ description: "Plans" }])
})
