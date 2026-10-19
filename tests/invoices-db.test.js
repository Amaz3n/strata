"use strict"

/**
 * The invoice write transactions (`create_invoice_atomic`,
 * `update_invoice_atomic`, `revise_invoice_atomic`): a line's budget
 * allocation must belong to the invoice's own project, a bad line rolls back
 * the whole write, and a revision carries the allocation into its draft.
 * General (no-project) billing goes through the same three commands.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

let db
test.before(async () => {
  db = await createDatabase()
})
test.after(() => db.close())

/** An org with a budgeted project, and a second project whose budget it must not borrow. */
async function budgetedProject() {
  const { orgId, userId } = await seedMember(db)
  const lineOn = async (projectName) => {
    const project = await insert(db, "projects", { org_id: orgId, name: projectName })
    const budget = await insert(db, "budgets", { org_id: orgId, project_id: project.id })
    const line = await insert(db, "budget_lines", { org_id: orgId, budget_id: budget.id, description: "Foundations" })
    return { project, line }
  }
  const own = await lineOn("Lot 12")
  const other = await lineOn("Lot 13")
  const header = {
    project_id: own.project.id,
    invoice_number: `INV-${uuid().slice(-4)}`,
    title: "Progress",
    status: "draft",
    client_visible: false,
    total_cents: 10000,
    subtotal_cents: 10000,
    balance_due_cents: 10000,
  }
  const line = { budget_line_id: own.line.id, description: "Foundation progress", quantity: 1, unit_price_cents: 10000 }
  return { orgId, actor: userId, header, line, ownLine: own.line.id, otherLine: other.line.id }
}

const create = (home, lines, header = home.header) =>
  rpc(db, "create_invoice_atomic", { p_org_id: home.orgId, p_invoice: header, p_lines: lines })
const update = (home, invoiceId, lines, header = home.header) =>
  rpc(db, "update_invoice_atomic", { p_org_id: home.orgId, p_invoice_id: invoiceId, p_invoice: header, p_lines: lines })
const issue = (invoiceId) =>
  db.query("update invoices set status = 'sent', client_visible = true, sent_at = now() where id = $1", [invoiceId])
const revise = (home, invoiceId) =>
  rpc(db, "revise_invoice_atomic", {
    p_org_id: home.orgId,
    p_invoice_id: invoiceId,
    p_actor_id: home.actor,
    p_invoice_number: `REV-${uuid().slice(-4)}`,
  })
const linesOf = async (invoiceId) =>
  (await db.query("select * from invoice_lines where invoice_id = $1 order by id", [invoiceId])).rows

test("a line keeps its budget allocation through create, edit and revision", async () => {
  const home = await budgetedProject()
  const { invoice } = await create(home, [home.line])
  assert.equal((await linesOf(invoice.id))[0].budget_line_id, home.ownLine)

  await update(home, invoice.id, [{ ...home.line, description: "Updated progress" }])
  assert.equal((await linesOf(invoice.id))[0].budget_line_id, home.ownLine)

  await issue(invoice.id)
  const revised = await revise(home, invoice.id)
  assert.equal(revised.original.status, "void")
  assert.equal(revised.replacement.status, "draft")
  assert.equal((await linesOf(revised.replacement.id))[0].budget_line_id, home.ownLine)
  // The replacement is an ordinary editable draft.
  await update(home, revised.replacement.id, [{ ...home.line, description: "Revised progress" }], {
    ...home.header,
    invoice_number: revised.replacement.invoice_number,
  })
})

test("another project's budget line rolls back the whole create", async () => {
  const home = await budgetedProject()
  const count = async () => (await db.query("select count(*)::int from invoices where org_id = $1", [home.orgId])).rows[0].count

  await assert.rejects(create(home, [home.line, { ...home.line, budget_line_id: home.otherLine }]), /must belong to its project/)
  assert.equal(await count(), 0)
})

test("another project's budget line rolls back an edit, keeping the old lines", async () => {
  const home = await budgetedProject()
  const { invoice } = await create(home, [home.line])
  const before = await linesOf(invoice.id)

  await assert.rejects(update(home, invoice.id, [{ ...home.line, budget_line_id: home.otherLine }]), /must belong to its project/)
  assert.deepEqual(await linesOf(invoice.id), before)
})

test("a general invoice is created, edited and revised without a project, keeping its customer", async () => {
  const home = await budgetedProject()
  const customerId = uuid()
  const header = { ...home.header, project_id: null, invoice_number: "GENERAL-1", metadata: { customer_id: customerId } }
  const lines = [{ description: "Consultation", quantity: 1, unit_price_cents: 10000 }]

  const { invoice } = await create(home, lines, header)
  assert.equal(invoice.project_id, null)
  await update(home, invoice.id, lines, header)
  await issue(invoice.id)
  const { replacement } = await revise(home, invoice.id)

  assert.equal(replacement.project_id, null)
  assert.equal(replacement.metadata.customer_id, customerId)
  assert.equal(replacement.status, "draft")
})
