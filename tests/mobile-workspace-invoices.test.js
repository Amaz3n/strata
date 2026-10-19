const assert = require("node:assert/strict")
const { beforeEach, describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, recordingService, status } = require("./support/mobile")

const PROJECT = id(1)
const OTHER_PROJECT = id(2)
const INVOICE = id(3)
const LINE = id(4)
const ACCOUNT = id(5)

// The invoice service (its own suite) holding one manual draft.
const invoices = { draft: null, calls: [] }
stubModule(
  "lib/services/invoices.ts",
  recordingService(invoices.calls, {
    createInvoice: { id: INVOICE },
    getInvoiceWithLines: () => structuredClone(invoices.draft),
    updateInvoice: () => structuredClone(invoices.draft),
  }),
)

const { createMobileInvoiceDraft, updateMobileInvoiceDraft } = freshRequire("lib/mobile/workspace-invoices.ts")

const input = {
  project_id: PROJECT,
  invoice_number: "INV-1",
  title: "Progress billing",
  issue_date: "2026-10-01",
  due_date: "2026-10-31",
  tax_rate: 0,
  lines: [{ description: "Work", quantity: 2, unit: "hour", unit_cost: 125, taxable: false }],
}

function harness(permissions = ["project.read", "invoice.read", "invoice.write"]) {
  const service = createServiceHarness({
    permissions,
    tables: {
      projects: [PROJECT, OTHER_PROJECT].map((projectId) => ({
        id: projectId,
        org_id: ORG,
        name: "Lot 12",
        phase: "delivery",
        property_type: "residential",
        status: "active",
        created_at: "2026-10-01T00:00:00Z",
      })),
    },
  })
  const context = mobileContext(service)
  service.create = (value) => service.run(() => createMobileInvoiceDraft(context, value))
  service.update = (value) => service.run(() => updateMobileInvoiceDraft(context, INVOICE, value))
  return service
}

const writes = (name) => invoices.calls.filter(([called]) => called === name).map(([, args]) => args)

/** The manual draft the invoice service holds. */
function storedDraft(overrides = {}) {
  return {
    id: INVOICE,
    project_id: PROJECT,
    status: "draft",
    updated_at: "revision-a",
    source_type: "manual",
    lines: [{ id: LINE, description: "Work", quantity: 2, unit: "hour", unit_cost_cents: 12500, taxable: false, cost_code_id: ACCOUNT }],
    metadata: {
      customer_name: "Customer",
      accounting_customer_ref: { id: "qbo-customer", name: "Customer" },
      tax_jurisdiction_id: ACCOUNT,
      tax_jurisdiction: "Local tax",
    },
    totals: { discount_type: "percent", discount_value: 5 },
    ...overrides,
  }
}

beforeEach(() => {
  invoices.calls.length = 0
  invoices.draft = storedDraft()
})

describe("creating a draft", () => {
  test("a native draft is manual and unissued, and cannot carry billing sources or accounting links", async () => {
    await harness().create({
      ...input,
      issue: true,
      source_type: "from_costs",
      metadata: { injected: true },
      lines: [{ ...input.lines[0], billable_cost_ids: ["other-project-cost"], arc_books_gl_account_id: "untrusted" }],
    })

    const [created] = writes("createInvoice")
    assert.equal(created.input.issue, false)
    assert.equal(created.input.source_type, "manual")
    assert.equal(created.input.metadata, undefined)
    assert.equal(created.input.lines[0].billable_cost_ids, undefined)
    assert.equal(created.input.lines[0].arc_books_gl_account_id, undefined)
    assert.equal(created.context.userId, ACTOR)
    assert.equal(created.orgId, ORG)
  })

  test("without invoice.write, or with bad lines or dates, no draft is created", async () => {
    await assert.rejects(harness(["project.read", "invoice.read"]).create(input), status(403))
    const invalid = [
      { ...input, lines: [] },
      { ...input, due_date: "2026-09-01" },
      { ...input, lines: [{ ...input.lines[0], quantity: -1 }] },
      { ...input, lines: [{ ...input.lines[0], unit_cost: Infinity }] },
    ]
    for (const value of invalid) await assert.rejects(harness().create(value))
    assert.deepEqual(writes("createInvoice"), [])
  })
})

describe("revising a draft", () => {
  test("a revision keeps the server's accounting links, tax jurisdiction and discount", async () => {
    await harness().update({
      revision: "revision-a",
      input: { ...input, lines: [{ ...input.lines[0], id: LINE, unit_cost: 150, cost_code_id: "injected" }] },
    })

    const [update] = writes("updateInvoice")
    assert.equal(update.expectedUpdatedAt, "revision-a")
    assert.equal(update.input.issue, false)
    assert.equal(update.input.lines[0].cost_code_id, ACCOUNT)
    assert.equal(update.input.lines[0].unit_cost, 150)
    assert.equal(update.input.qbo_customer_id, "qbo-customer")
    assert.equal(update.input.tax_jurisdiction_id, ACCOUNT)
    assert.equal(update.input.discount_value, 5)
  })

  test("a stale, foreign-project, issued, source-controlled or client-visible invoice cannot be revised", async () => {
    const changes = [
      { updated_at: "revision-new" },
      { project_id: OTHER_PROJECT },
      { status: "sent" },
      { source_type: "from_costs" },
      { client_visible: true },
    ]
    for (const change of changes) {
      invoices.draft = storedDraft(change)
      await assert.rejects(harness().update({ revision: "revision-a", input }), undefined, JSON.stringify(change))
    }
    assert.deepEqual(writes("updateInvoice"), [])
  })

  test("draft lines cannot borrow another invoice's line or repeat one", async () => {
    const lines = [
      [{ ...input.lines[0], id: PROJECT }],
      [
        { ...input.lines[0], id: LINE },
        { ...input.lines[0], id: LINE },
      ],
    ]
    for (const value of lines) {
      await assert.rejects(harness().update({ revision: "revision-a", input: { ...input, lines: value } }), status(422))
    }
    assert.deepEqual(writes("updateInvoice"), [])
  })
})

