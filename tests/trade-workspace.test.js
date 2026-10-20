require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

// Creating the project and the schedule item belong to their own services and
// suites; here they only record what the trade workspace asked for.
let created = []
stubModule("@/lib/services/projects", {
  ...require("@/lib/services/projects"),
  createProject: async ({ input }) => {
    created.push(input)
    return { id: JOB }
  },
})
stubModule("@/lib/services/schedule", {
  ...require("@/lib/services/schedule"),
  createScheduleItem: async ({ input }) => {
    created.push(input)
    return input
  },
})

const { createTradeJob, getTradeWorkspace, scheduleTradeWork } = freshRequire("lib/services/trade-workspace.ts")

const FOREIGN_ORG = id(1)
const JOB = id(2)
const CUSTOMER = id(3)
const CREW = id(4)
const HIDDEN_JOB = id(5)
const FOREIGN_JOB = id(6)

const TRADE_SETTINGS = { org_id: ORG, settings: { business_profile: { kind: "trade", specialty: "Electrical" } } }

function job(jobId, orgId = ORG) {
  return {
    id: jobId,
    org_id: orgId,
    name: "Electrical",
    status: "active",
    phase: "delivery",
    description: null,
    start_date: null,
    end_date: null,
  }
}

/** A trade company; `projects` restricts the actor to assigned jobs. */
function tradeCompany({ permissions, projects, tables = {} }) {
  created = []
  const service = createServiceHarness({
    permissions,
    projects,
    tables: {
      org_settings: [TRADE_SETTINGS],
      projects: [job(JOB), job(HIDDEN_JOB), job(FOREIGN_JOB, FOREIGN_ORG)],
      contacts: [{ id: CUSTOMER, org_id: ORG, full_name: "Customer", email: null }],
      ...tables,
    },
  })
  // Memberships embed their user, and project memberships their project, the
  // way PostgREST joins them.
  service.db.memberships[0].user = { full_name: "Crew lead", email: "crew@example.test" }
  for (const member of service.db.project_members) member.project = { id: member.project_id, phase: "delivery" }
  return service
}

test("a trade job needs project.manage and a customer from the company's own directory", async () => {
  const input = {
    name: "Pilot electrical",
    client_id: CUSTOMER,
    total_contract_value_cents: 1250050,
    property_type: "commercial",
  }
  const viewer = tradeCompany({ permissions: ["org.member"] })
  await assert.rejects(viewer.run(() => createTradeJob(input)), /project\.manage/)

  const foreign = tradeCompany({ permissions: ["project.manage"] })
  foreign.db.contacts[0].org_id = FOREIGN_ORG
  await assert.rejects(foreign.run(() => createTradeJob(input)), /directory/)
  assert.deepEqual(created, [])

  const manager = tradeCompany({ permissions: ["project.manage"] })
  assert.deepEqual(await manager.run(() => createTradeJob(input)), { id: JOB })
  assert.equal(created[0].open_book, false, "trade costing stays private")
  assert.equal(created[0].total_contract_value_cents, 1250050)
  assert.equal(created[0].property_type, "commercial")
  assert.equal(created[0].fixed_price_billing_basis, "draws", "a homeowner job bills fixed invoices by default")
  assert.equal(created[0].retainage_percent, 0)
})

test("a trade job's answers set how its customer is billed", async () => {
  const manager = tradeCompany({ permissions: ["project.manage"] })
  await manager.run(() => createTradeJob({
    name: "Oak Street rough-in",
    property_type: "residential",
    customer_kind: "company",
    billing_basis: "progress",
    retainage_percent: 10,
    payment_terms_days: 45,
    review_before_send: true,
    customer_certifies: true,
  }))
  assert.equal(created[0].billing_model, "fixed_price")
  assert.equal(created[0].contract_type, "fixed")
  assert.equal(created[0].fixed_price_billing_basis, "progress")
  assert.equal(created[0].retainage_percent, 10)
  assert.deepEqual(created[0].receivables_terms, {
    customerKind: "company", paymentTermsDays: 45, reviewBeforeSend: true, customerCertifies: true,
  })

  await manager.run(() => createTradeJob({
    name: "Service call",
    billing_basis: "time_and_materials",
    customer_certifies: true,
  }))
  assert.equal(created[1].billing_model, "time_and_materials")
  assert.equal(created[1].contract_type, "time_materials")
  assert.equal(created[1].receivables_terms.customerCertifies, false, "only a pay application is certified")

  await assert.rejects(manager.run(() => createTradeJob({ name: "Bad terms", payment_terms_days: -1 })))
  await assert.rejects(manager.run(() => createTradeJob({ name: "Bad retainage", retainage_percent: 80 })))
})

test("work is scheduled only on the company's own job, for an active crew member, with schedule.edit", async () => {
  const work = {
    project_id: JOB,
    name: "Rough-in",
    assigned_to: CREW,
    start_date: "2026-10-02",
    end_date: "2026-10-03",
    planned_hours: 16,
  }
  const crew = (status) => ({ id: id(20), org_id: ORG, user_id: CREW, status })

  const noScheduleEdit = tradeCompany({ permissions: ["schedule.read", "project.read"] })
  await assert.rejects(noScheduleEdit.run(() => scheduleTradeWork(work)), /schedule\.edit/)

  const foreignJob = tradeCompany({ permissions: ["schedule.edit", "project.read"] })
  await assert.rejects(foreignJob.run(() => scheduleTradeWork({ ...work, project_id: FOREIGN_JOB })))

  const suspendedCrew = tradeCompany({ permissions: ["schedule.edit", "project.read"] })
  suspendedCrew.db.memberships.push(crew("suspended"))
  await assert.rejects(suspendedCrew.run(() => scheduleTradeWork(work)), /active member/)
  assert.deepEqual(created, [])

  const scheduler = tradeCompany({ permissions: ["schedule.edit", "project.read"] })
  scheduler.db.memberships.push(crew("active"))
  await scheduler.run(() => scheduleTradeWork(work))
  assert.equal(created[0].trade, "electrical")
  assert.equal(created[0].planned_hours, 16)
})

test("the workspace shows only jobs, work and open invoices the member can see", async () => {
  const workItem = (itemId, projectId, orgId = ORG) => ({
    id: itemId,
    org_id: orgId,
    project_id: projectId,
    name: "Rough-in",
    status: "planned",
    start_date: null,
    end_date: null,
    assigned_to: null,
    planned_hours: null,
  })
  const invoice = (invoiceId, overrides = {}) => ({
    id: invoiceId,
    org_id: ORG,
    project_id: JOB,
    invoice_number: "INV-1",
    status: "sent",
    due_date: null,
    balance_due_cents: 1000,
    currency: "USD",
    ...overrides,
  })
  const tables = {
    schedule_items: [workItem("work", JOB), workItem("foreign-work", JOB, FOREIGN_ORG), workItem("hidden-work", HIDDEN_JOB)],
    invoices: [
      invoice("invoice"),
      invoice("foreign-invoice", { org_id: FOREIGN_ORG }),
      invoice("hidden-invoice", { project_id: HIDDEN_JOB }),
      invoice("draft", { status: "draft" }),
    ],
  }
  const service = tradeCompany({
    permissions: ["schedule.read", "invoice.read", "directory.read", "project.read"],
    projects: [JOB],
    tables,
  })
  const workspace = await service.run(() => getTradeWorkspace())
  assert.deepEqual(workspace.jobs.map((entry) => entry.id), [JOB])
  assert.deepEqual(workspace.work.map((entry) => entry.id), ["work"])
  assert.deepEqual(workspace.invoices.map((entry) => entry.id), ["invoice"])
})

test("office data the member may not see is never read", async () => {
  const restricted = tradeCompany({ permissions: ["project.read"], projects: [JOB] })
  const workspace = await restricted.run(() => getTradeWorkspace())
  assert.deepEqual([workspace.work, workspace.invoices, workspace.contacts, workspace.members], [[], [], [], []])
  for (const table of ["invoices", "contacts", "schedule_items"]) {
    assert.deepEqual(restricted.reads(table), [], table)
  }

  const unassigned = tradeCompany({ permissions: ["project.read"], projects: [] })
  assert.deepEqual((await unassigned.run(() => getTradeWorkspace())).jobs, [])
  assert.deepEqual(unassigned.reads("projects"), [])
})
