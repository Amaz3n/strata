"use strict"

/**
 * The pay application transactions: posting (`post_pay_application`),
 * certifying (`certify_pay_application_atomic`) and returning
 * (`return_pay_application_atomic`). Each one moves the schedule-of-values
 * rollups, the application and its invoice together or not at all.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createDatabase, insert, rpc, seedMember } = require("./support/pglite")

let db
test.before(async () => {
  db = await createDatabase()
  // A switchable fault, so a test can make one invoice write fail inside a
  // transaction and prove everything before it rolled back.
  await db.exec(`
    create function test_fail_invoice_status() returns trigger language plpgsql as $$
    begin
      if new.status is distinct from old.status and new.status = current_setting('test.fail_invoice_status', true) then
        raise exception 'Injected invoice failure';
      end if;
      return new;
    end $$;
    create trigger test_fail_invoice_status before update on invoices
      for each row execute function test_fail_invoice_status();
  `)
})
test.after(() => db.close())

async function failInvoiceUpdatesTo(status, work) {
  await db.query("select set_config('test.fail_invoice_status', $1, false)", [status])
  try {
    return await work()
  } finally {
    await db.query("select set_config('test.fail_invoice_status', '', false)")
  }
}

const one = async (sql, params) => (await db.query(sql, params)).rows[0]
const PREVIOUS_STORED = (cents) => ({ previous_stored_materials_cents: cents })

/** An org with a $1,000 contract of one SOV line. */
async function contract() {
  const { orgId, userId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Tower" })
  const row = await insert(db, "contracts", { org_id: orgId, project_id: project.id, title: "Prime" })
  const sov = await insert(db, "prime_sov_lines", {
    org_id: orgId,
    project_id: project.id,
    contract_id: row.id,
    line_number: 1,
    description: "Foundations",
    scheduled_value_cents: 100000,
  })
  return { orgId, actor: userId, project, contract: row, sov }
}

/** A draft application billing $100 of work ($90 due after 10% retainage) and its draft invoice. */
async function draft(home, number, { previous = 0, work = 10000, status = "draft", due = 0 } = {}) {
  const application = await insert(db, "pay_applications", {
    org_id: home.orgId,
    project_id: home.project.id,
    contract_id: home.contract.id,
    application_number: number,
    period_end: "2026-09-30",
    status,
    current_payment_due_cents: due,
  })
  const line = await insert(db, "pay_application_lines", {
    org_id: home.orgId,
    pay_application_id: application.id,
    prime_sov_line_id: home.sov.id,
    scheduled_value_cents: 100000,
    previous_billed_cents: previous,
    this_period_cents: work,
    stored_materials_cents: 0,
    percent_complete: 10,
    balance_to_finish_cents: 90000,
    retainage_cents: 1000,
    metadata: PREVIOUS_STORED(0),
  })
  const invoice = await insert(db, "invoices", {
    org_id: home.orgId,
    project_id: home.project.id,
    source_pay_application_id: application.id,
    status: "draft",
    total_cents: 9000,
    token: `token-${application.id}`,
  })
  await insert(db, "invoice_lines", {
    org_id: home.orgId,
    invoice_id: invoice.id,
    description: "Foundations",
    quantity: 1,
    unit: "sov",
    unit_price_cents: 9000,
  })
  if (status !== "draft") {
    await db.query("update pay_applications set invoice_id = $1 where id = $2", [invoice.id, application.id])
  }
  return { ...home, application, line, invoice }
}

async function post(item) {
  const { rows } = await db.query("select to_jsonb(l) as line from pay_application_lines l where pay_application_id = $1", [
    item.application.id,
  ])
  return rpc(db, "post_pay_application", {
    p_org_id: item.orgId,
    p_pay_application_id: item.application.id,
    p_invoice_id: item.invoice.id,
    p_summary: {
      expected_lines: rows.map((row) => row.line),
      original_contract_sum_cents: 100000,
      change_order_sum_cents: 0,
      contract_sum_to_date_cents: 100000,
      total_completed_stored_cents: 10000,
      retainage_cents: 1000,
      total_earned_less_retainage_cents: 9000,
      previous_certificates_cents: 0,
      current_payment_due_cents: 9000,
      balance_to_finish_cents: 91000,
      metadata: { report_snapshot: { projectName: "Frozen project", revision: 0 } },
    },
  })
}

const certificate = (overrides = {}) => ({
  requested_amount_cents: 9000,
  deferred_amount_cents: 0,
  deferrals: [],
  certified_amount_cents: 9000,
  signer_name: "Owner",
  certified_at: "2026-09-05T00:00:00Z",
  ...overrides,
})

const certify = (item, cert = certificate()) =>
  rpc(db, "certify_pay_application_atomic", {
    p_org_id: item.orgId,
    p_pay_application_id: item.application.id,
    p_actor_id: item.actor,
    p_certification: cert,
    p_recipients: ["owner@example.test"],
    p_revision: 0,
  })

const returnApplication = (item) =>
  rpc(db, "return_pay_application_atomic", {
    p_org_id: item.orgId,
    p_pay_application_id: item.application.id,
    p_actor_id: item.actor,
    p_return: { reason: "Revise quantities", revision: 0 },
    p_revision: 0,
  })

const statusOf = async (item) => (await one("select status from pay_applications where id = $1", [item.application.id])).status
const billedToDate = async (item) =>
  Number((await one("select previous_billed_cents from prime_sov_lines where id = $1", [item.sov.id])).previous_billed_cents)
const certificationJobs = async (item) =>
  (await one("select count(*)::int as n from outbox where org_id = $1 and job_type = 'finish_pay_application_certification'", [item.orgId])).n

test("posting is refused when the schedule of values moved under the draft", async () => {
  const item = await draft(await contract(), 1)
  await db.query("update prime_sov_lines set previous_billed_cents = 1 where id = $1", [item.sov.id])

  await assert.rejects(post(item), /Schedule of values changed/)
  assert.equal(await statusOf(item), "draft")
  assert.equal(await billedToDate(item), 1)
})

test("posting rolls the period into the schedule of values", async () => {
  const item = await draft(await contract(), 1)
  await post(item)
  assert.equal(await statusOf(item), "invoiced")
  assert.equal(await billedToDate(item), 10000)
})

test("a failed invoice issue rolls the certificate back and queues nothing", async () => {
  const item = await draft(await contract(), 1)
  await post(item)

  await assert.rejects(failInvoiceUpdatesTo("sent", () => certify(item)), /Injected invoice failure/)
  assert.equal(await statusOf(item), "invoiced")
  assert.equal((await one("select status from invoices where id = $1", [item.invoice.id])).status, "draft")
  assert.equal(await certificationJobs(item), 0)
})

test("certifying issues the invoice, records the certificate and queues one delivery, idempotently", async () => {
  const item = await draft(await contract(), 1)
  await post(item)
  await certify(item)
  await certify(item)

  const application = await one("select * from pay_applications where id = $1", [item.application.id])
  const invoice = await one("select * from invoices where id = $1", [item.invoice.id])
  assert.equal(application.status, "approved")
  assert.equal(application.metadata.certification_recorded_by, item.actor)
  assert.equal(invoice.status, "sent")
  assert.equal(invoice.token, item.invoice.token)
  assert.equal(invoice.issued_snapshot.totals.total_cents, 9000)
  assert.equal(await certificationJobs(item), 1)
})

test("a partial certificate issues only the certified amount and records each deferral as a line", async () => {
  const item = await draft(await contract(), 1, { status: "invoiced", due: 9000 })
  await certify(
    item,
    certificate({
      deferred_amount_cents: 2500,
      certified_amount_cents: 6500,
      deferrals: [{ prime_sov_line_id: item.sov.id, deferred_cents: 2500, reason: "Awaiting inspection" }],
    }),
  )

  const invoice = await one("select * from invoices where id = $1", [item.invoice.id])
  assert.equal(Number(invoice.total_cents), 6500)
  assert.equal(Number(invoice.balance_due_cents), 6500)
  assert.equal(invoice.issued_snapshot.totals.total_cents, 6500)
  assert.equal(invoice.issued_snapshot.lines.length, 2)
  const deferral = await one("select unit_price_cents from invoice_lines where invoice_id = $1 and unit = 'deferral'", [
    item.invoice.id,
  ])
  assert.equal(Number(deferral.unit_price_cents), -2500)
})

test("a certificate that does not reconcile to the request is refused", async () => {
  const item = await draft(await contract(), 1, { status: "invoiced", due: 9000 })
  for (const cert of [
    certificate({ certified_amount_cents: 9500 }),
    certificate({ deferred_amount_cents: 1000, certified_amount_cents: 8000 }),
    certificate({
      deferred_amount_cents: 1000,
      certified_amount_cents: 8000,
      deferrals: [{ prime_sov_line_id: item.sov.id, deferred_cents: 1000, reason: "" }],
    }),
  ]) {
    await assert.rejects(certify(item, cert), /reconcile|deferral/i)
  }
  assert.equal(await statusOf(item), "invoiced")
})

test("returning an application keeps its number, voids its invoice and rebases the later draft", async () => {
  const first = await draft(await contract(), 1)
  await post(first)
  await certify(first)
  const second = await draft(first, 2, { previous: 10000, work: 5000 })

  // A failed invoice void undoes the whole return.
  await assert.rejects(failInvoiceUpdatesTo("void", () => returnApplication(first)), /Injected invoice failure/)
  assert.equal(await billedToDate(first), 10000)
  assert.equal(await statusOf(first), "approved")

  await returnApplication(first)

  const returned = await one("select * from pay_applications where id = $1", [first.application.id])
  assert.equal(returned.status, "draft")
  assert.equal(returned.application_number, 1)
  assert.equal(returned.metadata.revision, 1)
  assert.equal(returned.invoice_id, null)
  assert.equal(returned.metadata.revision_history[0].report_snapshot.projectName, "Frozen project")
  assert.equal((await one("select status from invoices where id = $1", [first.invoice.id])).status, "void")
  assert.equal(await billedToDate(first), 0)

  const later = await one("select * from pay_application_lines where id = $1", [second.line.id])
  assert.equal(Number(later.previous_billed_cents), 0)
  assert.equal(Number(later.this_period_cents), 5000, "the later period's own work is kept")
  await assert.rejects(post(second), /earlier returned application/)
  await assert.rejects(certify(first), /revision changed/)
})

test("browser roles cannot call the pay application transactions", async () => {
  const { rows } = await db.query(
    `select signature,
            has_function_privilege('authenticated', signature, 'execute') as authenticated,
            has_function_privilege('anon', signature, 'execute') as anon
     from unnest($1::text[]) as signature`,
    [
      [
        "public.post_pay_application(uuid,uuid,uuid,jsonb)",
        "public.certify_pay_application_atomic(uuid,uuid,uuid,jsonb,text[],integer)",
        "public.return_pay_application_atomic(uuid,uuid,uuid,jsonb,integer)",
      ],
    ],
  )
  for (const row of rows) assert.deepEqual([row.anon, row.authenticated], [false, false], row.signature)
})
