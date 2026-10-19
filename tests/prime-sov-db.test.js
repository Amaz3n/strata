"use strict"

/**
 * The database contract behind `lib/services/prime-sov.ts`: the owner schedule
 * of values is saved by ONE transaction (`save_prime_sov_lines`) guarded by the
 * contract's `sov_revision`, and links to budget lines are evidence that never
 * changes a contractual scheduled value.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember, uuid } = require("./support/pglite")

/** A contract with two saved lines: Foundations $100 and Structure $200. */
async function contractWithLines(t) {
  const db = await createDatabase(t)
  const { orgId, userId } = await seedMember(db, { role: "pm" })
  const project = await insert(db, "projects", { org_id: orgId, name: "Tower" })
  const contract = await insert(db, "contracts", { org_id: orgId, project_id: project.id, title: "Prime" })
  const home = { db, orgId, userId, project, contract }
  await save(home, await revision(home), [
    { description: "Foundations", scheduled_value_cents: 10000 },
    { description: "Structure", scheduled_value_cents: 20000 },
  ])
  const [first, second] = await lines(home)
  return { ...home, first: editable(first), second: editable(second) }
}

/** The payload an editor sends back for a stored line. */
function editable(row) {
  return { id: row.id, description: row.description, scheduled_value_cents: Number(row.scheduled_value_cents) }
}

function save({ db, orgId, project, contract }, expectedRevision, rows, caller) {
  return rpc(
    db,
    "save_prime_sov_lines",
    {
      p_org_id: orgId,
      p_project_id: project.id,
      p_contract_id: contract.id,
      p_expected_revision: expectedRevision,
      p_lines: JSON.stringify(rows),
    },
    caller,
  )
}

async function revision({ db, contract }) {
  const { rows } = await db.query("select sov_revision from contracts where id = $1", [contract.id])
  return Number(rows[0].sov_revision)
}

async function lines({ db, contract }) {
  const { rows } = await db.query("select * from prime_sov_lines where contract_id = $1 order by line_number", [
    contract.id,
  ])
  return rows
}

async function links({ db }, lineId) {
  const { rows } = await db.query("select budget_line_id from prime_sov_budget_links where prime_sov_line_id = $1", [
    lineId,
  ])
  return rows.map((row) => row.budget_line_id).sort()
}

async function budgetLines({ db, orgId, project }, count) {
  const budget = await insert(db, "budgets", { org_id: orgId, project_id: project.id })
  const ids = []
  for (let i = 0; i < count; i += 1) {
    ids.push((await insert(db, "budget_lines", { org_id: orgId, budget_id: budget.id, description: `Cost ${i}` })).id)
  }
  return ids
}

test("a save reorders lines and advances the revision", async (t) => {
  const home = await contractWithLines(t)
  const before = await revision(home)

  await save(home, before, [home.second, home.first])

  assert.deepEqual(
    (await lines(home)).map((row) => [row.line_number, row.description]),
    [
      [1, "Structure"],
      [2, "Foundations"],
    ],
  )
  assert.ok((await revision(home)) > before)
})

test("a stale editor, a foreign line id or a later bad row changes nothing", async (t) => {
  const home = await contractWithLines(t)
  const current = await revision(home)
  const cases = [
    { name: "stale revision", expected: current - 1, rows: [home.first, home.second], error: /changed/ },
    {
      name: "id the contract does not own",
      expected: current,
      rows: [{ id: uuid(), description: "Injected", scheduled_value_cents: 1 }, home.first, home.second],
      error: /does not belong/,
    },
    {
      name: "a later row violates a constraint",
      expected: current,
      rows: [
        { ...home.first, description: "Changed" },
        { ...home.second, retainage_percent_override: 101 },
      ],
      error: /check constraint/,
    },
  ]
  for (const { name, expected, rows, error } of cases) {
    await assert.rejects(save(home, expected, rows), error, name)
    assert.deepEqual(
      (await lines(home)).map((row) => [row.line_number, row.description, Number(row.scheduled_value_cents)]),
      [
        [1, "Foundations", 10000],
        [2, "Structure", 20000],
      ],
      name,
    )
    assert.equal(await revision(home), current, name)
  }
})

test("budget links are kept, replaced and cleared without changing the scheduled value", async (t) => {
  const home = await contractWithLines(t)
  const [a, b] = await budgetLines(home, 2)

  await save(home, await revision(home), [{ ...home.first, budget_line_ids: [a, b, a] }, home.second])
  assert.deepEqual(await links(home, home.first.id), [a, b].sort())

  // A save that does not mention links keeps them.
  await save(home, await revision(home), [home.first, home.second])
  assert.deepEqual(await links(home, home.first.id), [a, b].sort())
  assert.equal(Number((await lines(home))[0].scheduled_value_cents), 10000)

  await save(home, await revision(home), [{ ...home.first, budget_line_ids: [] }, home.second])
  assert.deepEqual(await links(home, home.first.id), [])
})

test("a budget line from outside the project is refused", async (t) => {
  const home = await contractWithLines(t)
  const [a] = await budgetLines(home, 1)
  const before = await revision(home)

  for (const row of [
    { ...home.first, budget_line_ids: [a, uuid()] },
    { ...home.first, budget_line_id: uuid() },
  ]) {
    await assert.rejects(save(home, before, [row, home.second]), /Budget line does not belong/)
  }
  assert.equal(await revision(home), before)
})

test("an open pay application freezes the schedule", async (t) => {
  const home = await contractWithLines(t)
  await insert(home.db, "pay_applications", {
    org_id: home.orgId,
    project_id: home.project.id,
    contract_id: home.contract.id,
    application_number: 1,
    period_end: "2026-09-30",
    status: "draft",
  })

  await assert.rejects(save(home, await revision(home), [home.first, home.second]), /open pay application/)
})

test("a line an application has billed cannot be removed or have its value changed", async (t) => {
  const home = await contractWithLines(t)
  const application = await insert(home.db, "pay_applications", {
    org_id: home.orgId,
    project_id: home.project.id,
    contract_id: home.contract.id,
    application_number: 1,
    period_end: "2026-09-30",
    status: "approved",
  })
  await insert(home.db, "pay_application_lines", {
    org_id: home.orgId,
    pay_application_id: application.id,
    prime_sov_line_id: home.first.id,
    scheduled_value_cents: 10000,
    previous_billed_cents: 0,
    balance_to_finish_cents: 10000,
  })
  await assert.rejects(save(home, await revision(home), [home.second]), /references a removed line/)

  await home.db.query("update prime_sov_lines set previous_billed_cents = 5000 where id = $1", [home.first.id])
  await assert.rejects(
    save(home, await revision(home), [{ ...home.first, scheduled_value_cents: 12000 }, home.second]),
    /only change through a change order/,
  )
})

test("only members with sov.write can save", async (t) => {
  const home = await contractWithLines(t)
  const viewer = await seedMember(home.db, { orgId: home.orgId, role: "org_viewer" })
  const before = await revision(home)

  await save(home, before, [home.second, home.first], { role: "authenticated", userId: home.userId })
  await assert.rejects(
    save(home, await revision(home), [home.first, home.second], { role: "authenticated", userId: viewer.userId }),
    /Insufficient permission/,
  )
  await assert.rejects(save(home, await revision(home), [home.first, home.second], { role: "anon" }), /permission denied/)
})
